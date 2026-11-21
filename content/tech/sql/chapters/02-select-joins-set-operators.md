# SELECT, Joins and Set Operators

A `SELECT` statement is not executed in the order it is written. The engine evaluates clauses
in a fixed logical order, and almost every confusing result — an alias that cannot be used in
`WHERE`, an aggregate that cannot appear in `WHERE`, a filter that silently turns a left join
into an inner join — follows from that order.

## Logical order of evaluation

```text
FROM / JOIN  →  WHERE  →  GROUP BY  →  HAVING  →  SELECT  →  DISTINCT  →  ORDER BY  →  LIMIT
```

Three consequences:

1. `WHERE` runs before `SELECT`, so column aliases defined in `SELECT` are not visible there.
   `ORDER BY` runs after `SELECT`, so aliases *are* visible there (and in most engines so are
   expressions over them).
2. `WHERE` filters rows; `HAVING` filters groups. An aggregate cannot appear in `WHERE`.
3. `LIMIT` runs last. It does not reduce the work done by `DISTINCT` or `ORDER BY`; it only
   truncates the result.

The optimiser is free to reorder *within* these semantics, which is why a query can be
rewritten heavily and still return the same rows. It is not free to change the semantics.

## Join types, and what they preserve

| Join | Keeps | Typical use |
|---|---|---|
| `INNER JOIN` | Rows matching on both sides | Facts that must have a dimension |
| `LEFT JOIN` | All left rows, NULLs where unmatched | Optional enrichment |
| `RIGHT JOIN` | All right rows | Rare; rewrite as LEFT for readability |
| `FULL OUTER JOIN` | All rows from both sides | Reconciliation between two sources |
| `CROSS JOIN` | Cartesian product | Date spines, generating combinations |
| Semi join (`EXISTS`) | Left rows with at least one match, no duplication | Filtering without fan-out |
| Anti join (`NOT EXISTS`) | Left rows with no match | Missing-record detection |

The semi/anti distinction matters more than it is taught. `EXISTS` never duplicates the left
side, no matter how many matches exist, so it is the safe way to ask "does this customer have
any order".

```sql
SELECT c.customer_id, c.name
FROM customers c
WHERE EXISTS (
  SELECT 1 FROM orders o
  WHERE o.customer_id = c.customer_id
    AND o.status = 'completed'
);
```

## Fan-out: the most common join bug

Joining a one-row-per-customer table to a many-rows-per-customer table multiplies the
customer row. That is correct behaviour — but if you then `SUM(o.total_amount)` alongside a
customer attribute, you are summing at order grain while presenting at customer grain, which
is fine; if you join *two* many-side tables (orders and events) in the same query, you get the
product of both counts and every aggregate is inflated.

```sql
-- Wrong: each order is repeated once per event, so the sum is multiplied
SELECT c.customer_id, SUM(o.total_amount) AS revenue, COUNT(e.event_id) AS events
FROM customers c
JOIN orders o  ON o.customer_id = c.customer_id
JOIN events e  ON e.customer_id = c.customer_id
GROUP BY c.customer_id;
```

Fix it by aggregating each many-side table to the join grain *before* joining, or by using
independent scalar subqueries. `DISTINCT` is not a fix: it hides the duplication for `COUNT`
but silently corrupts `SUM`.

## ON versus WHERE in outer joins

For an inner join, `ON` and `WHERE` are interchangeable. For an outer join they are not:
`WHERE` is applied after the join, so a predicate on the nullable side discards the
NULL-extended rows the join just created.

```sql
-- Returns only customers who have a completed order — effectively an INNER JOIN
SELECT c.customer_id, o.order_id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.customer_id
WHERE o.status = 'completed';

-- Returns every customer; non-matching orders become NULL
SELECT c.customer_id, o.order_id
FROM customers c
LEFT JOIN orders o
  ON o.customer_id = c.customer_id
 AND o.status = 'completed';
```

