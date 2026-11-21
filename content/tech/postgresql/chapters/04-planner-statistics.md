# The Planner and Statistics

The planner does not look for the best plan. It looks for the cheapest plan according to a cost
model whose inputs are estimates, and then stops at a search budget. Almost every "the database
chose a terrible plan" incident is one of three things: the estimates were wrong, the cost
constants did not describe the hardware, or the search space was pruned before the good plan was
considered.

## The cost model is arbitrary units

Costs are dimensionless numbers tuned so that one sequential page read costs 1.0. They are only
meaningful relatively.

| Setting | Default | Meaning |
| --- | --- | --- |
| `seq_page_cost` | 1.0 | One page read in a sequential scan |
| `random_page_cost` | 4.0 | One page read by index; assumes spinning disks |
| `cpu_tuple_cost` | 0.01 | Processing one row |
| `cpu_index_tuple_cost` | 0.005 | Processing one index entry |
| `cpu_operator_cost` | 0.0025 | Evaluating one operator or function |
| `effective_cache_size` | 4 GB | Planner's assumption about OS page cache |
| `work_mem` | 4 MB | Per sort or hash node, per operation |
| `parallel_setup_cost` | 1000 | Cost of starting workers |
| `parallel_tuple_cost` | 0.1 | Cost of passing a row from worker to leader |

Two of these are routinely wrong in production. On NVMe or a well-cached working set, the real
penalty for a random read is nowhere near 4× a sequential one; setting `random_page_cost = 1.1`
lets the planner consider index scans it would otherwise reject, and is the single most common
"free" win. `effective_cache_size` allocates nothing — it only tells the planner how much of the
table it can expect to find cached, and setting it to 50–75% of RAM if the OS has that much to
spare is correct.

## Reading EXPLAIN

Always: `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`. Add `TIMING OFF` when the plan has tens of
thousands of loops, because per-node timing overhead can dominate.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.country, count(*)
FROM customers c JOIN orders o USING (customer_id)
WHERE c.country = 'DE' AND o.status = 'completed'
GROUP BY 1;
```

```
HashAggregate  (cost=5821.40..5821.55 rows=15 width=16) (actual time=147.220..147.226 rows=1 loops=1)
  Group Key: c.country
  Buffers: shared hit=1842 read=213
  ->  Nested Loop  (cost=1.29..5712.30 rows=21820 width=8) (actual time=0.052..141.882 rows=18358 loops=1)
        ->  Index Scan using idx_customers_country on customers c  (cost=0.43..12.10 rows=137 width=10)
              (actual time=0.031..0.520 rows=137 loops=1)
              Index Cond: (country = 'DE'::text)
        ->  Index Scan using idx_orders_customer on orders o  (cost=0.43..41.20 rows=159 width=8)
              (actual time=0.004..0.980 rows=134 loops=137)
              Index Cond: (customer_id = c.customer_id)
              Filter: (status = 'completed'::text)
              Rows Removed by Filter: 61
