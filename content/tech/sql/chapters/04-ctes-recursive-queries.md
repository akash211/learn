# CTEs and Recursive Queries

A common table expression is a named subquery scoped to one statement. It buys readability
and, in recursive form, buys expressive power that no join can replace: the ability to walk a
graph until a condition holds.

## The basics, and the myth about materialisation

```sql
WITH completed_orders AS (
  SELECT order_id, customer_id, total_amount
  FROM orders
  WHERE status = 'completed'
),
customer_revenue AS (
  SELECT customer_id, SUM(total_amount) AS revenue
  FROM completed_orders
  GROUP BY customer_id
)
SELECT c.name, r.revenue
FROM customer_revenue r
JOIN customers c USING (customer_id)
WHERE r.revenue > 1000
ORDER BY r.revenue DESC;
```

The old advice "CTEs are always materialised, so they are slower than subqueries" was true of
PostgreSQL before version 12 and is still true of some engines. PostgreSQL 12+ inlines
non-recursive CTEs that are referenced once and have no side effects; you can force
materialisation with `AS MATERIALIZED` and force inlining with `AS NOT MATERIALIZED`. SQL
Server never guaranteed either behaviour — it treats CTEs as inline views and may evaluate
them multiple times, which is why a CTE referenced twice can scan twice. Snowflake
materialises CTEs in many cases, but its optimiser can also push predicates through.

The practical rule: use CTEs for clarity, and if performance matters, check the plan rather
than trusting folklore.

## Recursive CTEs: the shape

```text
WITH RECURSIVE cte AS (
    anchor query            -- runs once
  UNION ALL
    recursive query         -- references cte; runs repeatedly
)
SELECT ... FROM cte;
```

The engine evaluates the anchor, puts its rows in a working table, then repeatedly runs the
recursive term against the *previous iteration's* rows only, appending new rows until an
iteration produces none. Each iteration can only see the rows it just generated, not the
cumulative result — this is what makes the recursion terminate and what makes the semantics
tractable.

```sql
-- Every day in a range, including days with no orders
WITH RECURSIVE date_spine AS (
  SELECT DATE '2026-01-01' AS d
  UNION ALL
  SELECT d + INTERVAL '1 day'
  FROM date_spine
  WHERE d < DATE '2026-01-31'
)
SELECT s.d, COUNT(o.order_id) AS orders
FROM date_spine s
LEFT JOIN orders o ON o.order_ts::date = s.d
GROUP BY s.d
ORDER BY s.d;
```

Two details make this correct: the anchor defines the starting row, and the recursive term
carries the termination predicate. Omit the predicate and the query runs until it hits a
resource limit — in PostgreSQL, until it exhausts memory or the statement timeout; in SQL
Server, until the default `MAXRECURSION` of 100 levels is reached and the statement fails.

**Dialect note.** PostgreSQL, Snowflake and SQLite require the `RECURSIVE` keyword. SQL
Server accepts only `WITH cte AS (...)` — adding `RECURSIVE` is a syntax error. This is the
single most common copy-paste failure when moving a query between engines.

## Hierarchies

The canonical use is an adjacency-list hierarchy: each row points at its parent.

```sql
WITH RECURSIVE org AS (
  -- anchor: the root
  SELECT employee_id, manager_id, name, 1 AS depth,
         CAST(name AS VARCHAR(1000)) AS path
  FROM employees
  WHERE manager_id IS NULL

  UNION ALL

  -- recursive: direct reports of rows already in the working set
  SELECT e.employee_id, e.manager_id, e.name, o.depth + 1,
         CAST(o.path || ' > ' || e.name AS VARCHAR(1000))
  FROM employees e
  JOIN org o ON e.manager_id = o.employee_id
  WHERE o.depth < 20          -- defensive bound
)
SELECT * FROM org ORDER BY path;
```

The `depth` column does three jobs: it reports the level, it lets you bound the recursion
against bad data, and it is the cheapest cycle guard you can add. The `path` column gives a
sortable representation of the hierarchy that no self-join reproduces.

