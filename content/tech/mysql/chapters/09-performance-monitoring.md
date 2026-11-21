# Performance Schema and Monitoring

MySQL performance work begins with observation, not configuration changes. Performance Schema instruments server activity, while the `sys` schema provides more approachable views built from those measurements. Together with the slow query log, global status counters, and operating-system metrics, they help distinguish expensive statements, lock contention, disk pressure, and replication delay. Collection itself has overhead and retention constraints, so monitor the monitoring configuration too.

## Performance Schema and sys

Performance Schema is a source of low-level instrumentation for statements, waits, stages, memory, locks, and table activity. It is enabled by default in modern MySQL 8.0 configurations, but instrumentation and consumers can be configured. `sys` views such as statement summaries aggregate normalized statement digests and expose execution counts, time, rows examined, and latency indicators.

```sql
SELECT *
FROM sys.statement_analysis
ORDER BY total_latency DESC
LIMIT 10;

SELECT * FROM performance_schema.data_lock_waits;
```

A digest groups similar statements while removing literal values, which makes it possible to see query shapes rather than one log line per parameter. A high total latency can indicate a frequently executed statement with moderate individual latency; the worst maximum latency may reveal a different issue. Examine count, average, percentile samples if available in the collection system, rows examined, rows sent, and temporary work together. Avoid publishing sensitive SQL values into monitoring dashboards or logs.

Performance Schema is not necessarily a long-term time-series database. Export selected counters and statement summaries to a monitoring system, preserving interval deltas and reset/restart context. A cumulative counter must be differenced over a known interval before calling it a rate. Check instrumentation settings after upgrades and compare enabled consumers against overhead and diagnostic needs.

## Slow query log and pt-query-digest

The slow query log records statements that exceed `long_query_time`, and can include statements that examine many rows even if they execute quickly depending on configuration. It is a practical source for discovering slow SQL patterns absent from application tracing. Set thresholds based on the workload and control log growth, permissions, rotation, and retention. Query text can contain sensitive literals, so handle it as production data.

Percona Toolkit's `pt-query-digest` parses slow logs and summarizes normalized query classes by count, latency, rows examined, and other metrics. It helps rank work for tuning and compare report intervals. It does not tell you the correct index by itself: pair its digest with schema, `EXPLAIN`, representative parameter values, and actual execution. Confirm tool compatibility and installation policy for your environment, especially on managed databases where log access is mediated.

## Locking and waits

Wait events explain time that query duration alone cannot. `performance_schema.data_locks` and `data_lock_waits` identify active InnoDB lock holders and waiters in supported 8.0 releases. Metadata locks can also make DDL wait behind a long-running transaction or query. The `sys` schema includes views for lock waits and statement analysis; inspect them while the incident is occurring because transient waits disappear.

Separate CPU-bound query execution from storage stalls, mutex contention, lock waits, and client-side queueing. High connection count may indicate slow database work or an application pool that opens more sessions than it can use. More connections can worsen contention and memory pressure rather than increase throughput. Correlate server metrics with pool wait time and application traces.

## A useful monitoring set

Monitor query latency and throughput, connections and thread activity, buffer-pool reads and dirty pages, redo generation and flush pressure, row-lock and metadata-lock waits, deadlocks, temporary-table spills, disk latency and free space, binlog and relay-log growth, and replica apply lag. Track transaction age and backup completion. Establish workload-specific baselines and alert on sustained deviations rather than an isolated counter threshold.

Global status counters are cumulative since server start or reset. Sample them at intervals and compute deltas; resets, failovers, and server restarts need to be represented in the monitoring system. Use `SHOW ENGINE INNODB STATUS\G` for diagnostic context, but do not build alerting around manual parsing of its unstructured text when stable metrics exist.

## Incident workflow and capacity signals

When latency increases, start with the time window and affected scope: one statement, one tenant, all writes, or only replica reads. Check deploys, traffic, connection-pool queueing, and host-level CPU, memory, and storage metrics. Use statement digests to find changes in count, total latency, rows examined, or temporary work. Compare the query plan and parameter distribution with a normal interval. A sudden increase in lock waits points to contention; a rise in physical reads can indicate a working-set shift or plan regression; rising connection threads with high pool wait suggests overload or backpressure.

Preserve snapshots of ephemeral state: active transaction age, blocking sessions, replication progress, and current InnoDB status. Use Performance Schema to identify lock and wait relationships, but avoid running expensive diagnostic queries repeatedly on a saturated server. Capture evidence before killing sessions or changing configuration. If a single transaction is blocking critical traffic, coordinate its rollback and monitor the consequences instead of indiscriminately terminating connections.

Define service-level indicators for query latency percentiles, successful transaction rate, lock-wait time, replica freshness, and restore readiness. Alert on sustained error-budget impact and capacity exhaustion, not every small counter movement. Ensure monitoring includes the database exporter itself, credentials, scrape freshness, and high-cardinality controls. Keep dashboards for both per-statement detail and aggregate service health; a single database-wide average hides tenant skew.

Changes to buffer-pool size, parallel workers, or durability settings should be tested with a repeatable workload and a rollback plan. Some variables are dynamic, others require restart or provider maintenance. Record the before-and-after value, effective scope, server version, and observed effect. Re-check after failover because replicas may not have identical settings or performance characteristics.

Query-level telemetry must be interpreted with privacy and cardinality in mind. Literal values in logs can reveal account identifiers or tokens, while adding a unique label per tenant can create an unbounded metrics series. Normalize statements for aggregation, redact sensitive data where supported, and keep detailed logs in restricted systems with bounded retention. Dashboards should expose a path from aggregated digest to a protected trace or log sample without making the broadest audience see raw customer values.

For operational readiness, rehearse a query regression, lock incident, replica outage, and storage-pressure alert. Confirm the dashboard shows enough evidence to answer who is blocked, which application pool is involved, and whether replicas can serve current reads. Review alert thresholds after workload shifts and failovers; a stable threshold can become noisy when traffic or server role changes. Monitoring is part of the recovery system, so keep it available when the primary database is unhealthy.

## Production notes

- Test that slow-log rotation and Performance Schema exporters keep working after server upgrades.
- Use least privilege for monitoring accounts and restrict access to query text.
- Keep an incident timeline linking DB metrics, application traces, deployments, and traffic changes.
- Use Percona Toolkit utilities such as `pt-query-digest` for analysis, not as a substitute for evidence or change testing.

## Common mistakes

- Looking only at CPU or only at query average latency while ignoring waits and tail behaviour.
- Comparing cumulative counters from different uptime periods without resetting or differencing them.
- Enabling every instrument indefinitely without measuring overhead or cardinality.
- Treating a query digest's ranking as proof of the correct index or root cause.
- Increasing connection limits to hide an overloaded or poorly pooled application.