Planning Time: 0.284 ms
Execution Time: 147.610 ms
```

What to read, in order:

1. **Estimated vs actual rows per node, multiplied by loops.** The inner node above estimates 159
   and produces 134 per loop — fine. A node estimating 1 and producing 40,000 is the bug, and it
   is usually the inner side of a nested loop, which is why the loop count matters.
2. **`Rows Removed by Filter`.** High values mean the index delivered rows the query did not
   want: either the index is not selective for this predicate or the predicate is not sargable.
3. **`Buffers: shared hit=N read=M`.** `read` is real I/O; `hit` is cache. A plan that is slow with
   a 99% hit ratio is CPU-bound, not I/O-bound — look at the row counts and the expression cost.
4. **`Sort Method: external merge Disk: 48MB`** or `Batches: 8` on a hash join means `work_mem` was
   exceeded for that node. Fix the estimate or the query, not just the setting: `work_mem` is
   per node per connection and multiplies.
5. **`Heap Fetches`** on an index-only scan: visibility-map misses, cured by vacuum.
6. **`JIT`** timings. On short queries JIT compilation can cost more than it saves; `jit = off` for
   OLTP is legitimate.

Join algorithms, briefly: **nested loop** is right for small outer × indexed inner; **hash join**
for large unsorted equi-joins and the usual sign that estimates are trusted; **merge join** when
both sides are already sorted or the sort is needed anyway. `Gather` / `Gather Merge` above a node
means parallelism, and a `Workers Planned: 2` node whose actual time barely improves on serial is
usually I/O-bound.

## Where the estimates come from

`pg_class.reltuples` and `relpages` are set by the last `ANALYZE` (or by `VACUUM`, more coarsely).
`pg_statistic` holds, per column: `most_common_vals` with frequencies, a `histogram_bounds`
equi-depth histogram, `n_distinct`, and `correlation`.

Default `default_statistics_target = 100` means the histogram has 100 buckets and the MCV list
holds up to 100 values. For a skewed column — a tenant ID where one customer is 40% of the rows,
a status column with a long tail — 100 buckets can smear the top values and produce estimates off
by orders of magnitude:

```sql
ALTER TABLE orders ALTER COLUMN customer_id SET STATISTICS 1000;
ANALYZE orders;
```

Do that for the columns that appear in `WHERE` of expensive queries, and nowhere else: `ANALYZE`
time and `pg_statistic` size grow with the target.

## The four misestimates that cause bad plans

**1. Correlated columns.** The planner multiplies selectivities as if independent.
`WHERE city = 'Berlin' AND postal_code = '10115'` is estimated as `P(city) × P(zip)`, which
undershoots by a factor of thousands. Extended statistics fix exactly this:

```sql
CREATE STATISTICS orders_city_zip (dependencies, ndistinct, mcv)
  ON city, postal_code FROM addresses;
ANALYZE addresses;
```

`dependencies` captures functional dependencies, `ndistinct` fixes `GROUP BY` cardinality
estimates, `mcv` handles the combination of specific common values. All three are cheaper than
rewriting the query.

**2. Non-sargable predicates and expressions.** `WHERE date_trunc('day', created_at) = $1` gives
the planner a default selectivity it cannot check — typically 0.33% or 0.5% — which may be wildly
wrong in either direction. Rewrite as a range, or index the expression.

**3. Stale or absent statistics.** A table loaded with 50 million rows since the last `ANALYZE`
still reports its old `reltuples`; the planner sizes every hash table and every join off that
number. After any bulk load: `ANALYZE` the table. This is also why a table that "worked at 10
million rows" collapses at 50: the plan was chosen for a table that no longer exists.

**4. Prepared statements and generic plans.** A prepared statement is planned with the first five
parameter values (custom plans), then switches to a generic plan that ignores the parameters
(`plan_cache_mode = auto`). With a skewed distribution, the generic plan is fine on average and
catastrophic for the big tenant. `SET plan_cache_mode = force_custom_plan` for that statement, or
split the query. In 16+, `EXPLAIN (GENERIC_PLAN) SELECT ...` shows what the cached plan will be —
useful for exactly this investigation.

`LIMIT` deserves a mention: the planner assumes a `LIMIT 20` returns 20 rows cheaply, so it will
prefer an index scan with a sort — which is correct until the filter rejects 99% of candidates and
the scan walks the whole index.

## Production notes

- `CREATE EXTENSION pg_stat_statements;` and `auto_explain` with
  `log_min_duration = '1s'`, `log_analyze = on`. Plans from production beat plans from a laptop.
- Alert on `mean_exec_time` regressions per query ID, not on the whole database's average.
- Keep a saved plan for your ten most expensive queries and diff it after every `ANALYZE`-relevant
  change: data volume, statistics target, PostgreSQL version.
- 17 added `EXPLAIN (MEMORY)` (per-node memory) and `SERIALIZE`; 16 added `GENERIC_PLAN`. Both are
  cheap ways to answer questions that previously needed guesswork.

## Common mistakes

- Tuning `work_mem` globally to stop a disk spill caused by a 100× row estimate.
- Reading only the top node of a plan; the cost is at the leaves, multiplied by loops.
- Assuming `random_page_cost = 4` describes an SSD or a cached dataset.
- Running `ANALYZE` instead of creating extended statistics for genuinely correlated columns.
- Believing a plan change means the planner "got worse" when the data distribution changed.
