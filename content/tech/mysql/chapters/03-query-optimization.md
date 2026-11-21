# Query Optimisation and Execution Plans

A query optimizer chooses a physical strategy for the SQL you wrote. It considers candidate access paths, join orders, available indexes, and estimates of rows and cost. The plan is not a promise of elapsed time: it is the strategy selected from the optimizer's information at compile time. Good diagnosis compares that expectation with actual execution and asks where rows, loops, sorting, or waiting differ from the model.

## Read EXPLAIN as a tree

MySQL's `EXPLAIN` presents the chosen plan without running the statement. Traditional output is tabular; JSON output includes more detail, and tree output is often easiest for joins.

```sql
EXPLAIN FORMAT=TREE
SELECT c.customer_id, COUNT(*)
FROM customers AS c
JOIN orders AS o ON o.customer_id = c.customer_id
WHERE c.region = 'west' AND o.created_at >= '2026-01-01'
GROUP BY c.customer_id;
```

Read from leaf operations toward the root. Identify which table is accessed first, how each subsequent table is joined, and which predicates narrow rows at each step. `key` tells you the chosen index, `rows` estimates rows examined, and `filtered` estimates the percentage surviving a condition. `Using temporary` and `Using filesort` indicate extra work may be required; filesort is the name of an algorithm, not proof that the server wrote to disk. Check sort and temporary-table sizes and actual runtime before inferring disk I/O.

`type=ALL` indicates a table scan, while `range`, `ref`, and `eq_ref` describe progressively structured index access in common cases. Never rank a plan from `type` alone: scanning a small table can be cheaper than index probes, and a `range` scan over most rows may be costly. For joins, the displayed row estimates multiply across nested loops, so a moderately wrong estimate on an early node can magnify downstream work.

## EXPLAIN ANALYZE runs the statement

MySQL 8.0.18 introduced `EXPLAIN ANALYZE`, which executes the statement and reports actual timing, rows, and loops alongside estimates. It is invaluable for finding cardinality errors and expensive nodes, but it is not a harmless explain-only operation. A SELECT can still consume substantial CPU, I/O, and locks; an analyzed data-changing statement executes its change. Use a safe environment or a query whose effects you understand.

```sql
EXPLAIN ANALYZE
SELECT order_id, total
FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 20;
```

Compare estimated rows with actual rows at each iterator. Actual time is reported as time to first row and time to completion for the iterator, and values under loops may be averages per loop. Multiplying per-loop rows by loop counts helps reveal repeated work, but avoid naïvely summing parent and child times because iterator timings can overlap. Find the first major divergence between estimate and reality; later expensive nodes may be symptoms of that early mistake.

## Estimates and optimizer choices

InnoDB's persistent statistics and sampled index pages inform cardinality estimates. Skew, correlated columns, stale statistics, or parameter differences can cause the optimizer to misjudge selectivity. Refresh statistics with `ANALYZE TABLE` when justified and compare before-and-after plans. MySQL 8.0 histograms can help with distribution information for a column, especially where index statistics are insufficient:

```sql
ANALYZE TABLE orders
  UPDATE HISTOGRAM ON status WITH 32 BUCKETS;
```

Histograms are stored optimizer statistics, not indexes, and they do not make row retrieval faster by themselves. They can change plan choices; verify that the new estimates improve representative workload cases and refresh or remove them when data distributions change. The optimizer's cost model combines estimated page and CPU costs. Forcing an index or join order can mask bad statistics or a missing composite index and may degrade other parameter values.

## Make the query sargable

A predicate is easier to optimize when it can be translated into a range on indexed values. Avoid wrapping an indexed column in a function unless you have a compatible functional index, and avoid implicit conversions that change comparison semantics. For example, filtering a timestamp with a half-open interval preserves range access and handles fractional seconds cleanly:

```sql
SELECT order_id FROM orders
WHERE created_at >= '2026-05-01 00:00:00'
  AND created_at <  '2026-06-01 00:00:00';
```

Functions on the constant side are usually preferable to applying a conversion to every indexed row. Keep predicates aligned with column types, collations, and signedness. A query can use an index yet still read too many rows if the index's leading columns are weakly selective or if filtering happens after retrieval.

For `ORDER BY ... LIMIT`, a composite index that matches equality conditions and ordering can stop after finding enough rows. Without it, MySQL may read many qualifying rows and perform a filesort before applying the limit. A small `LIMIT` does not guarantee small work if the ordering cannot be satisfied early.

## Diagnose by measurement

Start with the slow query log or statement summaries to identify frequent or high-total-cost statements. Normalize literals to group similar statements; inspect both the worst latency and aggregate execution count. Capture representative parameters because skew can make one plan fast for ordinary tenants and slow for a large tenant. Inspect row counts, selected columns, predicates, and transaction boundaries before adding indexes.

Change one thing at a time: query shape, index, statistics, or configuration. Re-run the same representative workload and compare latency distribution, rows examined, temporary work, lock waits, and write cost. A single microbenchmark on warm cache does not establish production value. Plan stability can vary with data growth, release upgrades, and statistics collection.

## Join order and query shape

MySQL joins are commonly executed as nested loops, so the outer input determines how often the inner access path runs. A selective first table can make an indexed inner lookup efficient; a poorly estimated outer table can multiply otherwise reasonable work. Inspect join order and iterator loops in `EXPLAIN ANALYZE`, then verify whether the join columns have compatible types and useful indexes. A cast or collation mismatch can prevent the expected lookup even when both columns appear indexed.

For aggregation, distinguish rows entering the aggregate from groups returned. A query that groups a large input may need a temporary structure, and an `ORDER BY` after aggregation can require a separate sort. Rewriting a query to filter earlier can reduce work, but only if it preserves semantics—especially with outer joins, NULLs, and duplicate rows. Avoid replacing a relational query with application-side loops without measuring network round trips and consistency consequences.

Prepared statements and parameterized queries protect against injection and reduce repeated parsing, but parameter distributions still matter to plans. Test both typical and high-skew values. After an index or query rewrite, observe the full workload: a plan that helps one endpoint can increase write cost or change contention elsewhere.

## Common mistakes

- Treating `EXPLAIN` as actual timing or assuming `EXPLAIN ANALYZE` does not execute the query.
- Reading `Using filesort` as proof of disk sorting.
- Optimizing only the slowest single execution while ignoring frequency and aggregate cost.
- Adding a hint before checking statistics, data skew, and the first bad cardinality estimate.
- Assuming `LIMIT` makes a query cheap when sorting requires reading all candidates first.
