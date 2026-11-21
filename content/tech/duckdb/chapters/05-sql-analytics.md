# Joins, Windows, and Analytical SQL

DuckDB implements a broad analytical SQL surface: joins, aggregates, window functions, common table expressions, set operations, nested data, and familiar expressions. It is usually more productive to express a transformation as SQL than to pull millions of rows into Python and loop over them. The engine can reason about a complete query and execute it in vectorized operators.

## Joins and cardinality

Inner, left, right, full outer, cross, semi, and anti join patterns are useful for combining facts and dimensions. A normal equijoin often supports a hash-join plan; conditions and relation sizes affect physical choices. Correctness starts with key semantics: if both sides contain duplicate keys, the join can multiply rows. Count each side by key and decide whether a dimension is truly unique before interpreting aggregate totals.

```sql
SELECT o.customer_id, sum(o.amount) AS total
FROM orders AS o
JOIN customers AS c USING (customer_id)
WHERE c.segment = 'enterprise'
GROUP BY o.customer_id;
```

`USING` joins on the named columns and emits one copy of the join column. Explicit `ON` is preferable when keys differ in name or the condition is composite. Nulls do not match ordinary equality predicates; if NULL keys should match, use null-safe semantics deliberately rather than silently coalescing them to a sentinel that may be real data.

A semi join returns left-side rows with a match without adding right-side columns; an anti join returns unmatched left-side rows. They are often clearer than `IN`/`NOT IN`, especially because `NOT IN` has three-valued NULL behavior. Use `EXISTS`/`NOT EXISTS` when that communicates the intent, and test NULL cases.

## Aggregations and grouping sets

`GROUP BY` turns many input rows into keyed output groups. DuckDB supports common aggregate functions such as `sum`, `avg`, `count`, `min`, and `max`, plus advanced aggregates including approximate or ordered forms depending on the function. `FILTER (WHERE ...)` allows multiple conditional aggregates in one pass. `GROUPING SETS`, `ROLLUP`, and `CUBE` produce multiple aggregation levels when a report needs subtotals.

```sql
SELECT region,
       count(*) AS orders,
       sum(amount) FILTER (WHERE status = 'paid') AS paid_amount
FROM orders
GROUP BY region;
```

`count(*)` counts rows; `count(column)` ignores NULL values. Most aggregates ignore NULL inputs, and an aggregate over no matching values may return NULL rather than zero. Use `coalesce` only when zero is the intended business meaning. Avoid aggregating after an accidental many-to-many join: a syntactically valid sum can be inflated while looking plausible.

## Window functions

A window function computes across related rows without collapsing them. `OVER (PARTITION BY ... ORDER BY ...)` defines each window group and ordering. `row_number`, `rank`, and `dense_rank` support ranking; `lag` and `lead` compare adjacent rows; aggregate windows support running totals and moving statistics. The window's `ORDER BY` does not sort the final result, so use a query-level `ORDER BY` when output order matters.

```sql
SELECT account_id, event_time, amount,
       sum(amount) OVER (
         PARTITION BY account_id
         ORDER BY event_time
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_amount
FROM events;
```

Specify a deterministic tie-breaker when equal order values could produce arbitrary row assignment. Frame semantics matter: a `ROWS` frame counts physical rows, whereas a `RANGE` frame groups values by the ordering expression and peers. The default frame can therefore surprise when ties exist. For “latest row per key,” use `row_number()` with an explicit ordering and filter the rank in an outer query or `QUALIFY` where supported.

## CTEs, subqueries, and reusable expressions

Common table expressions (`WITH`) make stages of a query readable. They are not always a promise to materialize a temporary table; the optimizer may inline or transform them. Use a CTE to name semantic steps, not as a performance hint unless the engine explicitly documents the behavior. A subquery can express the same logic; compare plans if a query performs unexpectedly.

DuckDB also supports `QUALIFY` to filter on window results, and useful SQL conveniences such as `FROM`-first syntax and `GROUP BY ALL` in current 1.x releases. These can make analytical queries concise, but use standard forms when portability to other engines matters. Not every SQL engine accepts the same syntax or function names.

## Set operations and NULL-aware logic

`UNION ALL` concatenates results without deduplication; `UNION` removes duplicates and can require extra work. `INTERSECT` and `EXCEPT` express set differences, with `ALL` variants available in supported syntax. Align types and column order intentionally. A cast can alter decimal precision or timestamp interpretation, so standardize schemas before combining heterogeneous files.

SQL predicates use three-valued logic: true, false, or unknown. `NULL = NULL` is not true; `WHERE` keeps only true rows. This affects anti-joins, `NOT IN`, conditional aggregation, and JSON extraction. Use `IS NULL`, `IS NOT NULL`, and explicit null-safe comparisons where the domain needs them.

## Common mistakes

- Joining on a non-unique dimension key and then blaming `sum` for inflated totals.
- Assuming output order without an outer `ORDER BY`.
- Omitting a tie-breaker from `row_number` and expecting reproducible winners.
- Confusing `UNION` with `UNION ALL` or `count(*)` with `count(column)`.
- Assuming every PostgreSQL function or syntax extension is automatically portable to DuckDB.

## Production notes

Treat SQL tests as data-contract tests: include duplicate keys, NULLs, boundary timestamps, and empty inputs. Use `EXPLAIN ANALYZE` when the plan is surprising, but preserve a simple readable query until evidence justifies a rewrite. Push common aggregations and filters into SQL; fetch only the reduced result into the host language. For semantics that must match another warehouse, test exact types, time zones, collation, and NULL behavior on both engines.

## Advanced SQL without hidden grain changes

`QUALIFY` is convenient for filtering a window result: `QUALIFY row_number() OVER (PARTITION BY id ORDER BY updated_at DESC) = 1`. A subquery remains a portable alternative. Use `GROUP BY ALL` only if its concise behavior is clear to readers; explicit grouping columns can make review safer when selected expressions change.

When a report needs several grains, `GROUPING SETS` or `ROLLUP` can avoid repeated aggregations. The result includes subtotal rows, so use `GROUPING()` indicators or another explicit marker to distinguish a subtotal NULL from a real NULL dimension. Never interpret every NULL in subtotal output as missing source data.

Ordered aggregates and window frames need deliberate semantics. If ties are possible, define a tie-breaker. For “previous event,” sort by timestamp and stable event id; timestamps alone may not define a total order. Use a bounded `ROWS` frame for “last N records,” and `RANGE` for “within a value interval.” Verify boundary rows with a tiny hand-worked fixture.

## Conditional logic and query readability

`CASE` expressions, `FILTER`, and carefully named CTEs can keep business rules close to the measures they define. Avoid copying a complicated condition across multiple aggregates; name the predicate in a CTE or use filtered aggregates so reviewers can compare categories. For a pivot-style report, conditional sums are transparent for a known small set of categories, while `PIVOT` can be useful for data-driven categories. Dynamic output columns have downstream schema costs, so use them only when consumers expect that shape.
