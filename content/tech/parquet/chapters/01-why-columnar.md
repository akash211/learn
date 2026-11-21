# Why Columnar Storage

Parquet is popular because it matches the access pattern of analytics: scan many records, calculate over a few fields, and avoid moving irrelevant bytes. Understanding that trade—not just remembering that Parquet is “columnar”—helps decide when it fits, how it should be laid out, and why a nominally small query can still be expensive.

## Row storage versus column storage

A row-oriented representation places the fields of one record together. That is convenient when an application fetches or updates a whole record, or appends a message in its natural form. It is less convenient for a query such as “sum revenue by region for the past quarter.” The query needs only `region`, `event_date` and `revenue`; a row store may still have to read or decode many other attributes.

A columnar format groups values by field. A reader selecting those three fields can locate their column chunks and leave other chunks untouched. This is projection pushdown: the query plan communicates the required columns to the storage reader. It saves I/O and decoding, especially for wide records where each query uses a small fraction of the schema.

| Workload | Layout advantage |
|---|---|
| Fetch one complete record by key | Row-oriented layouts often fit naturally |
| Scan a large table and aggregate a few fields | Columnar layout avoids unrelated columns |
| Append heterogeneous events for immediate consumption | A row message format such as Avro may be simpler |
| Repeated analytical scans over stable typed data | Parquet's column chunks, encodings and statistics are useful |

The distinction is not absolute. A columnar scan still has overhead to discover files, read footers, open remote objects and materialise output rows. A row-oriented format can also be compressed. The advantage depends on the query and the engine's implementation.

## Why columns compress well

Values next to each other in one column usually have the same physical type. This makes generic compression more effective than compressing arbitrary mixtures of strings, timestamps, null markers and numbers interleaved in a row. The writer can also apply encodings that exploit the column's structure before compression: repeated values may use dictionary encoding, and sequences or small integers may use specialised integer encodings.

The stages matter. Encodings are part of Parquet's typed representation and compression codecs operate on the encoded bytes of pages. Dictionary encoding, for example, replaces values with dictionary indices; compression may then reduce the dictionary and index streams further. It is a mistake to treat “encoding” and “compression” as synonyms or to assume one codec determines the whole file's size.

Compression reduces storage and often reduces bytes fetched from remote storage. It costs CPU to encode and decode, but modern readers can process many workloads faster by reading fewer bytes. Whether that trade is favourable depends on data, codec, CPU, network and query concurrency. There is no universal compression ratio or codec winner.

## A file is not one giant column

Parquet divides a file into row groups. Within a row group, values for each leaf column are stored as a column chunk, and chunks contain pages. This hierarchy balances sequential access, parallelism and metadata overhead. A reader can select the column chunks it needs and may use page or row-group metadata to avoid decoding values that cannot match.

Row groups also bound the unit over which many implementations collect statistics. If the rows in a row group are physically ordered by a commonly filtered field, its minimum and maximum can form a narrow range. A predicate outside that range lets the reader skip the row group's chunk for that field and, depending on engine and query needs, other data in that group. If rows are randomly mixed, each row group may span nearly the entire domain and skipping becomes weak.

That is why physical layout is a query-design decision. Partition directories can exclude whole files; row-group statistics can exclude regions inside files; column projection can avoid unselected fields. These optimisations are distinct and can compound. A filter alone guarantees none of them: readers must support the metadata, the predicate must be eligible, and the layout must make the metadata useful.

## The format is not the engine

Parquet specifies a portable file representation: schema, metadata, encodings, compression identifiers and byte locations. It does not dictate a SQL planner, distributed scheduler, object-store listing strategy, catalogue, transaction protocol or cost model. Spark and DuckDB may read the same file through different code paths and make different choices. Compatibility also depends on the writer's logical types and the reader's support for them.

The footer is central to discovery: it contains file metadata and row-group descriptions, and the trailing magic bytes let readers locate it from the end of the file. A scan often has to fetch this metadata before it can decide which column chunks to fetch. On a directory with a huge number of tiny objects, metadata requests and planning can dominate even if projection makes each data read small.

Parquet also does not make a directory a reliable table. If one writer overwrites files while another lists the directory, a reader can observe a partial state. If a job fails after writing some outputs, there is no built-in commit record that distinguishes a complete snapshot from leftovers. A table format such as Delta Lake or Iceberg addresses these concerns using metadata and transaction protocols over data files.

## When Parquet is a good fit

Use Parquet for typed, scan-oriented datasets that will be queried by compatible engines, particularly when queries select subsets of columns and benefit from columnar encodings. It is well suited to durable lake files and bulk interchange. It is less natural as a per-event message on a streaming topic, as a mutable row store, or as the only coordination mechanism for concurrent table updates.

The common production bottleneck is not that Parquet is “slow.” It is a mismatch: too many small files, poor clustering, an unsuitable schema, unsupported compression, enormous row groups for the reader, or an expensive remote listing. Diagnose at the layer that is costly rather than changing codecs blindly.

## Common mistakes

- Calling Parquet a database or assuming a file format supplies transactions.
- Assuming columnar storage means every query reads exactly the selected column's compressed bytes; footers, decoding and output materialisation have costs.
- Confusing a codec with an encoding and treating codec names as interchangeable.
- Expecting predicate pushdown to skip rows from every file regardless of row order and statistics.

## Production notes

Inspect both the query plan and the files. Record bytes scanned, columns read, files opened, row groups skipped where the engine exposes it, and planning time. Compare those observations with the directory layout and writer settings. Good tuning starts with what the reader actually touched, not with a generic “columnar is faster” claim.
