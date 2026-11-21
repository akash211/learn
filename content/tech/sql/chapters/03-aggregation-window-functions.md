# Aggregation and Window Functions

`GROUP BY` collapses rows; window functions annotate them without collapsing. Choosing
between the two is usually a modelling decision about grain — and getting the grain wrong is
the root cause of most "my numbers are double" incidents.

## GROUP BY, mechanically

```sql
SELECT
  c.country,
  COUNT(*)                    AS orders,
  COUNT(DISTINCT o.customer_id) AS buyers,
  SUM(o.total_amount)         AS revenue
FROM orders o
JOIN customers c ON c.customer_id = o.customer_id
WHERE o.status = 'completed'
GROUP BY c.country;
```

Every expression in `SELECT` must be either an aggregate or a grouping key. PostgreSQL and
SQL Server enforce this; Snowflake also enforces it. MySQL historically allowed bare columns
and returned an arbitrary row — if you learned SQL there, unlearn it.

`COUNT(*)` counts rows. `COUNT(col)` counts non-NULL values. `COUNT(DISTINCT col)` counts
distinct non-NULL values and is the most expensive of the three because it needs a per-group
hash set.

`FILTER (WHERE …)` is the clean way to do conditional aggregation in PostgreSQL (and BigQuery
or DuckDB):

```sql
SELECT
  DATE_TRUNC('month', order_ts) AS month,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM orders
GROUP BY 1;
```

Snowflake and SQL Server do not support `FILTER`. Snowflake has `COUNT_IF(condition)` for the
count case and `IFF(condition, value, NULL)` inside `SUM` for the rest; SQL Server needs
`SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)`. The `CASE` form works everywhere,
which is why it is the portable choice — and why it is what a cross-dialect dbt model should
use.

`GROUPING SETS`, `ROLLUP` and `CUBE` produce multiple aggregation levels in one pass and
insert NULLs for the collapsed dimensions. That NULL is ambiguous with a real NULL, so use
`GROUPING(col)` to distinguish "this row is the subtotal" from "this value was missing":

```sql
SELECT
  country,
  GROUPING(country) AS is_total,
  SUM(total_amount) AS revenue
FROM orders o JOIN customers c USING (customer_id)
GROUP BY ROLLUP (country);
```

## Window functions: the anatomy

A window function computes across a set of rows related to the current row, without reducing
the result to one row per group.

```text
function(...) OVER (
  PARTITION BY ...   -- reset the window per group
  ORDER BY ...       -- define position within the window
  frame              -- which rows around the current row are visible
)
```

Without `ORDER BY`, the default frame is the entire partition. With `ORDER BY`, the default
frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` — which includes *peers* (rows
with equal sort keys), not just rows physically before the current one. This is the single
most misunderstood detail in window functions.

| Function | Purpose |
|---|---|
| `ROW_NUMBER()` | Unique sequential number, arbitrary among ties |
| `RANK()` | Number with gaps after ties |
| `DENSE_RANK()` | Number without gaps |
| `LAG` / `LEAD` | Previous/next value in the window |
| `FIRST_VALUE` / `LAST_VALUE` | Boundary values — `LAST_VALUE` needs an explicit frame to be useful |
| `NTILE(n)` | Bucket assignment |
| `SUM`/`AVG`/`COUNT` `OVER` | Running or partitioned aggregates |

`ROW_NUMBER` is non-deterministic among ties. If you use it to deduplicate, always add a
tiebreaker that makes the choice deterministic (typically `ORDER BY updated_at DESC, id DESC`).

## Frames: ROWS, RANGE, GROUPS

```sql
-- Running total: rows physically up to and including the current row
SUM(total_amount) OVER (
  PARTITION BY customer_id
  ORDER BY order_ts
  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
) AS running_total

