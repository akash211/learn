# Query Planning and Optimisation

The optimiser's job is to turn a declarative statement into a physical plan. It does this by
enumerating join orders, access paths and algorithms, estimating the cost of each, and picking
the cheapest. Almost every performance problem is one of three things: the estimate was wrong,
the plan was right but the data volume genuinely large, or the query was written so that no
good plan exists.

## The pipeline

```text
parse → rewrite (views, subqueries, predicates) → plan (logical) → optimise (physical) → execute
```

The **rewrite** stage is where views are expanded and simple predicates are pushed down. The
**plan** stage produces a logical tree of relational operators (scan, join, aggregate). The
**optimise** stage picks implementations: which join algorithm, which index, which join order.
The **execute** stage is the only one that touches data.

Cost is measured in abstract units: PostgreSQL uses page reads plus CPU tuple costs; SQL
Server uses estimated subtree cost in seconds; Snowflake optimises for partitions scanned and
bytes shuffled. None of them are wall-clock predictions, which is why a "cost 0.43" query can
still take four minutes — the estimate was wrong, or the cost model does not capture the
bottleneck.

## Statistics drive everything

The optimiser needs to know how many rows each operator will produce. It gets this from
statistics: histograms of value distribution, distinct-value counts, NULL fractions, and
correlation between columns.

- **PostgreSQL**: `ANALYZE` populates `pg_statistic`; autovacuum runs it automatically. The
  default sample is 300 × `default_statistics_target` (100) rows — which is why a
  `WHERE tenant_id = 'rare-tenant'` predicate can be estimated as if the tenant were average.
  Raise the target per column with `ALTER TABLE … ALTER COLUMN … SET STATISTICS 1000`.
- **SQL Server**: statistics are created automatically on indexed and (optionally) non-indexed
  columns, and updated when a threshold of rows changes. Stale stats after a bulk load are the
  classic cause of a bad plan. `UPDATE STATISTICS … WITH FULLSCAN`.
- **Snowflake**: no user-managed statistics. It uses micro-partition metadata (min/max,
  distinct counts) and pruning, so the "estimate" is really "how many partitions survive".

**Multi-column correlation** is the deep problem. If `country` and `city` are indexed
separately, the optimiser assumes independence and multiplies selectivities — predicting far
fewer rows than reality when the predicate is `country = 'IN' AND city = 'Mumbai'`. SQL Server
has filtered statistics and multi-column stats; PostgreSQL 10+ has `CREATE STATISTICS … ON
country, city FROM customers` for exactly this. Without it, a nested loop over a
badly-estimated one-row result becomes a million-row loop.

## Join algorithms

| Algorithm | Cost shape | Best when |
|---|---|---|
| Nested loop | `outer_rows × inner_lookup_cost` | Outer side small, inner side indexed |
| Hash join | Build hash on smaller side, probe with larger | Large unsorted inputs, equi-join |
| Merge join | Sort both sides, merge | Both inputs already sorted, or large equi-join with indexes |
| Broadcast / shuffle (MPP) | Network cost dominates | Warehouse joins across distributed storage |

The classic failure is a nested loop chosen because the outer side was estimated at 10 rows
and actually produces 2 million. In PostgreSQL the plan shows `rows=10` estimated against
`actual rows=2000000` — that discrepancy is the finding, not the loop itself.

Hash joins spill to disk when the build side exceeds `work_mem` (PostgreSQL) or the memory
grant (SQL Server). A plan that says "Batches: 8" or "spilled to disk" is telling you the
memory estimate was wrong; the fix is usually to filter earlier, not to raise the limit
globally.

## Sargability

A predicate is sargable ("Search ARGument able") if the engine can use an index range scan for
it. The rule: **the indexed column must appear bare on one side of the comparison.**

```sql
-- Not sargable: function on the column
WHERE DATE_TRUNC('month', order_ts) = DATE '2026-01-01'
-- Sargable
WHERE order_ts >= DATE '2026-01-01' AND order_ts < DATE '2026-02-01'

-- Not sargable: implicit cast (SQL Server example — VARCHAR column compared to NVARCHAR literal)
WHERE order_id = N'1042'
-- Sargable: matching types
WHERE order_id = '1042'
```

