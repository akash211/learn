# The Optimizer and EXPLAIN

DuckDB accepts declarative SQL and builds an execution plan rather than blindly running clauses in the order they appear. The optimizer's job is to produce an equivalent plan that does less work, reduces intermediate data, and uses appropriate operators. Understanding the plan is more reliable than guessing from SQL formatting or adding arbitrary indexes and hints.

## From SQL to operators

A query is parsed, names and types are resolved, and a logical representation is transformed before physical operators are selected. Typical transformations include constant folding, simplifying expressions, pushing filters closer to scans, pruning unused columns, and reordering joins. Physical planning then selects scans, joins, aggregates, sorts, and projections. The engine executes the resulting pipeline in vectors.

For example, if a query filters orders by date and groups by region, the engine can push the date predicate into the Parquet scan, read only the date, region, and amount columns, and aggregate before returning results. In SQL, `WHERE` appears after `FROM`, but physical execution can apply it during scanning. SQL's declarative form gives this freedom while preserving semantics.

Optimizers need estimates. Catalog tables can provide statistics; external file metadata can supply row-group and column information. Estimates can be imperfect, especially for correlated columns, rapidly changing sources, expressions, or remote scans. A poor cardinality estimate can lead to a join order or algorithm that makes a much larger intermediate relation than expected.

## EXPLAIN without execution

`EXPLAIN query` displays a planned physical operator tree without running the query. Read it from the leaves (scans) upward toward the result. Look for which columns a scan reads, whether a filter is attached to the scan, estimated cardinalities, join conditions, and whether a costly sort or materialization is present. Exact textual formatting may vary by version, so understand the operator names rather than writing brittle tests against spacing.

```sql
EXPLAIN
SELECT country, sum(amount)
FROM read_parquet('sales/*.parquet')
WHERE order_date >= DATE '2025-01-01'
GROUP BY country;
```

The physical plan is a hypothesis about execution, not a measurement. If a scan shows more columns than expected, investigate projection pushdown; if filters are applied above a scan, check casts, functions, or semantics that prevent pushdown. A join whose estimated output is vastly larger than the inputs may indicate a missing or incorrect join predicate, or a mistaken estimate.

## EXPLAIN ANALYZE and profiling

`EXPLAIN ANALYZE query` executes the query and reports actual operator timings and cardinalities along with the plan. Use it on a representative query and data volume; a tiny sample can change join choices, pruning behavior, and parallelism. Timings in a parallel engine should not always be summed as if they represented wall-clock time: operators may overlap and work is distributed across threads.

The comparison between estimated and actual cardinalities is especially useful. If an intermediate join is estimated at a few thousand rows but produces hundreds of millions, downstream work becomes expensive. Check join keys for duplicate multiplicity, filters for selectivity, and whether stale or absent statistics explain the mismatch. A high output count can also be correct if the relationship is many-to-many, so diagnose semantics before “fixing” the plan.

Profile a query before changing settings. Query-level profiling can also be enabled via supported profiling pragmas/settings; names and output modes evolve, so check `duckdb_settings()` or versioned documentation for the installed build. Save profiles with the exact query, database state, and input snapshot so comparisons are meaningful.

## Optimizations worth recognizing

- **Projection pushdown:** unused columns are omitted from a scan. This is particularly valuable for wide Parquet files.
- **Filter pushdown:** predicates are applied at or near the scan, skipping rows or row groups when possible.
- **Join reordering:** associative inner joins can be rearranged so selective or smaller relations reduce later work. Outer joins and non-equality conditions constrain legal reorderings.
- **Expression simplification:** constants and redundant predicates can be removed before execution.
- **Aggregation and pipeline execution:** operators can process batches without materializing every logical step to disk. Blocking operators such as a global sort still need state and can spill.

These are opportunities, not contractual guarantees for every query. A cast on a file column, a function around a filter field, or a format without useful statistics may prevent a particular pushdown. Rewrite only after checking correctness and the observed plan.

## Diagnosing a slow query

First isolate whether the delay is planning, remote I/O, CPU, temporary disk, or result conversion. Run the query without fetching a huge result into Python; compare `count(*)` or an aggregate if that matches the work of interest. Use `EXPLAIN ANALYZE` to locate expensive operators. Compare row counts at each join, bytes read, and the output cardinality. Then change one factor and re-measure.

When a join explodes, verify key uniqueness and join predicates. When a scan dominates, check selected columns, filter pushdown, file count, partition pruning, and remote request behavior. When a sort or aggregate dominates, inspect group cardinality and memory/spill. If the query is fast but the application is slow, include Arrow conversion, serialization, and downstream processing in the measurement.

## Common mistakes

- Reading `EXPLAIN` as actual runtime evidence. Use `EXPLAIN ANALYZE` for execution data.
- Treating estimated cardinalities as facts. Compare them with actual results.
- Changing `threads` before learning whether the query is I/O-, CPU-, or memory-bound.
- Assuming an index helps analytical scans; columnar pruning and query shape may matter more.
- Forcing a query rewrite that changes NULL or duplicate semantics to match a preferred plan.

## Production notes

Keep performance tests on representative, immutable input snapshots and compare output correctness as well as runtime. Plans can shift with versions, statistics, and file layout. Avoid relying on optimizer implementation details as a correctness condition. A good SQL query expresses the result clearly; profiling then shows whether data layout or query structure needs adjustment.

## A plan-reading checklist

Start at scan leaves: what files, columns, filters, and estimated rows are involved? Move upward to inspect cardinality after each join and aggregate. Check whether predicates are pushed toward the scan and whether a cast or expression prevents it. Identify expensive order-dependent operators such as sorts and windows, and locate wide intermediate relations. If the physical plan looks reasonable but execution is slow, compare actual operator time and cardinality in `EXPLAIN ANALYZE`.

Do not equate an operator name with a bug. A nested-loop strategy may be sensible for a tiny relation or non-equality condition; a hash join can be expensive if it builds large state. Ask what volume and selectivity make the strategy reasonable. Likewise, a sequential scan is often correct for analytics; a row index is not automatically useful when most rows are read.

A regression test should assert output semantics and may include a performance budget on representative data. Exact plan text is more fragile across versions than behavioral checks. If the optimizer changes join order after upgrade, compare results and resource use before pinning or rewriting the query.
