# Execution Plans and the Optimiser

SQL Server's query processor parses and binds T-SQL, then the cost-based optimiser explores alternative logical and physical plans. It estimates cardinalities, assigns costs and chooses a plan expected to be economical. The chosen plan is not a promise of minimum elapsed time; it is the result of estimates, available indexes, constraints, configuration and optimisation time.

## Read the plan as a data-flow graph

Execution plans are commonly displayed from right to left, but the arrows represent rows flowing between operators. A seek or scan accesses data; joins combine streams; sort, hash aggregate and spool operators may consume memory or tempdb. Operators are not intrinsically good or bad. A scan of a small table can be optimal, and a nested loops join can be excellent when its outer input is small and the inner side has a suitable index.

Estimated plans show compile-time assumptions. Actual plans include runtime row counts and execution details. Compare estimated and actual rows at the earliest operator where they diverge substantially. Downstream operators inherit estimation errors: an underestimated join input can lead to nested loops doing repeated work, while an overestimate can choose a memory-heavy hash join. Also check executions, rebinds/rewinds, spills, warnings and actual I/O rather than judging only the icon names.

```sql
SET STATISTICS IO, TIME ON;
-- Run the representative query with its real parameter values.
SET STATISTICS IO, TIME OFF;
```

`SET STATISTICS IO` reports logical and physical reads by object; `SET STATISTICS TIME` reports CPU and elapsed time. Capture an actual plan carefully on production because profiling has overhead and may expose sensitive values. Query Store stores query, plan and runtime history with far less need to reproduce an issue manually.

## Statistics and cardinality

Statistics describe value distributions through a histogram on the leading statistics column, density information and sampling metadata. SQL Server creates and updates statistics automatically under configuration rules, but large or skewed tables, correlated columns and fast-changing data can leave estimates inaccurate. `UPDATE STATISTICS` and `CREATE STATISTICS` can help, but forcing frequent full scans has its own cost. Inspect `sys.stats`, `sys.dm_db_stats_properties` and the plan's estimated versus actual rows before taking action.

The optimiser's cardinality estimator changes across compatibility levels. A database's compatibility level can affect query processing even on a newer engine. Compare changes with Query Store, and do not change compatibility simply to solve one query regression. Parameter-sensitive data distributions create another problem: a plan compiled for a rare customer may be poor for a customer with millions of rows. This is parameter sniffing, which is normal parameter-aware compilation becoming a workload mismatch.

Use Query Store to find plan regressions and assess whether different parameter populations need different plans. Depending on version and compatibility level, Parameter Sensitive Plan (PSP) optimization can maintain multiple plan variants for parameter ranges. Other options include statement recompilation, `OPTIMIZE FOR`, dynamic SQL, or separate query paths, each with trade-offs. Query hints should be a deliberate, monitored intervention, not a first guess.

## Memory grants, spills and parallelism

Sorts and hash operators request a memory grant based on estimates. Too small a grant can spill intermediate data to tempdb, increasing I/O and latency; too large a grant can reduce concurrency by reserving memory other queries need. Actual plans show spill warnings and granted/used memory. Query Store wait and runtime data can help distinguish a one-off spill from a repeated workload problem.

Parallel plans distribute work across workers, but parallelism has coordination and exchange costs. `CXPACKET` and `CXCONSUMER` waits are not automatically evidence of a problem. Look for the query, skewed work distribution, CPU pressure and elapsed versus CPU time. Instance-wide settings such as `MAXDOP` and cost threshold for parallelism should be based on workload and NUMA/CPU topology, not copied blindly.

## Production diagnostics

`sys.dm_exec_query_stats` contains aggregate statistics for cached plans and loses entries when plans leave cache. Join `plan_handle` to `sys.dm_exec_query_plan` and `sql_handle` to `sys.dm_exec_sql_text` to inspect cached statements. Query Store is generally a better historical source. DMVs are volatile views, and different SQL Server versions or Azure services may require different permissions and expose different data.

## Common mistakes

- Treating the highest estimated-cost operator as the cause of elapsed time; the cost model is relative and estimates may be wrong.
- Reading an estimated plan as if it contained actual cardinalities or runtime spills.
- Assuming every scan is bad and every index seek is good; a seek plus millions of key lookups can be worse than a scan.
- Clearing the plan cache to fix parameter sniffing, causing a broad compile storm and making diagnosis harder.
- Changing compatibility level or adding hints without using Query Store to compare plans and runtime.
- Treating every parallelism wait as a bug instead of identifying the query and bottleneck.


## Parameter sensitivity: diagnose before choosing a remedy

Parameter sniffing describes compilation using parameter values available at compile time; it is not inherently a defect. The problem appears when one cached plan is reused across materially different cardinalities. For example, a tenant predicate may return 20 rows for most tenants and several million for one tenant. A nested-loops plan with seeks may excel for the small tenant and perform enormous repeated work for the large one. A hash join or scan might suit the large tenant but waste resources for small tenants. Compare actual parameter values, estimated and actual rows, logical reads, CPU, duration and plan shape across both populations.

Query Store is usually the best starting point for historical regressions: identify query IDs, plan IDs, runtime intervals, waits and the deployment or statistics event. Cached-plan DMVs such as `sys.dm_exec_query_stats` are useful for live aggregate evidence but can disappear when a plan is evicted and do not give a full parameter history. Capture actual plans safely because they can contain sensitive literals and profiling overhead. Check whether the estimation error begins at a predicate, join or correlated expression; a later mismatch may only be downstream fallout.

SQL Server 2022 Parameter Sensitive Plan optimization can create a dispatcher and multiple variants for eligible parameter-sensitive statements, at the required compatibility level. It does not apply to every query and should be verified in Query Store and plan metadata. On earlier versions, or for ineligible patterns, options include `OPTION (RECOMPILE)` for per-execution optimization, `OPTIMIZE FOR` a chosen value, `OPTIMIZE FOR UNKNOWN`, a controlled dynamic-SQL shape, or separate code paths. Recompile trades plan reuse for compile CPU. A fixed optimization value can merely move the skew problem. Dynamic SQL can preserve parameterization but must be safely constructed and monitored. Choose based on the actual distribution and compile rate, not folklore about “sniffing.”

## Read a plan from evidence to action

Use a disciplined sequence: locate the first consequential estimate/actual-row divergence; inspect predicate selectivity and statistics; identify repeated executions and lookup counts; check memory grants and spill warnings; then compare logical reads, CPU and elapsed time. A seek can be expensive when it drives many key lookups, and a scan can be optimal for a large fraction of a table. A sort or hash warning may indicate bad estimates, insufficient grant, skew, or simply a large unavoidable operation. `SET STATISTICS IO, TIME ON` plus an actual plan gives query-level measurements; Query Store provides history and comparison.

`sys.dm_exec_query_plan` returns cached plan XML, while `sys.dm_exec_text_query_plan` can expose statement-level text plans for a plan handle and statement offsets. Showplan warnings and properties are version-dependent. Plan forcing can mitigate a regression temporarily, but forcing a plan that was good under a different parameter distribution can worsen performance. Use Query Store forcing failures and runtime monitoring, record why the mitigation exists, and remove or revise it after the underlying change is understood. Do not clear the whole plan cache to “fix” one parameter-sensitive statement; that discards evidence and may create a compile storm.
