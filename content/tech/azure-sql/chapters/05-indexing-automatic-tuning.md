# Indexing and Automatic Tuning

Indexes are physical structures that trade storage and write work for more selective reads. Azure SQL Database uses the SQL Server relational engine's rowstore and columnstore index mechanisms, but the managed service also offers automatic tuning capabilities. The right approach is not “turn everything on” or “never automate”; it is to keep a clear performance baseline, understand each recommendation, enable narrowly scoped options, and monitor whether the observed benefit persists.

## Design indexes from workload evidence

A nonclustered rowstore index is a B-tree with key columns that control navigation and order, optional included columns stored at the leaf, and a row locator. An index can support a seek, ordered retrieval, join or covering access, but the optimizer may choose a scan when it estimates that reading many rows is cheaper. A seek is not inherently superior: a seek followed by millions of key lookups may perform more work than a scan.

Start with the query predicates, join conditions, grouping and ordering, then inspect actual plans and Query Store frequency. Index key order matters. For a common predicate `WHERE TenantId = @tenant AND CreatedAt >= @from`, an index beginning with `TenantId` then `CreatedAt` can support equality followed by a range, assuming the data distribution and query shape make it useful. Included columns can avoid lookups for output columns but do not contribute to seek predicates or sort order. Keep keys narrow and avoid including large payload columns without a measured need.

Filtered indexes can be effective for stable subsets, such as active rows. The optimizer has to prove that the query predicate implies the filter; parameterized predicates or different null semantics can prevent use. Unique constraints and indexes also enforce correctness, not just speed. Index changes affect inserts, updates, deletes, storage and maintenance. Each extra index must be kept current as rows change and may slow write-heavy workloads.

For analytical scans, columnstore indexes compress values by column and organize data in rowgroups. They can reduce IO and enable batch processing for broad aggregations, but may not fit point-update patterns or tiny selective lookups. Azure SQL supports engine capabilities according to tier and compatibility configuration; test the actual plan and workload rather than applying a blanket OLTP/warehouse rule.

## Query Store evidence and missing-index signals

Query Store identifies high-cost queries, plan changes and recurring execution patterns. Use it to find workload-level opportunities rather than tuning one execution in isolation. Compare a candidate index in a representative environment, include concurrent writes, and evaluate both query performance and storage/log impact. Query Store plan forcing may stabilize a regression while an index or query fix is developed, but forcing can become inappropriate after data or workload changes.

Missing-index DMVs and plan suggestions are hypotheses. They often produce overlapping indexes, ignore the maintenance cost, and may recommend a wide key or included-column set. Consolidate recommendations where the workload justifies it; inspect existing indexes, query predicates and execution plans. Do not create every missing-index suggestion on a production database. Capture the reason for each index and define a review criterion for removing it if usage or benefit changes.

## Automatic tuning options

Azure SQL automatic tuning can monitor workload behavior and, for supported configurations, recommend or automatically apply actions such as creating and dropping indexes or forcing a last known good plan. Exact options and availability depend on service, database, region and configuration. Review the current feature support and settings before enabling. Automatic tuning is an operational safety net, not autonomous schema design.

Automatic index management can use observed query patterns to suggest or apply index creation and removal. Its decisions depend on the workload history it has observed. Rare month-end reports, new customer behavior and infrequent maintenance queries may be underrepresented. Automatic index creation consumes storage and has write overhead; automatic drop decisions should be monitored for regressed queries. Use recommendations and the tuning history to understand the action taken and its measured result. Establish explicit alerting and rollback practices.

Automatic plan correction can identify plan regressions and force a prior plan in eligible cases. Treat the action as a mitigation with monitoring. The formerly better plan may no longer be suitable after statistics, schema, compatibility level or parameter distribution changes. Capture the Query Store evidence, verify application performance, and remove or revise the intervention when the root cause is corrected.

Automatic tuning options are configured at database scope in supported scenarios, and inheritence/default behavior can affect newly created databases. Explicitly set policy through deployment automation rather than relying on a portal default. Review recommendations after migrations and major workload changes. Some features require Query Store to be enabled and functioning; check capture state and storage limits.

## Testing a candidate index

A sound test includes the representative query, realistic parameters, concurrency and modification mix. Capture the actual execution plan, logical reads, CPU, duration, row estimates and Query Store history before and after. For `SET STATISTICS IO, TIME ON`, use a controlled test session and compare multiple runs; cache effects make a single warm run misleading. In production, roll out through a deployment window and observe write latency, storage growth, index usage and the target query's wait profile.

Be careful with index rebuilds and reorganizations. Managed service behavior and supported options may differ from self-managed SQL Server. Rebuilds can consume compute, IO, transaction log and temporary space; run them only when measured benefit justifies the resource cost. Azure's automated maintenance and automatic tuning may reduce routine manual work, but they do not eliminate the need to keep statistics and workload behavior healthy.

### Common mistakes

- Treating a missing-index suggestion as a complete design or a seek as proof of efficiency.
- Adding every output column to an index without accounting for write amplification and storage.
- Enabling automatic index management without monitoring actions and tenant-specific workload patterns.
- Using plan forcing as a permanent fix without reviewing the plan after the workload changes.
- Rebuilding all indexes on a schedule without checking fragmentation, resource impact or service guidance.

### Production notes

Keep an index inventory tied to query evidence and an owner. Start automatic tuning in recommendation mode if policy requires review, then enable selected actions after observing recommendations. Have a tested rollback strategy, but prefer removing the cause (query shape, statistics, schema or capacity issue) over indefinite intervention.

## Index lifecycle and change review

Treat an index as a deployed object with a purpose, owner and expected workload benefit. Before adding one, verify an equivalent key order or covering index does not already exist. After deployment, compare the intended query and its common variants while also checking write latency and storage. `sys.dm_db_index_usage_stats` can provide usage clues, but counters are resettable and a rarely executed compliance or month-end query may still be important. Do not drop an index solely because a short observation window shows no seeks. Coordinate schema changes with release pipelines and ensure rollback scripts account for dependent constraints and permissions. Automatic index suggestions should enter that same review process if the organization requires approval; an automated create is still a production schema change with resource effects.