Cycle handling: if `a → b → a` exists, the join will keep finding rows forever. Two defences:

- **Depth bound** — cheap, but silently truncates legitimate deep hierarchies.
- **Path/visited set** — carry the ancestry as an array and refuse to revisit. PostgreSQL can
  use `path || e.employee_id` with an array and `NOT (e.employee_id = ANY(path))`; Snowflake
  has `ARRAY_CONTAINS`; SQL Server needs a delimited string plus `CHARINDEX`. Costly at scale
  but correct.

```sql
-- PostgreSQL cycle-safe traversal
WITH RECURSIVE walk AS (
  SELECT id, parent_id, ARRAY[id] AS visited, 1 AS depth
  FROM nodes WHERE parent_id IS NULL
  UNION ALL
  SELECT n.id, n.parent_id, w.visited || n.id, w.depth + 1
  FROM nodes n JOIN walk w ON n.parent_id = w.id
  WHERE NOT n.id = ANY(w.visited)
    AND w.depth < 50
)
SELECT * FROM walk;
```

## Forward-filling and interval collapsing

Recursion is not only for trees. Two patterns worth knowing:

**Filling a sparse series.** Generate a complete calendar, then left join the sparse facts —
this is how you produce a retention table where "month 3 with zero users" must appear as a
row rather than vanish.

**Collapsing overlapping intervals.** Given `(start_date, end_date)` ranges that overlap,
compute merged intervals by ordering and comparing each row to the running maximum end:

```sql
WITH ordered AS (
  SELECT start_date, end_date,
         MAX(end_date) OVER (ORDER BY start_date
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end
  FROM subscriptions
),
marked AS (
  SELECT *, CASE WHEN prev_max_end IS NULL OR start_date > prev_max_end THEN 1 ELSE 0 END AS new_group
  FROM ordered
)
SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date
FROM (
  SELECT *, SUM(new_group) OVER (ORDER BY start_date) AS grp FROM marked
) g
GROUP BY grp;
```

This is a window-function problem rather than a recursive one, but it is the same family:
state carried forward across ordered rows.

## Performance and limits

Recursion is inherently iterative and row-at-a-time relative to the engine. Practical
guidance:

| Concern | What to do |
|---|---|
| Depth | Bound it explicitly; log when the bound is hit |
| Breadth | Index the join column (`manager_id`), or each iteration is a scan |
| Cycles | Path set, or a depth cap plus a data-quality check |
| Size | Materialise the closure once if it is queried often (closure table) |
| Engine limits | SQL Server `OPTION (MAXRECURSION n)`; Snowflake has a statement timeout; PostgreSQL relies on `statement_timeout` |

SQL Server's `MAXRECURSION` defaults to 100 and is a hard error, not a warning. Set it
deliberately: `OPTION (MAXRECURSION 0)` means unlimited, which converts a data bug into an
outage.

Snowflake supports recursive CTEs, but recursion depth and working-table size are bounded by
the warehouse's resources and the statement timeout; it is not the engine of choice for deep
graph traversal. For genuinely large graphs, a closure table or a dedicated graph engine is
the honest answer.

## Common mistakes

- Forgetting `RECURSIVE` on PostgreSQL, or adding it on SQL Server.
- No termination predicate, or one that depends on the cumulative result rather than the
  previous iteration.
- Recursing on an unindexed parent column.
- Assuming a CTE is evaluated once — SQL Server may evaluate it per reference.
- Using recursion for something a window function does better (running totals, interval
  merging, previous-row comparisons).

## Production notes

Recursive queries are the hardest thing in SQL to cost-estimate, because the planner does not
know how many iterations will occur. Treat the depth bound as a contract: publish it, alert
when it is reached, and make the failure mode a clear error rather than a truncated report.
For hierarchies queried on every page load, precompute the closure (`ancestor, descendant,
depth`) in a nightly job — a join against a closure table is predictable in a way that
recursion is not.
