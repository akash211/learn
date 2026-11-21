# Compression, Segments, and Query Implications

TimescaleDB can store older, mostly immutable time-series data in a compressed or columnar representation. This reduces storage and can improve analytical scans by avoiding reads of irrelevant columns. It does not make all queries faster: point lookups, updates, deletes, and queries that do not match the chosen ordering can behave differently from their rowstore counterparts. Exact feature names and APIs have changed; older documentation commonly calls this “compression,” while newer releases describe Hypercore or columnstore capabilities. Always verify installed-version syntax and supported operations.

## The physical trade-off

Recent chunks are usually written in PostgreSQL row format, which is efficient for inserts and updates to individual tuples. Once a chunk becomes cold, the extension may convert or compress it into a representation organized by columns and batches. Repeated values compress well; timestamps and measurements often have predictable distributions, while identifiers can be encoded or grouped. The result is storage savings and potentially fewer bytes read for aggregate queries, at the cost of a conversion step and changed access characteristics.

Compression is commonly configured with ordering and segmentation columns. The precise syntax varies by release; older installations use settings such as `timescaledb.compress`, `timescaledb.compress_orderby`, and `timescaledb.compress_segmentby` on the hypertable, while newer versions may use a columnstore API. A legacy-style policy example looks like:

```sql
ALTER TABLE sensor_readings SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'time DESC',
  timescaledb.compress_segmentby = 'device_id'
);
SELECT add_compression_policy('sensor_readings', INTERVAL '7 days');
```

This illustrates real names used by the classic API, not a promise that they are the right current interface for every release. Check the extension's installed version, the migration guide, and policy functions before applying DDL. Do not mix old and new configuration recipes without a compatibility check.

## Segment and order choices

A segment key groups rows with the same value so queries filtering on that key can skip other groups and compression can exploit repeated values. `device_id` can be a useful segment for per-device history. A high-cardinality segment key, such as a unique event ID, creates many tiny groups and undermines compression. Segmenting by a tenant can help if tenant-filtered queries dominate and each tenant has enough rows per chunk.

The order key sorts rows within compressed storage and should reflect common range predicates, often time. `time DESC` is useful for recent-first access patterns in APIs, while ascending time can suit forward scans; benchmark both if ordering matters. Sorting by an additional column can help some equality or grouped scans but may reduce usefulness for time-only scans. The ordering key is not a general-purpose B-tree: it cannot satisfy every predicate or arbitrary sort for free.

A typical design is `segmentby = device_id`, `orderby = time DESC`, but it is only a hypothesis. If almost every query scans all devices over a time interval, segmenting by device can create too many groups and add overhead. If queries filter by tenant then time, tenant may be better. Measure compressed size, conversion time, rows scanned, and latency under the actual query mix.

## Query behavior and mutability

Compressed or columnar chunks remain queryable through SQL, but not every operation supported on an ordinary chunk has identical behavior or performance. Point updates and deletes may require decompression or row-level handling, and older releases imposed stronger restrictions on modifying compressed chunks. Newer versions may support more operations or rowstore/columnstore transitions. Treat old data as immutable where possible, and confirm feature limitations before depending on updates, foreign keys, triggers, or conflict handling against columnar chunks.

Predicates should include time ranges and segment keys when applicable. An aggregate over a compressed chunk can be much faster because it reads a small set of columns. A request for one exact row by a non-segmented identifier may still scan or decompress more data than expected. `EXPLAIN (ANALYZE, BUFFERS)` and TimescaleDB's current chunk statistics are the way to validate behavior; do not infer performance from the compression ratio alone.

Compression can also affect indexes and statistics. Indexes appropriate for the hot rowstore may be redundant or differently useful on columnar chunks. Avoid indiscriminately maintaining many indexes when older data is rarely queried by those keys. Check the version-specific index support and whether a query actually uses the index after conversion. Make sure the planner has current statistics following transformations or bulk backfills.

## Policy timing

Policies typically convert chunks older than a configured age, leaving the active write window in rowstore. The age should exceed the late-arrival window and any update horizon. If events arrive hours late, compressing a chunk that is still receiving corrections causes churn and may fail or incur repeated conversion. Define a clear boundary between mutable and immutable data, and route corrections deliberately.

Policy jobs execute asynchronously and need operational capacity. A large backlog of eligible chunks can create CPU and I/O pressure. Monitor job status, duration, retries, and failures through the job metadata views available in the installed release. Schedule compression so it does not collide with backups, index maintenance, or peak ingestion. Confirm free disk for rewrite or conversion operations and understand WAL generation and replica lag.

## Common mistakes

- Expecting the highest compression ratio to deliver the fastest queries.
- Choosing a unique or very high-cardinality segment key.
- Compressing data before late writes and corrections have stopped.
- Assuming every old compression setting remains the recommended API.
- Keeping indexes that no longer help the compressed query pattern.

## Production notes

Test a representative chunk with both hot and historical queries before enabling a broad policy. Compare storage, CPU, write behavior, and query plans. Keep a rollback or re-rowstore plan appropriate to the version. Compression is a lifecycle decision, not merely a boolean storage option.

## Test the conversion boundary

Conversion should be validated at the exact boundary used by policy. Measure how long one representative chunk takes to convert, how much temporary disk it requires, how much WAL it emits, and whether a replica can keep up. Examine several data shapes: repeated values, random identifiers, null-heavy columns, and irregular event ordering. Compression ratios from a uniform synthetic dataset are often unrealistically favorable. Confirm that queries spanning both rowstore and columnstore chunks return the same results as the raw baseline, including aggregates with nulls.

Capacity planning must include the transient state while the source and converted representation coexist or while rewrite work is in progress, as applicable to the version and operation. A full disk during a conversion is an availability event, not a modest performance regression. Set job concurrency conservatively and retain headroom for PostgreSQL checkpoints, backups, and normal ingest. Rollback may require converting chunks back or restoring from backup; do not assume the original physical layout is instantly recoverable.
