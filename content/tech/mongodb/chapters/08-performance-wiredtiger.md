# Performance, WiredTiger, and the Working Set

MongoDB performance depends on more than query shape. A useful investigation separates server work, storage latency, lock or ticket queues, replication flow control, network transfer, and application wait time. WiredTiger, the default storage engine, uses document-level concurrency control for most operations, maintains indexes and data in a cache, and checkpoints data to disk while journaling supports recovery. Details and defaults can change across MongoDB versions; inspect the running version and configuration rather than treating a remembered value as a contract.

## Working set and cache pressure

The working set is the data and index pages a workload repeatedly touches. If it fits comfortably in available memory, reads are more likely to be served from WiredTiger's cache or the operating-system page cache. If it does not fit, the system performs more disk I/O, and latency can rise sharply under random access. Indexes enlarge the working set, so adding an index may improve a targeted query while evicting useful data pages elsewhere.

Monitor WiredTiger cache usage, dirty bytes, page reads and evictions alongside host memory and disk latency. A high cache percentage is not itself a problem; eviction pressure and storage reads under the actual workload matter. Avoid assuming a single database metric explains latency: correlate database metrics with host-level I/O, CPU, network, and application connection-pool behavior.

## Query profiler and logs

MongoDB's database profiler can record operations to `system.profile`; profiling levels and filters should be chosen carefully because profiling itself has overhead and the collection consumes storage. The slow-operation log provides another source of evidence. Use low-impact sampling and queryable observability tools where available, and define operational policies for retention and access because query documents may contain sensitive values.

```javascript
db.setProfilingLevel(1, { slowms: 100 })
db.system.profile.find({ ns: "shop.orders" }).sort({ ts: -1 }).limit(20)
```

The threshold and profiler behavior are configurable and version-specific. In MongoDB 8.0, slow-operation reporting can use time spent working (`workingMillis`) rather than total duration for relevant diagnostics; queued time is also exposed in newer logs. This helps separate execution cost from waiting, but verify exact fields in the server version and toolchain before building alerts.

## Explain the work, not just the latency

Use `explain("executionStats")` for representative queries. Compare documents and keys examined with results returned, inspect index selection and sort behavior, and check whether the plan has a large `FETCH` or collection scan. Also investigate application-level issues: missing connection pool capacity, excessive serialization, N+1 lookups, or fetching large documents when only a few fields are needed. Tail latency often reveals skew or contention hidden by average latency.

## Writes, checkpoints, and storage growth

WiredTiger uses compression for data and indexes, but compression ratio depends on document content and configuration; do not assume a universal ratio. Updates can write new versions and affect indexes. Hot documents, large embedded arrays, and broad multi-document updates can create contention and write amplification. The storage engine periodically checkpoints; journaling and checkpointing are distinct mechanisms, and recovery and durability depend on acknowledged write concern and configuration.

Deletes do not necessarily shrink files immediately. Reusable space and filesystem space returned are different concepts. Compaction or resync may reclaim space but consumes I/O and temporary capacity; schedule it only after measuring actual storage constraints. Keep enough free space for growth, backups, index builds, and maintenance.

## Common mistakes

- Assuming all data fits in cache because total RAM is large; indexes, OS, and other processes consume memory.
- Adding indexes without measuring their impact on the overall working set and write load.
- Treating a slow-operation threshold as equivalent to end-to-end request latency.
- Running the profiler at high volume indefinitely without considering overhead and sensitive data.
- Using compression or compaction as a substitute for correcting unbounded data growth.

## Production notes

Establish baselines for query latency percentiles, examined-work ratios, cache evictions, disk latency, replication lag, and queueing. Investigate one representative slow query from client request through server execution rather than tuning from a single metric. MongoDB 8.0 introduced query-shape and slow-operation telemetry changes; dashboards must handle version differences and distinguish `durationMillis` from work time where relevant. Avoid invented generic benchmark claims: measure on the actual data, hardware, and concurrency profile. Compare one change at a time, keep the same query mix and data shape, and note whether the test is cache-warm or cold. Include the effects on writes and other query shapes, not just the optimized request; a faster isolated query can make the overall service slower if the added index displaces hot pages.
## Diagnose a slow request in layers

Start with the user-visible request and determine whether latency is server execution, queueing, network transfer, or client-side waiting. Compare application tracing with profiler or slow-log records using a request comment or stable operation identifier where appropriate. For a query, capture its filter, sort, projection, tenant distribution, and result size; then run execution statistics on representative parameters. A plan that examines few records but returns multi-megabyte documents may be slow because of serialization and network cost, not index selection. A query with a good plan can also wait behind resource saturation.

Correlate database evidence with host metrics. High storage read latency and cache evictions suggest the working set or I/O path needs attention; CPU saturation may point to expensive expressions, decompression, or broad scans; rising connection wait can indicate an undersized or misused client pool. Replication lag and flow control can constrain writes when secondaries cannot keep up. Per-operation and per-node signals help distinguish a local bottleneck from an application-wide pattern. Avoid treating cache occupancy alone as an alert: healthy systems often use most available cache, and eviction workload plus disk reads is more informative.

## Indexes, cache, and write amplification

An index improves selected access paths but consumes storage and memory and is updated on every relevant write. A new index may reduce keys examined for one endpoint while displacing data pages used by another. Measure write throughput, cache behavior, and other query shapes before and after adding it. Similarly, reducing document size can improve network and cache efficiency, but splitting data into many references can create more round trips or lookups. The right unit of work is the whole workload, not one query in isolation.

WiredTiger checkpoints and the journal have related but different purposes. Journaling supports crash recovery between checkpoints; checkpoints write a consistent state to data files. Durability seen by a client also depends on write concern and deployment configuration. Do not equate a successful checkpoint metric with a backup, nor assume that filesystem free space will immediately increase after deleting records. Reusable internal space, compacted storage, and bytes returned to the filesystem are distinct outcomes.

Use low-impact profiling and protect captured query data, which may include sensitive literals. Establish baselines for latency percentiles, scanned work, cache evictions, disk latency, replication lag, and queueing. Then change one variable at a time under representative concurrency and observe whether the improvement persists after cache state and data distribution stabilize.