The second form is the one people mean when they say "all customers, plus their completed
orders". Put the filter in `ON`; reserve `WHERE` for conditions on the preserved side, or for
deliberately testing for non-matches (`WHERE o.order_id IS NULL`).

## LATERAL joins and APPLY

A lateral join lets the right side reference columns from the left. It is how you express
"the three most recent orders per customer" without window functions:

```sql
-- PostgreSQL / Snowflake
SELECT c.customer_id, o.order_id, o.order_ts
FROM customers c
LEFT JOIN LATERAL (
  SELECT order_id, order_ts
  FROM orders
  WHERE customer_id = c.customer_id
  ORDER BY order_ts DESC
  LIMIT 3
) o ON TRUE;
```

SQL Server spells this `CROSS APPLY` / `OUTER APPLY` and omits `ON TRUE`. The semantics are
the same. `OUTER APPLY` is the left-join equivalent; `CROSS APPLY` drops left rows with no
match. This pattern is usually faster than a window function when the per-customer table is
large and each customer has few rows, because it can use an index on `(customer_id,
order_ts)` and stop after three rows.

## Set operators

`UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT` combine result sets vertically. Rules: same
number of columns, compatible types, and column names come from the first query.

- `UNION` removes duplicates (a sort or hash); `UNION ALL` does not. Default to `UNION ALL`
  and add `UNION` only when you actually need deduplication — the difference is often the
  whole cost of the query.
- `INTERSECT` and `EXCEPT` are set operations: they deduplicate and treat NULLs as equal.
  This is the opposite of `=` semantics, which is why `EXCEPT` is a useful reconciliation tool.
- Precedence: `INTERSECT` binds tighter than `UNION`/`EXCEPT` in standard SQL; SQL Server and
  PostgreSQL follow that. Parenthesise when mixing.
- `ORDER BY` applies to the whole compound result, not to an individual branch. To order a
  branch, wrap it in a subquery with `LIMIT`.

Snowflake accepts `MINUS` as a synonym for `EXCEPT`; SQL Server and PostgreSQL do not.

```sql
-- Rows in yesterday's staging load that are missing from the target
SELECT order_id FROM staging.orders
EXCEPT
SELECT order_id FROM warehouse.orders;
```

## Pagination

`LIMIT n OFFSET m` (PostgreSQL, Snowflake) and `OFFSET … FETCH NEXT n ROWS ONLY` (standard,
SQL Server) both degrade linearly: the engine still produces and discards `m` rows. Deep
pages on large tables are slow and can skip or repeat rows when data changes between requests.

Keyset pagination fixes both problems by remembering the last key rather than counting:

```sql
SELECT order_id, order_ts
FROM orders
WHERE (order_ts, order_id) > ('2026-01-01 00:00:00', 1042)
ORDER BY order_ts, order_id
LIMIT 50;
```

The tuple comparison is PostgreSQL syntax; SQL Server needs the expanded form `WHERE
order_ts > @ts OR (order_ts = @ts AND order_id > @id)`. Either way, an index on `(order_ts,
order_id)` turns it into a seek. This requires a deterministic total order — include the
unique key as a tiebreaker or rows with equal timestamps will be skipped.

## Common mistakes

- Putting a predicate on the nullable side of a `LEFT JOIN` in `WHERE`.
- Using `DISTINCT` to paper over join fan-out.
- `NOT IN` against a subquery that can return NULL.
- `UNION` where `UNION ALL` would do, then wondering why the query spills to disk.
- `ORDER BY` on a column that is not in the `SELECT` list of a `DISTINCT` query — some
  engines reject it, and the ones that allow it may not do what you expect.

## Production notes

Name every column explicitly; `SELECT *` breaks downstream views when a column is added and
forces columnar engines to read columns nobody uses. When a join is slow, check the row
counts on both sides before touching the SQL — a 1:many join that the planner estimated as
1:1 is a statistics problem, not a syntax problem.
