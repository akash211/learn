# Query Optimisation: Profiles, Spilling and Warehouse Sizing

A slow query in Snowflake is almost always one of four things: it read far more data than it needed, it ran out of memory and spilled, it queued behind other work, or it was given a warehouse too small for the shape of the plan. The query profile distinguishes these cases in about a minute, and the order in which you read it matters, because resizing a warehouse to fix a pruning problem is the most expensive way to learn nothing.

## Getting to the evidence

Three entry points, in increasing order of detail:

```sql
-- The plan, without executing
EXPLAIN USING TABULAR SELECT ...;

-- Operator-level statistics for a query that already ran
SELECT * FROM TABLE(GET_QUERY_OPERATOR_STATS('<query_id>'));

-- History, for finding the culprit in the first place
SELECT query_id, warehouse_size, total_elapsed_time/1000 AS sec,
       partitions_scanned, partitions_total,
       bytes_spilled_to_local_storage, bytes_spilled_to_remote_storage
FROM snowflake.account_usage.query_history
WHERE warehouse_name = 'WH_BI'
  AND start_time > DATEADD(hour, -24, CURRENT_TIMESTAMP())
ORDER BY total_elapsed_time DESC
LIMIT 20;
```

In Snowsight, the Query Profile renders the same data as an operator tree, with the most expensive node highlighted and a statistics panel per node. `EXPLAIN` alone is a plan without cardinalities — useful for confirming that a filter reached the scan, useless for finding where the time went.

## Reading the profile in order

**1. Partitions scanned over partitions total.** This is on the `TableScan` node. If a query filtering to one day scans every partition, nothing downstream matters; go back to clustering. If it scans 60 of 8,000, the scan is already efficient and any remaining cost is CPU, spill or queueing.

**2. Bytes scanned and percentage scanned from cache.** A high cache percentage means the time is CPU-bound, not I/O-bound. A low percentage on a repeated query means the warehouse is being suspended between runs, or the query is hitting a different warehouse each time.

**3. Bytes spilled.** Each sort, hash join and aggregate has a memory budget. When it exceeds that budget, rows go to local SSD (`Bytes spilled to local storage`) and, if that is not enough, to object storage (`Bytes spilled to remote storage`). Local spill is a slowdown; remote spill is a different order of problem, because every spilled row crosses the network twice. A profile showing gigabytes of remote spill is not a tuning opportunity, it is a query or sizing failure.

**4. Rows out versus rows in, per operator.** A `Join` producing more rows than either input is a fan-out — usually a missing join condition or a duplicated dimension table. An `Aggregate` with hundreds of millions of output groups is a `GROUP BY` on a near-unique key, which turns a streaming aggregate into a memory-bound sort.

**5. Bytes sent over the network.** Join and exchange operators report this. One exchange orders of magnitude larger than its siblings points at skew: one join key value has vastly more rows than the rest, so one node does most of the work while the others idle.

**6. Queue time.** `QUEUED_OVERLOAD_TIME` and `QUEUED_PROVISIONING_TIME` in `QUERY_HISTORY` are outside `EXECUTION_TIME` in the profile but inside what the user experienced. A query that took 90 seconds, of which 70 were queued, does not need tuning — it needs concurrency.

## Why spill happens, and the order of fixes

Spill is memory pressure, and memory scales with warehouse size. But resizing first is usually wrong, because the common causes are query-shaped:

| Cause | Symptom in the profile | Fix |
| --- | --- | --- |
| Fan-out join | `Join` output rows ≫ input rows | Fix the join key or dedupe the dimension |
| `SELECT *` through a wide sort | Large `Sort` with heavy spill | Project only needed columns |
| High-cardinality `GROUP BY` | `Aggregate` with huge group count | Pre-aggregate, or accept and size up |
| Skewed join key | One exchange with most of the bytes | Salt the key, or filter the hot value separately |
| Genuinely large sort | `Sort` spilling with sane row counts | Size up, or remove the `ORDER BY` |

Only the last row is a sizing problem. The others get worse — and more expensive — on a bigger warehouse, because you pay double the credits to spill the same rows faster.

## Sizing a warehouse correctly

Sizes double: `XSMALL` consumes one credit per hour, `SMALL` two, `MEDIUM` four, and so on to `6XLARGE` at 512. Time-to-credits is roughly size × runtime, so doubling the warehouse only saves money if it more than halves runtime. For a scan-bound query reading a fixed number of partitions, doubling often does come close, because the work parallelises across twice the nodes. For a query that spills badly, doubling may remove the spill entirely and win big. For a query dominated by a serial step or by skew, doubling changes almost nothing and doubles the bill.

The empirical method is boring and correct: run the same query at two sizes with the result cache disabled, and compare `EXECUTION_TIME` and credits.

```sql
ALTER SESSION SET USE_CACHED_RESULT = FALSE;
-- run at SMALL, record; then:
ALTER WAREHOUSE wh_bi SET WAREHOUSE_SIZE = 'MEDIUM';
-- run again, compare
```

Also size for concurrency separately. A warehouse's memory and CPU are shared by every query running on it, so a `MEDIUM` running eight dashboards behaves like eight small queries competing for one medium's memory — and spills where a single query would not. Multi-cluster warehouses add clusters for *queued* queries, which helps throughput, but each cluster is another full warehouse's credits.

## The SQL-level fixes that still matter

Pruning is the big one, but a handful of rewrites pay off repeatedly:

- Replace `SELECT *` with the columns used. Columnar storage makes unused columns nearly free to skip and expensive to carry through a shuffle.
- Push filters into the smallest possible scope, and keep them sargable. `WHERE customer_id = 42` prunes; `WHERE customer_id + 0 = 42` does not.
- Replace `NOT IN` with `NOT EXISTS` or an anti-join when the subquery can produce nulls — `NOT IN` with a null returns no rows at all, which is a correctness bug that looks like a performance mystery.
- Avoid `DISTINCT` as a deduplication crutch. It forces a full sort or hash of the result, and if the duplication came from a join fan-out, the fan-out is the bug.
- Use `QUALIFY` for window-function filters instead of a subquery wrapper; it lets the optimiser avoid materialising the intermediate result.
- For scan-heavy queries on large tables, the Query Acceleration Service (Enterprise) can offload part of the scan to shared compute, which helps when the warehouse is the bottleneck rather than the data.

## Common mistakes

- Resizing before reading `partitions_scanned`. You cannot outrun a full scan by paying more.
- Comparing runtimes across queries with the result cache enabled, so the second run measures nothing.
- Treating `EXECUTION_TIME` as the user's experience, when queue time sits outside it.
- Setting a very small `STATEMENT_TIMEOUT_IN_SECONDS` and calling an intermittent failure a performance fix. Timeouts hide the problem and break retries.
- Adding a clustering key to fix a query that is actually spilling, then paying twice — for clustering maintenance and for the spill.

## Production notes

Build one saved query against `QUERY_HISTORY` per warehouse that ranks by `bytes_spilled_to_remote_storage` and by `partitions_scanned/partitions_total`, and review it weekly. Alert on `QUEUED_OVERLOAD_TIME` as a separate signal from runtime: it is the earliest indicator that a workload needs another warehouse, and it appears before users complain. Keep `STATEMENT_QUEUED_TIMEOUT_IN_SECONDS` set on interactive warehouses so a bad dashboard cannot occupy the queue indefinitely, and set `STATEMENT_TIMEOUT_IN_SECONDS` generously — it is a guardrail against runaway queries, not a performance setting.