-- 7-day moving window by value, including peers with the same timestamp
SUM(total_amount) OVER (
  PARTITION BY customer_id
  ORDER BY order_ts
  RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
) AS trailing_7d
```

`ROWS` counts physical rows. `RANGE` operates on values and includes peers — two orders at
the same timestamp both see each other. `GROUPS` counts peer groups. For running totals,
`ROWS` is almost always what you want, because `RANGE` produces a value that jumps when
timestamps tie.

`RANGE … INTERVAL` requires the `ORDER BY` column to be a date/time type and is supported in
PostgreSQL and Snowflake. SQL Server does not support `RANGE` with an offset at all — it
supports only `UNBOUNDED PRECEDING`/`CURRENT ROW`/`UNBOUNDED FOLLOWING` for `RANGE`, so a
trailing window needs a self-join or a date spine.

## QUALIFY: filtering on window results

You cannot reference a window function in `WHERE` — window functions are evaluated after
`WHERE` and `GROUP BY`. The portable solution is a CTE or subquery:

```sql
WITH ranked AS (
  SELECT
    o.*,
    ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_ts DESC, order_id DESC) AS rn
  FROM orders o
)
SELECT * FROM ranked WHERE rn = 1;
```

Snowflake (and BigQuery, Databricks, DuckDB) allow `QUALIFY` to do this in one level:

```sql
SELECT *
FROM orders
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_ts DESC) = 1;
```

PostgreSQL and SQL Server have no `QUALIFY`. Writing it in a shared dbt model is a portability
trap: the model works on Snowflake and fails the moment someone runs it against Postgres in CI.

## Deduplication patterns

The "latest record per key" problem has three common shapes:

```sql
-- 1. ROW_NUMBER — works everywhere, reads the whole partition
SELECT * FROM (
  SELECT t.*, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY updated_at DESC) AS rn
  FROM orders_raw t
) x WHERE rn = 1;

-- 2. DISTINCT ON — PostgreSQL only, often the fastest for this shape
SELECT DISTINCT ON (order_id) *
FROM orders_raw
ORDER BY order_id, updated_at DESC;

-- 3. Anti-join — keeps all ties, so it can return more rows than expected
SELECT t.*
FROM orders_raw t
WHERE NOT EXISTS (
  SELECT 1 FROM orders_raw n
  WHERE n.order_id = t.order_id AND n.updated_at > t.updated_at
);
```

The anti-join is useful when ties are meaningful (you want *all* versions at the maximum
timestamp). `ROW_NUMBER` silently picks one.

## Aggregates over windows

`SUM(SUM(x)) OVER (...)` is legal: the inner aggregate collapses to group grain, the outer
window operates on those groups. This is how you compute a share of total without a self-join:

```sql
SELECT
  country,
  SUM(total_amount) AS revenue,
  SUM(SUM(total_amount)) OVER () AS grand_total,
  ROUND(100.0 * SUM(total_amount) / SUM(SUM(total_amount)) OVER (), 1) AS pct
FROM orders o JOIN customers c USING (customer_id)
GROUP BY country
ORDER BY revenue DESC;
```

Note `100.0`, not `100`: integer division truncates in PostgreSQL and SQL Server.

`COUNT(DISTINCT x) OVER (PARTITION BY y)` is supported by Snowflake but not by PostgreSQL or
SQL Server. The portable workaround is `DENSE_RANK()` over the pair, or a pre-aggregated
subquery joined back.

## Common mistakes

- Assuming `RANGE` and `ROWS` behave the same when timestamps tie.
- Using `LAST_VALUE` with the default frame — it returns the current row's value, not the
  partition's last, because the default frame ends at the current row.
- `ROW_NUMBER` without a tiebreaker in a dedupe, producing different results run to run.
- Aggregating after a fan-out join and not noticing the multiplication.
- Forgetting that `AVG` ignores NULLs, so adding `COALESCE(x,0)` changes the denominator.

## Production notes

Window functions sort. A query with three different `OVER` clauses over different orderings
can sort three times; reusing a single named `WINDOW` clause where possible, and filtering
before the window rather than after, is often the difference between a query that spills to
disk and one that does not. On columnar warehouses, check the query profile for the
`WindowFunction` node's rows and bytes — a window over an unpruned 10-billion-row table is a
cost event, not just a slow query.
