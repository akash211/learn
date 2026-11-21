# Vacuum, Analyze, and Maintenance

Redshift maintenance is about keeping physical order, deleted-row space, and planner statistics usable. It differs from PostgreSQL: commands with familiar names do not necessarily have equivalent behavior, and Redshift already performs background automatic maintenance. A safe operator measures table state and workload impact before scheduling manual work.

## Vacuum and sort order

As new rows arrive, they are not necessarily placed in final sort order. Updates and deletes also create work for storage and query execution. If a table's sort order degrades, a predicate on the sort key may skip fewer blocks. `VACUUM` can restore order and reclaim space marked by deletes. The default `VACUUM` operation is effectively `FULL`: it sorts and removes deleted rows, though Redshift can skip sorting when enough rows are already sorted. This is not PostgreSQL's plain vacuum behavior, so do not carry over assumptions from an OLTP system.

Redshift automatically sorts data and performs delete-only vacuum work in the background. Manual vacuum is therefore not a daily ritual to run blindly. Before scheduling it, inspect `SVV_TABLE_INFO` for unsorted rows, deleted rows, and table characteristics; check query plans and performance; and identify whether background maintenance is keeping up. A vacuum competes for system resources with user queries, and concurrent updates or deletes can take longer. `VACUUM DELETE ONLY` can temporarily block update and delete operations while it works.

The command offers modes such as `SORT ONLY`, `DELETE ONLY`, `REINDEX`, and `RECLUSTER` in applicable cases. Interleaved sort keys may require reindexing to restore their effectiveness. `RECLUSTER` targets recently added unsorted data in supported cases rather than fully sorting every row. Choose a mode based on measured state and current feature support, not on the most forceful option by default. Running a full sort can be expensive; schedule it around workload windows and verify the effect afterward.

## Analyze and optimizer statistics

`ANALYZE` updates table statistics used to estimate row counts and choose join strategies. After a large load, delete, or data-distribution change, stale statistics can make the optimizer choose a poor join order, underestimate an intermediate result, or broadcast a relation that is no longer small. Redshift automatically analyzes tables under appropriate conditions, and some table-creation commands analyze their outputs. Automatic behavior is useful but should be checked for critical tables and after major data changes.

The analyze threshold controls whether a table with a small fraction of changed rows is skipped. Predicate-column analysis can focus on columns used in filters, joins, grouping, distribution, or sorting. A targeted refresh can be useful after an important load:

```sql
ANALYZE sales PREDICATE COLUMNS;
```

Do not analyze system tables; they are maintained by the service. External tables are not analyzed using the same command. Materialized views can be analyzed, with restrictions compared with ordinary tables. Statistics quality is not the same as row count freshness: check whether the columns central to a plan have meaningful statistics and whether the table changed substantially since the last update.

## Operational workflow

A practical maintenance loop begins with workload evidence. Use `STL_QUERY` and `STL_QUERY_SUMMARY` or `SVL_QUERY_SUMMARY` for provisioned query history, and use supported `SYS` monitoring views for a unified view that includes serverless where applicable. Use `SVV_TABLE_INFO` to relate slow scans to sort and table state. `STV_` views show current state rather than durable history; `STL_` views are persisted logs with bounded retention. Their visibility can depend on user privileges, so avoid granting broad system-log access casually.

For each candidate table, record the current query baseline, inspect its size and maintenance indicators, run the least disruptive suitable action, then compare relevant queries and metadata. Avoid running `VACUUM` and large loads concurrently without understanding their interaction. If maintenance takes longer than expected, inspect progress and resource contention before adding more maintenance jobs. A job that completes eventually but continually consumes capacity during the busiest hours is not a healthy schedule.

## Loads, deletes, and design

Maintenance can be reduced by changing the pipeline. Load data in a useful order when feasible, batch inserts through `COPY` rather than issuing many tiny statements, and avoid repeated large deletes when an append-and-retain or partitioning-like design is viable. Redshift does not use PostgreSQL-style table partitions for ordinary user tables; lifecycle management may instead involve staging tables, table swaps, or deleting older data in controlled batches. Choose a retention method that fits the table's query and operational requirements.

Materialized views add a dependency: vacuuming base tables can preserve rows needed for incremental refresh of stale dependent views. Refresh affected views before vacuuming when incremental refresh matters, or consider `VACUUM ... FORCE` only after understanding that stale views may need full recomputation. This makes view refresh cadence part of storage maintenance, not merely a BI concern.

## A maintenance runbook

A runbook should define what evidence triggers manual maintenance and what success looks like. For a critical table, capture the current `SVV_TABLE_INFO` values, recent load and delete volume, the last analyze time if available, and a few representative query plans. Check whether automatic maintenance is active or paused by concurrent DDL, and whether the table is a base relation for materialized views. Record the business window in which vacuum or analysis can consume resources.

For a large load, first confirm whether `COPY` or CTAS already triggered analysis and whether the changed-row threshold will cause automatic work. If key value frequencies changed materially, a targeted `ANALYZE` may be warranted even when the table's total change percentage appears modest. Then observe the plan estimates for the affected workload. For vacuum, identify whether the problem is unsorted rows, deleted-row space, or interleaved-key health; the correct mode depends on the cause. Monitor progress and concurrency, and do not stack manual operations blindly when one is already running.

After maintenance, compare the same plans and execution metrics under comparable conditions. An improved metadata value is not itself proof of a user-visible benefit. If no query or operational indicator improves, reconsider whether the action addressed the bottleneck. Keep a log of recurring maintenance duration and the volume of rows changed: a rising duration can reveal a pipeline or table-design issue before users report performance degradation.

Automatic maintenance is a capacity consumer, not an invisible free operation. When a cluster's workload is persistently busy, background sort or delete work may take longer to converge. A recurring backlog can indicate that loads or deletes are too frequent, or that a table is repeatedly being changed in ways that undo its physical organization. Address the source pattern as well as the backlog.

## Common mistakes

- Assuming Redshift `VACUUM` has PostgreSQL's exact semantics.
- Running a full vacuum on every table after every load without looking at automatic maintenance or table state.
- Ignoring stale statistics after a large or skew-changing ingestion.
- Treating `STV_` snapshots as permanent logs or `STL_` history as unlimited retention.
- Vacuuming before considering dependent materialized-view refresh requirements.
- Diagnosing unsorted data from metadata alone instead of connecting it to block pruning and the affected queries.
