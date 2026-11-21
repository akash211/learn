# Indexing Strategy for Time-Series

Indexing a time-series hypertable begins with the query workload, not a list of index types. A timestamp column is often the partition dimension, but a time predicate alone may still scan many rows within each selected chunk. Secondary indexes can locate matching devices, tenants, or event types, yet every index adds write amplification, storage, vacuum work, and per-chunk objects. Create only indexes that support measured access paths.

## Composite B-trees

A B-tree on `(device_id, time DESC)` is a common pattern for a query that filters by device and retrieves the latest observations:

```sql
CREATE INDEX ON sensor_readings (device_id, time DESC);
SELECT time, temperature
FROM sensor_readings
WHERE device_id = 42
  AND time >= now() - INTERVAL '1 day'
ORDER BY time DESC
LIMIT 100;
```

The leading equality key narrows the scan to a device, then the time range and ordering can be served efficiently. For queries that filter time first and aggregate all devices, `(time, device_id)` may be better, but it does not serve device-only lookup equally well. PostgreSQL B-trees use leftmost-prefix behavior: an index on `(a,b)` is naturally useful for `a` and `a,b`, not generally for `b` alone. Each chunk has its own index structure, so index proliferation multiplies catalog and maintenance cost.

Unique constraints also need to respect hypertable partitioning requirements. Ensure the time and any space partitioning dimensions required by the installed version are present in the unique key. Do not add a unique index on a sensor identifier alone and expect global uniqueness across every chunk.

## BRIN for correlated append data

A BRIN index summarizes ranges of heap blocks rather than indexing each row. It is tiny and cheap to maintain when physical row order correlates with the indexed time value. A chunk populated mostly in event-time order is a natural candidate:

```sql
CREATE INDEX ON sensor_readings USING brin (time)
  WITH (pages_per_range = 64);
```

BRIN is lossy: it identifies candidate block ranges whose min/max may overlap the predicate, and PostgreSQL rechecks tuples. If rows arrive arbitrarily late or backfills scramble physical order, min/max ranges become wide and pruning loses power. `pages_per_range` trades index size for finer summaries. Smaller ranges can improve selectivity but consume more index space. Benchmark with realistic disorder and inspect `EXPLAIN (ANALYZE, BUFFERS)` for lossy blocks and rows removed by recheck.

A BRIN index and a B-tree serve different roles. BRIN is not a cheap B-tree substitute for exact point lookups; it is a compact way to skip large ranges of physically correlated data. Some workloads benefit from a B-tree on `(device_id,time)` plus a BRIN time index, but the BRIN may be redundant if chunk pruning and other indexes already reduce work. Compare query plans and write costs.

## Skip scan limits

Newer PostgreSQL releases can use B-tree skip-scan strategies in some cases when a leading column is unconstrained and has sufficiently few distinct values. This is a planner optimization, not a general guarantee that an index on `(tenant_id, time)` is as good for time-only queries as an index beginning with time. Its usefulness depends on distinct counts, statistics, range selectivity, PostgreSQL version, and cost estimates. TimescaleDB inherits PostgreSQL behavior subject to extension compatibility; test on the exact server version. Do not build an index layout around a skip scan without observing it in `EXPLAIN`.

Chunk pruning is a separate first step: it eliminates whole chunks using time bounds. Index selection then operates within surviving chunks. An index that looks unused in a query spanning the entire retention period may be effective for a narrow recent query, so evaluate representative windows and parameter values.

## Covering and partial indexes

`INCLUDE` can add payload columns to a B-tree so an index-only scan may avoid heap visits when the visibility map permits. It increases index size and write cost, and frequently updated data is less likely to have all-visible pages. A covering index on recent hot chunks may therefore disappoint even when the plan says index-only scan. Check actual heap fetches and vacuum behavior.

Partial indexes can focus on a stable subset, such as `WHERE severity = 'critical'`. Avoid predicates tied to moving time such as `WHERE time > now() - interval '7 days'`: index predicates must be immutable and a moving horizon would not update itself. Retention and chunking already constrain time scope; make partial conditions stable and selective.

## Operational trade-offs

Every additional index increases ingest work, WAL volume, replication traffic, backup size, and maintenance time. On a hypertable, a new index may be created across many chunks and cause a large migration. Use concurrent index creation where supported by the extension and PostgreSQL version, but verify hypertable-specific command support and lock behavior. Monitor index sizes and scans per chunk; an index unused by any real query is a candidate for removal, but validate application paths and reporting periods before dropping it.

## Common mistakes

- Creating an index for every filtered column independently.
- Expecting BRIN to work when row order is uncorrelated.
- Assuming a composite index helps equally in every column order.
- Treating a possible B-tree skip scan as a dependable substitute for the correct leading key.
- Measuring only a warm-cache query on one small chunk.

## Production notes

Capture slow query patterns, parameters, and time ranges. Test index candidates with the real ingest rate and compare both read benefit and write penalty. Index strategy is an ongoing trade-off: query plans and index usage change as the hot window and data distribution change.

## Statistics and planner evidence

The optimizer chooses from statistics, not from the index designer's intention. Run `ANALYZE` after major backfills or distribution changes, and inspect estimated versus actual rows at each scan node. A skewed device key may need extended statistics or a different query plan than the average device. Parameter-sensitive workloads can behave differently for a rare device and a high-volume device, so test both. Do not force an index with planner settings until the root cause—bad estimates, unsuitable key order, or poor selectivity—is understood.

Index-only scans are conditional on visibility information and column coverage, not guaranteed by `INCLUDE`. On a write-hot chunk, rows are frequently updated and pages may not be all-visible. On older immutable chunks, vacuum can make index-only access more attractive. This reinforces why a single index design may not be optimal for every age of data. Measure the plan in both recent and historical ranges, and consider whether chunk-level lifecycle or storage differences justify specialized indexes.

A partial index can be especially useful when the predicate is a stable status or category that selects a small fraction of rows. Its predicate must be immutable and match the query predicate in a way the planner can prove. Parameterized predicates may not always imply a partial-index condition under a generic plan. Verify with the actual prepared query path, not only a literal in a console.
