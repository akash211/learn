# Reading at Scale

Parquet's selective column access helps most when the reader can efficiently discover files, fetch footer metadata, issue targeted range reads and decode only the needed data. On a local disk, storage latency may hide some of these costs. On S3 or another object store, request count, listing, authentication, retries and network throughput become part of query execution.

## Projection and vectorised readers

Projection pushdown starts with a query plan that knows which columns are needed. A Parquet reader can fetch those column chunks rather than the whole row. Filters, joins, grouping keys and expressions may require extra columns beyond the final output, so inspect the scan's read schema rather than only the selected result.

A vectorised reader decodes batches of column values into columnar or batch-oriented structures, reducing per-row overhead and enabling efficient CPU execution. Spark, Arrow and DuckDB use vectorized techniques in different ways. A reader may fall back to a row-wise path for unsupported types or features; performance depends on version and configuration. Vectorisation is an implementation optimization, not a Parquet guarantee.

Nested projection can be especially valuable for wide event records: selecting `device.location.country` need not always read every sibling field. But nested schema pruning support varies, and the definition/repetition level streams required to reconstruct structure still matter. Verify actual bytes and read schema.

## File discovery and footer costs

A distributed query must find files before scanning them. Recursive object-store listing, glob expansion, partition discovery and footer retrieval can be expensive for enormous directories. Small-file layouts amplify the cost: each file requires metadata work even when a predicate later rejects its row groups. Catalogues and table formats can reduce discovery costs, but their behavior is distinct from the Parquet footer.

Planning can also run into memory pressure when metadata for many files is collected on the driver or coordinator. Partition pruning before file enumeration, manifest-based table metadata, file listing caches and compaction are possible mitigations depending on the engine. They should be measured and managed for freshness; a stale cache can miss newly written objects.

## Object storage and range requests

Parquet's footer-at-end design allows a reader to request the tail of an object, parse offsets and then request selected column chunks. Object stores support range reads, but a query may issue many requests for scattered chunks and pages. Request latency, bandwidth, retries, concurrency limits and credentials influence results. Some readers coalesce nearby ranges or use prefetch; others behave differently. If the whole file is wrapped in an external compression stream, direct footer and range access is usually lost.

S3-compatible systems and cloud storage services are not identical in consistency, throttling, request pricing or failure behavior. Use the engine's supported filesystem connector, region-local compute and credential mechanism. Avoid assuming that a local filesystem test predicts cloud scan performance. Also account for encryption, TLS, endpoint configuration and transient errors.

## Parallelism and memory

Parallel scans require enough independent files or row groups, but excessive tiny tasks add overhead. A row group is a storage unit; reader task assignment is engine-specific. Wide rows and nested data can use more decode memory than compressed bytes suggest. Vectorized batches, dictionaries and decompression buffers have their own memory footprint. A query selecting many columns may materialize a large in-memory batch even when on-disk compression is strong.

Remote reads benefit from concurrency until the network, object store, coordinator or worker becomes saturated. Increasing threads can make a query slower if it increases request contention or memory pressure. Tune with metrics: remote bytes, request and retry counts where available, CPU, memory, task skew, planning time and scan throughput.

## Robustness and observability

A large scan may encounter transient failures, expired credentials or malformed files late in the job. Ensure retry behavior is bounded and safe. For raw directories, partial writes can make a reader see incomplete output; use immutable paths and publish only after validation, or use a transactional table format. A footer check is a useful integrity test but does not prove every page decompresses or every row is semantically valid.

Useful diagnostic questions include:

1. How long did discovery and planning take before tasks began?
2. How many files and row groups were considered and read?
3. Which columns were fetched, and how many bytes came from remote storage?
4. Are requests serialized, throttled or repeatedly retried?
5. Are slow tasks caused by skew, decode CPU, spill or object access?
6. Does the output path represent a committed snapshot or a set of partially published files?

## Common mistakes

- Assuming columnar format eliminates object listing and footer-read overhead.
- Increasing scan parallelism without checking remote request saturation or worker memory.
- Treating compressed bytes as a reliable estimate of decompressed batch memory.
- Testing cloud reads on local storage and extrapolating latency.
- Using external gzip and expecting footer range reads to remain efficient.
- Ignoring stale file-list caches or concurrent writes to raw directories.

## Production notes

Benchmark against representative file counts, partition depths, codec choices and network paths. Separate cold-cache and warm-cache measurements. Observe planning time independently from scan time. Use supported connectors and explicit identity roles rather than embedding credentials in paths or jobs. If metadata discovery dominates, address layout, manifests or catalogue strategy; adding query workers will not fix a coordinator bottleneck. If bytes dominate, revisit projection, partitioning, row-group stats, sort order and codec based on observed scan metrics.

## Caches and consistency

Readers often cache some combination of file listings, footer metadata, object content or decoded data. A warm-cache benchmark can be substantially different from a first read, but cache layers have separate scopes and expiration rules. A listing cache may not see a newly published file; stale metadata can describe old sizes or schemas; a data cache can retain bytes after an object was replaced. Prefer immutable object paths and table snapshots so cached references remain valid. When the dataset changes, use the engine's supported refresh/invalidation path and confirm that new files are visible.

Retries also interact with object-store semantics. A transient timeout during a range read may be recoverable, but retrying a task while the underlying directory is changing can produce inconsistent observations. A plain path does not pin a snapshot. Table formats provide snapshot identity through their metadata protocol; raw datasets should use immutable versions or an explicit manifest. Keep bounded retries and log the object key and range for diagnosability without exposing credentials.

Security and locality are performance concerns too. Use an identity mechanism supported by the engine rather than embedding access keys in SQL or paths. Run compute near the bucket when possible, and verify the connector uses the expected endpoint and region. Cross-region transfers, encryption setup and request throttles can dominate after the file layout is already sound. These operational variables explain why a local Parquet benchmark cannot predict a production cloud scan.
