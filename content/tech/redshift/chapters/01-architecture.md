# Architecture: Leader, Compute, Slices, and RA3

Amazon Redshift is a shared-nothing, massively parallel processing (MPP) warehouse. A query is not executed by one large database process reading one disk. The system plans work, divides it among compute slices, processes local data in parallel, and combines intermediate results. This model explains both its speed on broad analytical scans and its sensitivity to skew and data movement.

## Leader node and compute nodes

The leader node accepts client connections, parses SQL, consults metadata and statistics, creates the query plan, coordinates execution, and returns results. It can perform some work itself, but it is not where the bulk of table storage and parallel query execution happens. Compute nodes store user-table data and execute plan fragments. A cluster's leader schedules work on compute resources; it is not a general-purpose read replica that can take over all user-table scanning when the compute tier is saturated.

For a query such as a grouped sales report, the leader can arrange for each slice to scan its local blocks and produce partial aggregates. If the grouping key is suitably distributed, much of the aggregation is local. Otherwise, partial rows must be exchanged so that all rows for a key reach the same destination. The leader coordinates these stages and combines final output. A query may therefore be slow not because one CPU is weak, but because one slice receives disproportionate work or because a large intermediate result must travel across the cluster.

## Slices and parallel work

A compute node is divided into slices, each with resources for executing work. Data is assigned to slices according to a table's distribution style. When a query scans a table, slice-local workers can process their partitions concurrently. More slices do not guarantee a proportional speedup: the plan must expose parallel work, data must be balanced, and bottlenecks such as a single hot key, network transfer, memory, or queueing must not dominate.

Slice skew is a common hidden issue. An apparently large cluster can spend most of a join's time on one slice if the chosen distribution key has a few highly frequent values. `SVV_TABLE_INFO` exposes distribution and skew information useful for checking tables. Query execution and slice-level details can be investigated with `STL_QUERY`, `STL_QUERY_SUMMARY`, `SVL_QUERY_SUMMARY`, and current-state views such as `STV_EXEC_STATE`. System-table coverage differs by provisioned versus serverless operation and by view; use current `SYS` monitoring views where they better fit the deployment.

## Columnar storage and block skipping

Redshift stores table data in columnar form. A query selecting three columns from a wide table can avoid reading unrelated columns, and encodings can reduce I/O for repeated or compressible values. Sort order adds another pruning opportunity: the engine tracks block-level value ranges, so a predicate on a leading sort key may eliminate blocks whose ranges cannot match. Neither feature helps if a query selects every column, if predicates do not align with sort order, or if the table is badly unsorted.

Columnar layout also changes the meaning of a good design. Row-by-row point lookups and high-frequency transactional updates are not the workload Redshift is optimized to serve. Large scans and set operations are. A familiar SQL statement can therefore have radically different cost depending on data size, compression, sort state, and how much data crosses slices.

## RA3 and managed storage

RA3 node families decouple compute capacity from the managed storage layer. Compute nodes cache frequently accessed data locally while durable managed storage allows the database to hold more data than fits in local cache. This makes RA3 useful when storage needs grow faster than active compute demand, and it changes capacity planning: local cache hit behavior and query locality matter, not simply whether the whole database fits on node-attached disks.

This separation is not the same as a free, infinitely fast S3 scan. The cluster still performs execution, and repeated access to cold or remote blocks can behave differently from warm-cache access. Benchmark realistic query mixes, not a single warmed-up query. RA3 also supports features such as data sharing and concurrency scaling on supported configurations, but feature eligibility depends on deployment configuration and evolves; confirm the current service documentation before designing around a specific capability.

## Provisioned clusters and Serverless

A provisioned cluster gives an operator explicit node capacity and a cluster lifecycle. This can suit steady demand, predictable performance envelopes, and workloads that benefit from committed capacity and hands-on tuning. Redshift Serverless manages capacity for a workgroup and database, which reduces cluster administration and can suit variable or intermittent usage. It does not make query design irrelevant: distribution, sort state, concurrency, external scans, and workload patterns still determine efficiency. Capacity scaling can also change observed performance and spend, so use workload history and guardrails when comparing operating models.

A useful architecture decision compares workload shape rather than product labels: average and peak concurrency, idle periods, data growth, latency targets, cross-account sharing, and how much control the team wants over capacity. Include observability and operational ownership in the comparison. Serverless still needs query triage and permissions; provisioned clusters still benefit from managed maintenance and elastic resizing.

## Provisioned execution and data lifecycle

A useful mental model is to follow one request from client to result. The leader receives the statement, checks permissions and metadata, optimizes the relational expression, and produces a distributed plan. The plan assigns scans and local operators to slices, then inserts exchange steps where rows need to be combined or moved. Each exchange has a cost: it uses network bandwidth, memory buffers, and synchronization. If a stage cannot produce its input quickly, downstream workers can sit idle even when total cluster CPU appears moderate.

Data placement is established when rows are loaded or changed, not freshly chosen for each query. This is why a distribution key is a durable schema decision and why a poorly balanced key can persist as a recurring bottleneck. A table can have a large row count yet low effective parallelism if most rows map to a few hot values. Conversely, even distribution may balance scans but require redistribution for common joins. Diagnose the whole plan rather than inferring performance from node type or row count alone.

The storage/cache boundary on RA3 is also important when interpreting tests. A frequently queried working set can be served differently from an archive touched once a month. Compare performance across repeated runs and after a restart or a change in workload, and consider whether cache effects explain the result. Keep cold-history queries and hot dashboard queries in the benchmark suite so capacity decisions do not optimize only for the easiest case.

## Production notes

- Treat the leader as coordinator, not as a substitute for compute capacity.
- Design for balanced slice work; node count alone does not reveal skew.
- Separate queue time from execution time when diagnosing a slow query.
- Compare cold and warm runs, and include concurrent load in benchmarks.
- Export system history you need to retain. `STL_` log views have bounded retention; they are not a permanent audit archive.

## Common mistakes

- Assuming more nodes will fix a serial or badly skewed plan.
- Assuming RA3 managed storage means all active data resides in local cache.
- Treating Serverless as a performance or cost guarantee rather than a different capacity model.
- Applying OLTP design assumptions, such as optimizing every single-row lookup, to a scan-oriented engine.
