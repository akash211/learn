# tempdb, Waits and Performance Triage

tempdb is a shared system database recreated at startup. It stores temporary tables and table variables, worktables for sorts and hashes, row-versioning data, and internal objects. Because workloads share it, a tempdb incident can affect otherwise unrelated sessions. Diagnose what is consuming space and which wait is actually limiting progress before resizing files or changing query hints.

## tempdb allocation and configuration

User objects include local and global temporary tables; internal objects include sort and spool workfiles. Version stores hold row versions for snapshot-based isolation and other features. On systems with Accelerated Database Recovery, a persistent version store is associated with the user database rather than the traditional tempdb version store for ADR's versions. `sys.dm_db_file_space_usage` reports allocation categories for tempdb. `sys.dm_db_session_space_usage` and `sys.dm_db_task_space_usage` help attribute allocations, though task data and timing need careful interpretation.

Multiple equally sized tempdb data files can reduce allocation contention under concurrent workloads, especially when PFS, GAM or SGAM pages are hot. Start with a reasonable number based on observed contention and CPU count, then measure; adding many files by rote can complicate operations and does not fix query spills. Pre-size files consistently and use sensible growth increments. The log file has different access patterns and is not multiplied like data files.

## Wait statistics as evidence

Waits show where tasks spent time waiting, but cumulative instance totals need a baseline and context. `sys.dm_os_wait_stats` accumulates since startup or reset. Compare snapshots over a representative interval and filter out benign background waits using a documented, version-appropriate approach. Do not clear counters on production just to make a dashboard look clean.

```sql
SELECT TOP (20) wait_type, waiting_tasks_count,
       wait_time_ms, signal_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type NOT LIKE 'SLEEP%'
ORDER BY wait_time_ms DESC;
```

A high wait count is not itself the bottleneck. `PAGEIOLATCH_*` often indicates waiting for data pages from storage, while `WRITELOG` may point to log flush latency or transaction patterns. `LCK_M_*` is a lock wait; `RESOURCE_SEMAPHORE` means a query is waiting for a memory grant; `SOS_SCHEDULER_YIELD` may indicate CPU pressure but needs corroboration. `CXPACKET` and `CXCONSUMER` are parallel exchange waits and are not automatically defects. Waits should lead to a workload hypothesis that can be checked against query and I/O evidence.

## A disciplined triage sequence

First establish scope: one query, one database, all sessions, a recent deployment, or a host-wide slowdown? Check current requests in `sys.dm_exec_requests`, their wait type, blocker, CPU, elapsed time and reads. Check blocking chains rather than looking only at a single blocked request. Use `sys.dm_os_waiting_tasks` for live waits and Query Store for historical query runtime and plan changes.

Then distinguish resource saturation from inefficient work. High CPU with low I/O suggests expensive computation, poor cardinality or excessive concurrency. High logical reads point toward too much data being examined, which may require query or index changes. High physical I/O and `PAGEIOLATCH` calls for examining file latency, cache churn and scan volume. `WRITELOG` with many tiny transactions may improve through sensible batching, but one must preserve the application’s transaction semantics. Frequent spills call for inspecting actual memory grants and estimates, not simply raising global memory limits.

`sys.dm_io_virtual_file_stats` gives per-file cumulative I/O counts and stalls. Sample it twice, subtract values and calculate average latency for reads and writes. Averages hide outliers, so pair them with workload timing, storage telemetry and query-level evidence. For tempdb usage, check `sys.dm_db_file_space_usage`; for file and log state, use `sys.database_files`, `sys.dm_db_log_space_usage` and `DBCC SQLPERF(LOGSPACE)` where suitable.

## Production notes

Extended Events can capture deadlocks, long-running queries, spills and errors with less overhead than broad tracing. Use a narrow event session, bounded event-file targets and appropriate retention. Query Store is typically the first stop for regressions because it preserves query and plan history, subject to its capture and storage settings. DMVs often reset on restart or failover, and permissions vary; capture baselines if trend history matters.

## Common mistakes

- Adding tempdb files without evidence of allocation contention.
- Sorting lifetime wait totals and optimizing the largest number without an interval or workload context.
- Treating one wait name as a complete diagnosis, such as assuming every `PAGEIOLATCH_SH` means a slow disk.
- Running `DBCC FREEPROCCACHE` or clearing buffers to reproduce a performance issue on a live system.
- Using `NOLOCK` or arbitrary `MAXDOP` changes as broad first-line fixes.
- Increasing memory grants globally when inaccurate estimates or query shape is the actual source of spills.


## Attribute tempdb consumption before changing configuration

A tempdb alert has several possible causes: explicit temporary objects, internal worktables for sorts and hashes, row-version retention, or allocation-page contention. These are different failure modes and need different evidence. Start with `sys.dm_db_file_space_usage` for total allocations by user objects, internal objects and version stores. Use `sys.dm_db_session_space_usage` and `sys.dm_db_task_space_usage` to find sessions or tasks with allocations/deallocations, understanding that counters can update at task completion and a snapshot may miss short-lived consumers. A session that allocated space may already have completed, so correlate with active requests, plans and captured telemetry.

```sql
USE tempdb;
SELECT SUM(user_object_reserved_page_count) * 8 AS user_object_kb,
       SUM(internal_object_reserved_page_count) * 8 AS internal_object_kb,
       SUM(version_store_reserved_page_count) * 8 AS version_store_kb,
       SUM(unallocated_extent_page_count) * 8 AS free_kb
FROM sys.dm_db_file_space_usage;
```

The values are page-based and reported for the current moment. Under ADR, persistent version store space is associated with the user database; examine the relevant database-level DMV and ADR configuration rather than expecting all versions in tempdb. Long transactions may prevent version cleanup. An actual-plan spill warning and memory grant details point toward sort/hash spills; tune estimates, plan shape or concurrency rather than blindly adding files. If allocation waits indicate PFS/GAM/SGAM contention, then tempdb data-file configuration may help. Multiple equal-sized files are a starting point, not a fixed formula; verify contention and workload after change.

## Wait statistics: use deltas and corroboration

Wait totals are cumulative and may cover weeks of mixed workload. Capture two snapshots of `sys.dm_os_wait_stats`, calculate deltas over a representative interval, and record uptime, workload and recent changes. Avoid resets on production; they destroy context and make dashboards incomparable. `signal_wait_time_ms` is time ready to run after the resource wait, which may help distinguish scheduler pressure from time waiting on the resource, but is not a standalone CPU diagnosis. Filter benign waits with a documented list appropriate to the version, while retaining the raw capture.

For `PAGEIOLATCH_*`, compare interval file stalls with physical read volume, `STATISTICS IO`, plans and host telemetry. Many reads at healthy latency indicate excess work; high latency on modest reads may indicate storage queueing or a broader infrastructure issue. For `WRITELOG`, inspect log flush latency and transaction rate. `LCK_M_*` calls for a blocker chain and transaction age; `RESOURCE_SEMAPHORE` for grant pressure; `SOS_SCHEDULER_YIELD` for CPU and runnable queue evidence. `CXPACKET`/`CXCONSUMER` require plan and distribution context. The wait is a breadcrumb, not the root cause.

A strong incident report states impact, interval, affected workload, top corroborated evidence, likely mechanism, reversible mitigation and follow-up measurement. Query Store can connect plan/runtime changes to the incident; Extended Events can capture narrowly scoped spills, deadlocks or long statements. Preserve baselines and avoid disruptive experiments such as clearing buffers or the plan cache on a live instance.
