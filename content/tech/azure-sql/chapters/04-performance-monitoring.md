# Performance Monitoring and Diagnosis

Performance diagnosis starts by separating symptoms from causes. A slow request may reflect an expensive plan, resource throttling, blocking, an unavailable connection, increased network latency or an application queue. Azure SQL Database provides several complementary views: Query Store preserves query and plan history; database-scoped dynamic management views expose live and cumulative engine state; Azure Monitor shows resource metrics over time; Intelligent Insights can identify certain abnormal database behavior. No single chart or DMV is a complete explanation.

## Query Store as query history

Query Store captures query text, plans and runtime statistics in the database. It survives plan-cache eviction and helps compare query behavior across time windows and plan changes. Enable and configure Query Store for the database, set a sensible capture mode and size/retention policy, then monitor whether it is read-write or has stopped capturing due to space or settings. Query Store is particularly useful for finding top resource consumers and plan regressions around a deployment, statistics update or workload change.

Use Query Store reports in the portal or query its catalog views such as `sys.query_store_query`, `sys.query_store_plan`, `sys.query_store_runtime_stats` and `sys.query_store_wait_stats` where available. Aggregate carefully: runtime statistics are interval-based, and average duration alone can obscure variance, concurrency and parameter skew. Compare execution counts and resource use over comparable windows. Look at plans and wait categories together; a query with more duration may simply have run during a different load or blocking event.

Plan forcing can provide a temporary mitigation when a known plan was better. Validate that the old plan is appropriate for current parameters and data, monitor forcing failures, and continue to find the root cause. Query Store hints and automatic plan correction behavior depend on service configuration and support. They are not substitutes for reviewing the query, schema and index design.

## Intelligent Insights and Azure Monitor

Intelligent Insights analyzes database workload signals and can report performance problems and suggested causes when the feature detects relevant patterns. It is a useful lead, not an oracle: validate its observation against Query Store, waits, application telemetry and the actual plan. The service cannot know every business-specific latency objective or correctness constraint.

Azure Monitor metrics provide time series for CPU, data IO, log IO, storage and other resource signals. Metric names, dimensions and sampling behavior vary by resource and configuration. Diagnostic settings export supported logs and metrics to Log Analytics, Storage or Event Hubs. Retention and access controls matter: telemetry can contain query or identity information depending on the source and settings. Set alerts on sustained resource saturation, storage growth, connection failures and application-relevant signals, not only on a service health indicator.

Correlate resource metrics with deployment events, scheduled jobs, traffic, Query Store intervals and application traces. If CPU is elevated, identify whether execution is query CPU, compilation, concurrency or a different task. If data IO is constrained, inspect physical reads, plan shape and cache behavior. If log IO is high, inspect write rate, transaction size and durability requirements. A resource metric tells where pressure appears; it does not automatically tell which query or code change caused it.

## DMVs, waits and live requests

Database-scoped dynamic management views expose useful telemetry without requiring operating-system access. Examples include `sys.dm_exec_requests` for active requests, `sys.dm_exec_sessions` for sessions, `sys.dm_exec_query_stats` for cached plan statistics, and database-scoped resource statistics views. Availability and permissions depend on the service tier, database and role. Query plans and cache DMVs are transient: their contents can reset after failover, service events or cache eviction. Query Store is better suited to durable historical comparison.

A live triage query can join requests to session and SQL text metadata. Use a bounded query and be mindful that introspection itself consumes resources. Do not expose query text or parameter values in general logs without considering sensitive data. For waits, use the relevant database-scoped wait statistics view where available, or Azure Monitor and Query Store wait statistics. Wait categories such as CPU scheduling, locks, log writes or IO point to different hypotheses. A wait is time spent waiting, not necessarily a defect. Compare deltas over a known interval and normalize for database uptime and workload.

Example of inspecting active requests:

```sql
SELECT r.session_id, r.status, r.wait_type, r.wait_time,
       r.blocking_session_id, r.cpu_time, r.logical_reads,
       SUBSTRING(t.text, (r.statement_start_offset / 2) + 1,
         ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(t.text)
           ELSE r.statement_end_offset END - r.statement_start_offset) / 2) + 1) AS statement_text
FROM sys.dm_exec_requests AS r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) AS t
WHERE r.session_id <> @@SPID;
```

This example is a snapshot, not an incident history. A query can complete before it is sampled, and permissions may restrict visibility. Use Query Store, application traces and Azure monitoring for a fuller timeline.

## Resource governance and triage sequence

Azure SQL has service-specific resource governance. If a database reaches a limit for CPU, IO, workers, sessions or another resource, requests may slow or be rejected. Identify the saturated metric and time window; do not infer that all resource exhaustion is “CPU.” Check whether utilization belongs to one query, a workload burst, maintenance, or a pool neighbor. In elastic pools, examine both pool and per-database signals.

A disciplined triage sequence is: confirm user-visible impact and scope; correlate application latency and error rates with Azure metrics; use Query Store to find changed queries or plans; inspect current requests and waits; capture representative actual plans and parameter behavior; test a focused remediation; and measure the same signals after the change. Preserve evidence before forcing plans, changing compatibility settings or scaling, since those actions can erase or alter the condition being diagnosed.

### Common mistakes

- Using one instantaneous DMV snapshot as a historical explanation.
- Treating a wait name as a diagnosis without query, resource and workload context.
- Looking only at average duration and ignoring executions, percentiles, waits and parameter skew.
- Assuming Intelligent Insights recommendations replace verification or load testing.
- Scaling the database without confirming whether the bottleneck is CPU, data IO, log IO, blocking or application saturation.

### Production notes

Enable Query Store and diagnostic export as part of provisioning, define retention and access controls, and test alert delivery. Build dashboards that link application requests to database query identifiers where supported. Keep a repeatable incident worksheet with observation window, database resource ID, query identifiers, waits, plan IDs, deployment events and the resulting test.

## Build a useful signal chain

For recurring incidents, connect application operation IDs to SQL query identifiers where the driver and tracing stack allow it. Keep a bounded diagnostic collection with request start, connection acquisition, command start/end, retry count and outcome. On the database side, capture the resource ID and Query Store interval rather than only a screenshot of a portal graph. This gives an operator a way to distinguish a slow query from a slow connection path. Establish an ordinary baseline by day of week and workload cycle; maintenance and batch windows often create legitimate peaks that should not page the team. Review alert thresholds after a change in tier, traffic or pool membership, because an old threshold may become noisy or cease to provide warning.
