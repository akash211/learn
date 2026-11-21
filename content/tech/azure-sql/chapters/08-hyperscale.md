# Hyperscale Architecture and Operations

Hyperscale is an Azure SQL Database service tier built around a distributed storage design for databases that need large data capacity, elastic storage growth or a read-replica topology. Its architecture differs from the traditional single-primary-plus-remote-storage pattern. Understanding the roles of compute, log and page-serving components helps explain scaling, replicas and operational trade-offs. Hyperscale is not simply the biggest size in a standard tier, and it should be selected for architectural fit rather than a storage headline.

## Architectural components

A Hyperscale database has a primary compute replica that runs the SQL Server database engine and serves read-write requests. Compute replicas maintain local caches and coordinate with a log service. The log service receives and persists the transaction log stream and makes it available to storage components and replicas. Page servers persist database pages and provide them to compute when needed. The storage layer is distributed rather than being a monolithic data file attached to one compute node.

A write is logged by the primary and its log records flow through the log service. Page servers apply log information to maintain page state. The primary's local cache can serve frequently accessed pages, while cache misses require interaction with the page-server layer. This design supports rapid storage growth and separates compute scaling from the durable data footprint. It does not imply that every read is equally fast: cold-page access, cache hit rate, query shape and contention still influence latency.

Hyperscale supports named secondary compute replicas in appropriate configurations. These can serve read-only workloads and provide additional compute endpoints, subject to the exact replica feature and service settings. A read-only replica may lag the primary because log changes have to propagate. Applications must tolerate replica freshness delays and should not direct consistency-sensitive read-after-write traffic to an asynchronous secondary without a deliberate consistency strategy. Adding replicas consumes resources and does not make a poorly designed query efficient by itself.

## Scaling and storage growth

Compute and storage can be managed more independently than in traditional service tiers, but scaling remains a control-plane operation with configuration limits, timing and possible connection effects. Select compute for the workload's CPU, memory and concurrency needs; consider replicas only where read workload and freshness requirements justify them. Storage grows as data is added and the architecture is designed for very large databases, but application growth still needs capacity forecasting, retention policy and index maintenance planning.

Because durable pages are distributed, backup and restore behavior differs from a simple copy of a single data file. Hyperscale backup architecture supports rapid restore characteristics in supported scenarios, but actual recovery time, cross-region restore, retention, and operations depend on configuration and current service capabilities. Validate the feature matrix for the required operation, database size and destination. Do not extrapolate recovery behavior from General Purpose or Business Critical documentation.

Hyperscale's storage design should be considered alongside data lifecycle. Large historical tables can still create expensive queries, long maintenance operations, oversized indexes and data movement. Partitioning, compression, archival, and retention may be appropriate even when raw capacity is plentiful. Monitor storage growth and backup/recovery plans just as carefully as compute utilization.

## Compatibility and migration considerations

A migration into Hyperscale may require a supported migration path, such as logical data movement, database copy or another method supported by current platform tooling. Backup/restore options are not interchangeable among tiers. Review source and destination size, data transfer duration, downtime, consistency and feature compatibility. Test the migration against a production-like data set; copying a small test database does not predict the time to move a large data estate.

Some capabilities vary among Azure SQL service tiers and may have prerequisites or limitations on Hyperscale. Check the current Azure SQL Database feature matrix for the exact feature—such as cross-database behavior, maintenance operation, replication, encryption or backup options. Avoid assuming all SQL Server engine features are unsupported or supported; validate each critical dependency. A database-level compatibility level affects query behavior and optimizer choices, and is distinct from service tier.

## Monitoring and troubleshooting

Use Query Store to inspect plans, waits and query resource use, and Azure Monitor metrics for compute, IO and storage pressure. Evaluate primary and secondary replicas separately where the platform exposes replica-specific signals. A query that is slow only on a secondary may indicate different cache warmth, workload competition or replication delay. Track application read/write routing and consistency requirements alongside database metrics.

Hyperscale's architecture adds components but does not give customers direct administrative access to page servers or the log service. Troubleshoot using supported Azure metrics, DMVs, Query Store, resource health, Activity Log and support diagnostics. Do not attempt to use operating-system counters or hidden internal endpoints unavailable in the managed service. If the symptom appears infrastructure-related, collect resource IDs, time windows, request identifiers and customer-visible impact before contacting support.

Read scale routing should be explicit in connection configuration where supported. Confirm that clients use the intended read-only routing option and that the service supports the chosen replica setting. Queries that depend on immediate visibility of preceding writes should remain on a path with the required consistency. Keep OLTP writes isolated from analytical scans when query resource governance and replica routing allow it; a large report can still compete for resources on the compute replica it uses.

## Choosing Hyperscale

Hyperscale is a candidate when data size, growth rate, storage scaling or read-replica needs align with its architecture. It may be a poor fit if a required feature is unavailable, migration method is unacceptable, regional support is missing or the workload depends on behavior that differs from another tier. Compare the total operating design, not just a performance benchmark. Include compute cost, replicas, backup retention, data transfer, supportability and the team's familiarity with the model.

### Common mistakes

- Treating page servers and log service as customer-managed servers or assuming they are individually tunable.
- Assuming secondary replicas provide strongly consistent reads or absorb all analytical load automatically.
- Choosing Hyperscale solely because a database is large without checking feature and migration compatibility.
- Applying backup and restore assumptions from another Azure SQL tier.
- Ignoring cold-page IO, query shape and data lifecycle because storage is distributed.

### Production notes

Test migration, scaling, read routing and restore in a representative environment. Document which endpoints serve reads and writes, acceptable replica lag, recovery scenarios and supported tier features. Revisit the architecture as regional availability and product capabilities evolve; use current service documentation rather than an old sizing note.

## Read routing and query consistency

Read-scale replicas are useful only when the application can describe which queries are safe to send to them. Analytics, search and reports may tolerate a small delay, while a confirmation screen immediately after an update may require the primary. Make routing a deliberate application decision rather than relying on an implicit connection default. Measure read latency and replication freshness using supported signals, and include replica behavior in the incident dashboard. If a replica is unavailable, decide whether the client should fail over to primary, queue work or return a controlled error; redirecting all reads can unexpectedly overload the write path. Ensure any replica-specific connection string still uses secure authentication and the intended network policy.
