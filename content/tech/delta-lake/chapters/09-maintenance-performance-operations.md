# Table Maintenance and Performance Operations

A healthy Delta table is not achieved by running every maintenance command on a schedule. The job is to keep the transaction log, file layout, protocol compatibility and recovery posture aligned with actual workload. Read performance is a product of query plan, file statistics, file size, storage requests and concurrency. Write performance is affected by files scanned, shuffle, output size, commit contention and maintenance overlap. A useful operations program measures these components separately.

## Start with observability

For each important table, establish a baseline and ownership. Track current version and commit rate; number of active files and size distribution; partition skew; bytes read and written; files scanned versus skipped; merge source/target rows; operation duration; conflict and retry counts; and storage used by active versus obsolete files where available. History and detail commands, Spark UI/SQL plans, query profiles, cloud storage metrics and platform telemetry each expose a different slice.

Use operation metrics to decide what to do. A high file count with many tiny files suggests compaction. A query that scans most files despite a selective filter suggests missing or weak statistics, poor data locality or a predicate not matching layout. A slow merge that scans the full table suggests source/target pruning or key design. A large amount of obsolete data suggests a retention/cleanup issue, not necessarily an active-table query problem.

## Maintenance actions solve different problems

- **`OPTIMIZE` / compaction:** rewrites active files to reduce small-file overhead. In Databricks it can also apply Z-order or clustering options; availability and syntax are not universal across OSS clients.
- **Liquid clustering:** reorganizes data around evolving keys when supported, often incrementally; managed automatic key selection and scheduled optimization are Databricks capabilities.
- **`VACUUM`:** deletes eligible files no longer needed by the current snapshot. It is destructive for time travel and long readers; it is not compaction.
- **Checkpoint/log management:** limits the cost of reconstructing table state while retaining the history required by policy. Do not hand-delete log files.
- **Statistics collection:** supports file skipping; the columns with statistics and limits differ by implementation and configuration.
- **Schema/protocol review:** ensures all clients can continue reading and writing after a table feature is enabled.

Databricks predictive optimization can schedule maintenance for eligible Unity Catalog managed tables, but it is not a feature of open-source delta-spark. If the platform manages optimization, avoid redundant scheduled jobs unless metrics show a gap and the supported configuration calls for it.

## A maintenance policy by temperature

Hot tables with frequent merges or streaming writes may need regular small-file control and careful concurrency coordination. Warm tables used for recurring analytics may benefit from periodic compaction or clustering guided by their query profile. Cold append-only history may need little physical rewriting; optimize it only if observed scan costs justify the spend. For each class, define a maximum tolerated small-file count or file-size distribution, retention objective, and service-level expectation.

Avoid overlapping high-cost jobs: an `OPTIMIZE` competes for storage I/O and compute with ingestion, while concurrent merges may conflict or repeat work. Use a maintenance window only when it reduces contention; for continuously queried systems, incremental operations and throttling may be better. Partition-scoped maintenance should be narrow but not so frequent that it creates tiny optimized files in each partition.

## Cost and safety controls

Measure rewrite amplification: bytes rewritten versus bytes read by the workloads improved. A 20% query reduction may be poor economics if the table is rewritten daily and rarely queried. Keep an unchanged baseline or representative copy, standardize query inputs, and compare p50/p95 latency, bytes scanned and compute cost.

Before changing protocol features, inventory every client: Spark/Delta versions, SQL warehouses, streaming jobs, sharing recipients, catalog integrations, backup tools, and non-Spark readers. Table features can raise minimum reader or writer requirements. A table that works in the newest managed runtime may fail from a lagging OSS connector.

Vacuum has a separate destructive review. Confirm minimum retention policy, longest-running readers, checkpoint recovery needs, restore window and legal retention. If using dry-run support, review its candidate list. Reconcile old files only after table commits are healthy and backups cover the required period.

## Incident diagnosis

When a query suddenly slows, compare its plan and file metrics with the last good run. Check whether a schema change disabled pruning, whether new partitions or files arrived with missing statistics, whether a protocol/client upgrade changed execution, or whether file count has grown. For a failed write, first distinguish data/constraint errors, unsupported protocol, storage permissions, concurrent commit conflict and transient service failure. Each has a different recovery path.

For a corrupted-looking result, query a fixed version and compare it with current state. Confirm the reader uses the Delta format rather than a raw Parquet glob. Inspect history and commit metrics; do not edit the log. If data is wrong but files remain, restore or replay carefully. If vacuum has removed needed files, recovery depends on external backup or source replay.

## Common mistakes

- **Running all maintenance everywhere.** Tables have different temperatures, query shapes and cost profiles.
- **Vacuuming aggressively to reduce storage bills.** Shorter retention directly reduces recovery and time-travel capability.
- **Optimizing only by wall-clock.** Cache, concurrency and query variability can mask worse file scans or higher compute cost.
- **Treating managed optimization as Delta protocol behavior.** Scheduling and automation belong to specific platforms.
- **Upgrading a feature before checking readers.** A successful `ALTER TABLE` can break a downstream engine.

## Production notes

Give each critical table a runbook: owner, lineage, client compatibility matrix, maintenance policy, retention objective, alert thresholds, recovery steps and last tested restore date. Revisit policy when the query mix changes. Automate read-only health summaries freely; keep feature upgrades, destructive vacuum and table restoration behind review and explicit version-aware validation.

## Operating indicators and ownership

Every alert should point to an actionable failure mode. A rising active-file count may indicate a small-file problem; growing obsolete bytes may indicate delayed vacuum or a retention choice; rising conflicts may indicate overlapping writers; a falling pruning ratio can mean statistics or layout no longer match query filters. Record the rate and trend, not just a threshold snapshot, and attach the relevant table version and operation history to alerts.

Assign one team as table owner even when several teams consume the data. The owner approves protocol changes, defines canonical writers, publishes schema contracts and coordinates maintenance windows. Consumers should report required freshness and retention rather than independently scheduling rewrites. A quarterly review can compare current feature matrix and reader inventory with the table's runbook, because connectors and runtimes are upgraded over time. This ownership model prevents an optimization job from becoming an undocumented second writer or a platform change from unexpectedly breaking a lagging application.