The implicit-conversion case is a SQL Server specialty: comparing a `VARCHAR` column to an
`NVARCHAR` value forces a conversion on every row and turns a seek into a scan. The plan shows
`CONVERT_IMPLICIT` in the predicate. It is invisible in the SQL text and expensive in
production.

Other sargability breakers: `WHERE col + 0 = 5`, `WHERE col LIKE '%abc'` (leading wildcard),
`WHERE UPPER(col) = 'X'` (fix with a functional index on `UPPER(col)` in PostgreSQL, a
persisted computed column in SQL Server, or a collation change).

## Reading a plan

PostgreSQL:

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT c.country, SUM(o.total_amount)
FROM orders o JOIN customers c USING (customer_id)
WHERE o.order_ts >= DATE '2026-01-01'
GROUP BY c.country;
```

Read plans **inside out and bottom up**. For each node, compare estimated `rows` to `actual
rows`, and check `loops` — a nested loop's inner node reports per-loop figures, so multiply by
`loops` to get real work. `Buffers: shared hit=` versus `read=` separates CPU-bound from
I/O-bound.

SQL Server: the actual execution plan's thick arrows mean many rows; look for yellow bang
(warning) icons — spills, implicit conversion, missing statistics. `SET STATISTICS IO, TIME
ON` gives logical reads per table, which is the number that matters for cache behaviour.

Snowflake: the **Query Profile** shows operators, partitions scanned versus total, bytes
spilled, and time per node. `EXPLAIN` gives the plan without executing; `QUERY_HISTORY` gives
actuals after the fact, including `BYTES_SCANNED` and `PARTITIONS_SCANNED`.

## Optimisation levers, in order

1. **Reduce rows early.** Push filters down, filter before joining, prune partitions. This is
   almost always the biggest win.
2. **Reduce columns.** Columnar engines read only referenced columns; `SELECT *` on a wide
   table multiplies I/O.
3. **Fix the estimate.** Add or refresh statistics, add a multi-column statistic, rewrite the
   predicate so the optimiser can reason about it.
4. **Add or change an index/clustering key.** Only after the above.
5. **Restructure the query.** Pre-aggregate the many side of a fan-out, split a monster query
   into staged temp tables, use `EXISTS` instead of `DISTINCT`.
6. **Change the physical design.** Partitioning, materialised views, precomputed summaries.

Notice that "add an index" is fourth. Most slow-query tickets are solved at step 1 or 3.

## Parameter sniffing and plan caching

SQL Server compiles a plan for the *first* parameter values it sees and caches it. If the
first execution uses a rare `customer_id` (plan: nested loop, index seek) and a later
execution uses a value matching half the table, the cached plan is catastrophically wrong.
Symptoms: fast in staging, slow for one tenant in production. Fixes: `OPTION (RECOMPILE)`,
`OPTIMIZE FOR UNKNOWN`, or parameterised views per workload.

PostgreSQL has an analogous issue in reverse: it uses custom plans for the first five
executions, then may switch to a generic plan that ignores parameter values. `EXPLAIN
(ANALYZE)` of the extended protocol shows which was used. `plan_cache_mode = force_custom_plan`
is the escape hatch.

Snowflake does not expose plan hints or cached-plan tuning to the same degree; its
performance work is about pruning and warehouse sizing, not plan stability.

## Hints are a last resort

Every engine has hints (`/*+ INDEX(...) */` in Oracle, `OPTION (HASH JOIN)` in SQL Server,
`pg_hint_plan` as an extension in PostgreSQL, no hints at all in Snowflake). A hint freezes a
decision that was correct for today's data distribution. Use it to unblock an incident, then
fix the statistic or the query and remove it. A codebase full of hints is a codebase whose
optimiser has been silenced.

## Common mistakes

- Tuning by adding indexes before reading the plan.
- Comparing estimated and actual rows and ignoring `loops`.
- `SELECT *` in a view that is then joined five ways.
- Assuming a query is slow because it is "complex" when it is scanning 400 partitions.
- Testing with a 10,000-row development database and shipping to a 400-million-row table.

## Production notes

Keep a query store. PostgreSQL's `pg_stat_statements` (normalised queries, total and mean
time, rows) and SQL Server's Query Store (plan history, regressions) are the two features
that turn "the database is slow" into "this query regressed on Tuesday when the plan changed".
Without them you are debugging from anecdotes.
