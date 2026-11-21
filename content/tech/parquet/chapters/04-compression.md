# Compression Codecs and Selection

Parquet separates value encoding from compression. The writer first represents values using a Parquet encoding such as dictionary, delta or plain; it then compresses page data using the codec recorded for that column chunk. The reader needs both pieces of information to reconstruct values. Codec choice affects storage footprint and CPU cost, but it does not determine schema, ordering or transaction behavior.

## Codecs in practice

### Snappy

Snappy is a fast general-purpose compression codec commonly chosen for a balance between compression and decompression cost. It is often available across data platforms and is a safe interoperability choice when all readers support it. “Fast” does not mean universally best: an object-store-bound workload may prefer a stronger ratio, while a CPU-bound workload may prefer less decompression work. Measure with representative data and queries.

### Zstandard (Zstd)

Zstandard offers tunable compression levels and often achieves a stronger size reduction than very fast codecs, with decompression performance that is practical for analytical systems. Higher compression levels use more writer CPU and can take longer; level, data distribution and implementation matter. The Parquet codec name is `ZSTD`. Readers must support the codec version and deployment build in use. A single writer-side choice should not be assumed compatible with every legacy downstream engine.

### Gzip

Gzip is widely understood and can compress well, but its higher CPU cost can be a poor trade for frequent scans. A crucial distinction: Parquet pages compressed with the `GZIP` codec are described and handled at page/chunk level. This is not the same as wrapping an entire Parquet file in a `.gz` stream. An externally gzip-wrapped file generally prevents normal Parquet random access to the footer and column chunks unless the entire stream is decompressed first. Avoid confusing whole-file gzip with Parquet's internal codec.

### LZ4

LZ4 is designed for very fast compression and decompression, often trading compression ratio for throughput. Parquet implementations have used specific LZ4 variants and compatibility conventions, so validate interoperability across all readers before distributing such files. The existence of an LZ4 option in a writer does not establish that every query service accepts every historical variant.

## How to choose

Start with a supported codec matrix for every writer and reader, including managed services and downstream tools. Then benchmark actual data, not a synthetic repeated string column. Record compressed bytes, write throughput, scan throughput, CPU utilisation, remote bytes and end-to-end query latency. Keep the row-group and file layout the same during comparison, otherwise the experiment changes more than one variable.

| Prioritise | Consider | Check |
|---|---|---|
| Broad compatibility and low CPU overhead | Snappy | Availability in all consuming engines |
| Lower storage/transfer volume | Zstd | Writer CPU, selected level and reader versions |
| Existing ecosystem compatibility | Gzip | Decode cost and avoid wrapping the whole file |
| Fast decode or a specific deployment need | LZ4 | Codec variant compatibility end to end |

There is no defensible universal byte-size or speed ratio. Data entropy, cardinality, dictionary effectiveness, page size, codec level, CPU generation and object-store bandwidth all change the outcome. A codec that reduces storage cost may increase write time or read CPU; for a cold archive that can be worthwhile, while a latency-sensitive repeated scan may prefer a faster codec.

## Compression units and parallelism

Parquet compresses page payloads as specified by the format, so a reader can locate and decompress the pages it needs rather than requiring decompression from byte zero of a single monolithic stream. This is one reason an internal Parquet codec is distinct from wrapping the whole output in a compression stream. File-level gzip undermines direct footer access and selective reads.

Codec choice also does not fix small files. A thousand compressed 2 MB objects still cause many listings, footer reads, task launches and metadata entries. Nor does a fast codec fix low parallelism from one enormous file or a single oversized row group. Compression and scheduling are related through chunk sizes, but must be tuned separately.

## Compatibility and evolution

The codec is part of column-chunk metadata. Mixed-codec datasets can exist: files may have been written by different applications or configuration generations. A reader needs support for every codec it encounters. Before changing a production writer, test both fresh outputs and historical files with the oldest supported reader, including schema and nested-column paths.

LZ4 is a notable example where implementations and historical format conventions have differed. Do not rely on a vague “supports LZ4” statement without checking the exact libraries and settings. Similarly, a managed SQL service may support the common codecs but not every codec accepted by a local Arrow build.

## Common mistakes

- Calling `gzip` files and Parquet with GZIP pages the same thing.
- Selecting the strongest compression setting without accounting for encode/decode CPU.
- Assuming the reader supports a codec because the writer exposes it.
- Comparing codecs on files with different row-group sizing or sort order.
- Expecting compression to make an unpartitioned, tiny-file-heavy layout cheap to plan.

## Production notes

Treat codec changes as a data-compatibility change. Publish a representative file, validate schema and row counts with each consumer, then run workload-based tests. Keep codec names and options visible in job configuration and metadata inspection. For Zstd, document the chosen level. For LZ4, verify the exact format variant; for gzip, confirm compression is internal to Parquet. Evaluate total cost across storage, request volume, writer CPU and query CPU rather than file size alone.

## Compression is an end-to-end decision

The best codec can differ for hot and cold data. A recently written table may be scanned repeatedly, so decompression CPU and tail latency matter. An archive read rarely may benefit more from reduced storage and transfer, accepting a slower write or occasional decode. Lifecycle tiers and request pricing can affect the economics too. Choose based on the whole access path, not a codec's reputation.

Writer parallelism changes the practical cost. A high compression level can increase CPU on every task and extend a distributed job, even if the file becomes smaller. Conversely, very low compression can raise remote bytes and make a scan network-bound. Record settings for each partition or file generation so operators can explain mixed layouts. Do not assume readers infer one table-wide codec: each column chunk carries metadata, and datasets can contain multiple generations.

Compression should be evaluated with schema and encoding held steady. A change in dictionary fallback, row-group size or sort order can alter output size independently of codec choice. Keep a reproducible input and compare file metadata, not just a configured option. For critical consumers, include upgrade and rollback tests: new files must remain readable by supported old readers for as long as those readers are in service. A compact file that operationally cannot be read is not a successful optimization.
