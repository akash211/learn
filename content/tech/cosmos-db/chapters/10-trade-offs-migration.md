# When Cosmos DB Is the Wrong Choice and Migration Away

Cosmos DB is a strong fit when its distribution model, managed operations, and partition-oriented access patterns solve a concrete problem. It is not the default destination for every JSON payload or every Azure application. The wrong fit may be a technical issue—cross-partition transactions dominate—or an economic issue—provisioned capacity sits idle while a relational database could serve the same workload more simply. Assess total system complexity, not a feature checklist.

## Signals to choose something else

A relational database is often better when the domain has many normalized entities with frequent joins, foreign-key integrity, multi-row invariants, ad hoc SQL queries, or reporting needs that change often. Cosmos DB can query JSON and execute scoped transactions, but routinely scattering a relational workflow across containers or partitions can turn a simple business operation into multiple requests, orchestration, and reconciliation. Azure SQL Database or managed PostgreSQL may provide a more direct model and broader relational ecosystem.

A small workload with predictable low demand may not justify provisioned RU/s, multi-region design, and capacity monitoring. A simple key-value store, Azure Table Storage, or an existing application database may be cheaper and easier, depending on requirements. At the other extreme, large analytical scans, arbitrary exploratory joins, long-running reporting, and complex transformations belong in an analytical platform rather than the operational store. Change feed or analytical integrations can move data, but they do not turn an OLTP container into a warehouse.

Do not choose a compatibility API because the product name sounds familiar. If the application depends on advanced MongoDB features, server extensions, or operational tooling, test each feature against the exact Cosmos API and consider Azure DocumentDB or another MongoDB-compatible service where appropriate. Likewise, Azure Cosmos DB for PostgreSQL is on a retirement path; PostgreSQL use cases should be assessed against Azure Database for PostgreSQL Elastic Clusters and current migration guidance, not a legacy service description.

## Model total cost, not just request rates

A useful cost model separates steady state, peak, and exceptional capacity. Include provisioned or autoscale throughput at each scope, storage, number of regions, backup and retention options, request mix, indexing overhead, background consumers, and nonproduction environments. Add costs from data movement, logging, networking, and downstream projections where applicable. Calculate with current regional pricing rather than remembered RU prices. Evaluate utilization over real traffic cycles: a low monthly average may hide brief peaks that require capacity or an autoscale maximum.

Cost should also include engineering time. A single hot key requiring synthetic partitioning, fan-out queries, cache layers, and manual reconciliation may cost more to operate than a slightly higher database invoice elsewhere. Conversely, a globally distributed workload may avoid substantial self-managed replication work. Compare costs at equivalent availability, latency, durability, and recovery objectives; a one-region relational database is not a like-for-like comparison with a multi-region Cosmos design.

Use the Azure pricing calculator and current service documentation with explicit assumptions for throughput mode, regions, storage, backups, and account configuration. Reconcile estimates against bills after a representative pilot. Set budgets and alerts, but don't rely on alerts as the sole control for a runaway request pattern.

## Migration away: safe sequence

A migration begins with semantics, not a dump command. Inventory containers, partition keys, data volume, item shapes, TTL, indexing policies, consistency assumptions, stored procedures, change-feed consumers, and application query patterns. Map each invariant to a target database capability. Identify differences in numeric precision, null and missing values, case sensitivity, timestamps, ordering, uniqueness, and transaction scope. Decide which system is authoritative during transition.

Design the target schema and indexes to match measured access patterns. For a relational target, choose normalized tables, keys, constraints, and transactions; for another document store, verify document boundaries and partition behavior. Build a repeatable, idempotent extraction and load process with checkpoints, rate limits, and backpressure. Preserve IDs and business keys deliberately; avoid assuming Cosmos internal metadata fields are portable.

To minimize downtime, take a consistent snapshot or establish a change-capture boundary, backfill in restartable batches, and capture concurrent writes. Cosmos DB's change feed can support certain migration patterns, but mode, delete handling, retention, partition ordering, and target writes must be validated. Dual-write designs can diverge; if used, define ownership and reconciliation. Replay changes to the target, compare counts and business aggregates, run shadow reads, and reconcile edge cases. Shift traffic gradually behind a rollback mechanism. Do not declare success based only on row counts.

After cutover, monitor errors and latency, retain a rollback window consistent with data retention policy, and ensure writes are no longer split unpredictably between old and new authorities. Verify backups and restores on the target. Only decommission the Cosmos resources after consumers, change-feed processors, scheduled jobs, and dashboards have been accounted for and data-retention obligations are met.

## Common mistakes

- Choosing Cosmos DB because a request body is JSON without estimating data access and transaction patterns.
- Comparing only monthly database bills rather than equivalent reliability, regionality, and engineering effort.
- Ignoring preview or retiring product status when selecting an API.
- Backfilling while writes continue without a consistent snapshot/change-capture strategy.
- Switching traffic before checking semantic equivalence, deletes, and business-level reconciliations.

## Production notes

A migration plan should list the source of truth, cutover gate, rollback trigger, data validation queries, write capture, and retirement checklist. Test a full restore and a failed cutover. Keep the decision record honest about features the target does not reproduce and any temporary application behavior needed during transition.

## Decision record and exit criteria

A sound architecture decision record lists the workload assumptions that make Cosmos DB attractive: geographic distribution, target latency, request rates, partition-key availability, data growth, consistency, and acceptable transaction scope. It should also name the alternatives considered and why they were not selected. Revisit the decision when the workload changes from tenant-local operations to cross-tenant analytics, when a large tenant dominates capacity, or when region requirements change. A database can be right for one service and wrong for another in the same system.

For migration, define exit gates before work begins. Examples include reconciliation of key business totals, correctness of deletes and updates during backfill, performance at peak volume, verified target backups, and a completed rollback rehearsal. Choose a cutover interval with named owners and a freeze or dual-write policy. If a rollback occurs after the target has accepted writes, define how those writes are returned to the source; a traffic switch alone does not restore a consistent source of truth.

Finally, remove operational dependencies deliberately. Stop and verify old change-feed processors, scheduled jobs, reporting extracts, alert rules, and credentials. Retain only the data required by retention and audit obligations, then decommission capacity and access in a controlled sequence. Record final data validation and deletion approval. These steps prevent a technically complete migration from leaving behind active consumers, unexpected charges, or ambiguous ownership of new writes.
