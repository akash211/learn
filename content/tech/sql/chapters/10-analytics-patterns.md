# Analytics Patterns

A small number of query shapes account for most analytical SQL: running totals, period-over-
period comparison, finding gaps and islands, sessionisation, funnels, cohorts, and versioned
dimensions. They are worth memorising as patterns rather than deriving from scratch each time,
because each has a subtlety that is easy to get wrong under deadline.

## Running totals and moving windows

```sql
SELECT
  order_ts::date AS order_date,
  total_amount,
  SUM(total_amount) OVER (
    ORDER BY order_ts
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_total,
  AVG(total_amount) OVER (
    ORDER BY order_ts
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS moving_avg_7_orders
FROM orders
WHERE status = 'completed';
```

Two distinctions matter. `ROWS BETWEEN 6 PRECEDING` is a window of seven *rows*, which is not
the same as seven *days* — the latter needs `RANGE BETWEEN INTERVAL '6 days' PRECEDING AND
CURRENT ROW` and works only on date/time ordering columns. And `SUM(...) OVER (ORDER BY …)`
without an explicit frame is `RANGE UNBOUNDED PRECEDING TO CURRENT ROW`, which includes ties;
specifying `ROWS` makes it deterministic.

For a running total that must reset per period, add the period to `PARTITION BY` and keep
`ORDER BY order_ts ROWS UNBOUNDED PRECEDING`.

## Period-over-period

`LAG` with a fixed offset is the cheapest form when the series is dense — one row per month,
no missing months:

```sql
WITH monthly AS (
  SELECT DATE_TRUNC('month', order_ts) AS month, SUM(total_amount) AS revenue
  FROM orders WHERE status = 'completed'
  GROUP BY 1
)
SELECT
  month,
  revenue,
  LAG(revenue, 12) OVER (ORDER BY month) AS revenue_last_year,
  ROUND(100.0 * (revenue - LAG(revenue, 12) OVER (ORDER BY month))
        / NULLIF(LAG(revenue, 12) OVER (ORDER BY month), 0), 1) AS yoy_pct
FROM monthly
ORDER BY month;
```

`LAG(revenue, 12)` is only correct if every month is present. A single missing month shifts
the comparison by one and the error is invisible in the output. Either build a date spine and
left join, or join on the explicit key:

```sql
LEFT JOIN monthly prev
  ON prev.month = monthly.month - INTERVAL '1 year'
```

`NULLIF` prevents division by zero.

## Gaps and islands

An **island** is a run of consecutive rows (consecutive dates, consecutive IDs). A **gap** is
what is missing between islands. The standard trick: subtract a row number from the ordering
value. Within a consecutive run, both increase by one, so the difference is constant.

```sql
WITH daily AS (
  SELECT DISTINCT customer_id, order_ts::date AS order_date
  FROM orders
),
marked AS (
  SELECT
    customer_id,
    order_date,
    order_date - ROW_NUMBER() OVER (
      PARTITION BY customer_id ORDER BY order_date
    )::int AS grp          -- PostgreSQL: date - integer = date
  FROM daily
)
SELECT
  customer_id,
  MIN(order_date) AS island_start,
  MAX(order_date) AS island_end,
  COUNT(*)        AS consecutive_days
FROM marked
GROUP BY customer_id, grp
ORDER BY customer_id, island_start;
```

In SQL Server the arithmetic is `DATEADD(day, -1 * ROW_NUMBER() OVER (...), order_date)`; in
Snowflake, `DATEADD('day', -1 * ROW_NUMBER() OVER (...), order_date)`. The cast matters in
PostgreSQL because `date - bigint` is not defined.

To find the **gaps**, generate a complete spine and anti-join:

```sql
WITH RECURSIVE spine AS (
  SELECT MIN(order_ts::date) AS d FROM orders
  UNION ALL
  SELECT d + 1 FROM spine WHERE d < (SELECT MAX(order_ts::date) FROM orders)
),
present AS (SELECT DISTINCT order_ts::date AS d FROM orders)
SELECT s.d AS missing_date
FROM spine s
LEFT JOIN present p ON p.d = s.d
WHERE p.d IS NULL;
```

For a *threshold* gap ("no order for 30 days"), the island approach generalises: compare each
row to the previous one with `LAG`, flag where the delta exceeds the threshold, then running-
sum the flags to form groups.

## Sessionisation

Turning raw events into sessions is the same gap-and-island idea with a time threshold:

```sql
WITH flagged AS (
  SELECT
    user_id,
    event_ts,
    CASE
      WHEN LAG(event_ts) OVER (PARTITION BY user_id ORDER BY event_ts) IS NULL
        OR event_ts > LAG(event_ts) OVER (PARTITION BY user_id ORDER BY event_ts)
                      + INTERVAL '30 minutes'
      THEN 1 ELSE 0
    END AS is_new_session
  FROM events
),
numbered AS (
  SELECT
    user_id, event_ts,
    SUM(is_new_session) OVER (
      PARTITION BY user_id ORDER BY event_ts
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS session_no
  FROM flagged
)
SELECT
  user_id, session_no,
  MIN(event_ts) AS session_start,
  MAX(event_ts) AS session_end,
  COUNT(*)      AS events,
  MAX(event_ts) - MIN(event_ts) AS duration
FROM numbered
GROUP BY user_id, session_no;
```

The `IS NULL` branch handles each user's first event: without it the comparison is UNKNOWN,
the `CASE` falls through to 0, and the first session merges into session zero.

## Cohorts and retention

A cohort is a group defined by a shared starting event — usually first purchase month. Retention
is the share of that cohort active in later periods.

```sql
WITH first_order AS (
  SELECT customer_id, DATE_TRUNC('month', MIN(order_ts)) AS cohort_month
  FROM orders
  WHERE status = 'completed'
  GROUP BY customer_id
),
activity AS (
  SELECT DISTINCT
    o.customer_id,
    f.cohort_month,
    DATE_TRUNC('month', o.order_ts) AS activity_month
  FROM orders o
  JOIN first_order f USING (customer_id)
  WHERE o.status = 'completed'
)
SELECT
  cohort_month,
  DATEDIFF('month', cohort_month, activity_month) AS month_offset,
  COUNT(DISTINCT customer_id) AS active_customers
FROM activity
GROUP BY 1, 2
ORDER BY 1, 2;
```

`DATEDIFF('month', a, b)` is the Snowflake form; SQL Server uses `DATEDIFF(month, a, b)`.
PostgreSQL has no direct equivalent: use
`(EXTRACT(YEAR FROM age(activity_month, cohort_month)) * 12
 + EXTRACT(MONTH FROM age(activity_month, cohort_month)))::int`.

The output is long-format; pivoting to a triangle (one column per month offset) is a
presentation concern. Do it in the BI layer if possible — `CASE`-based pivots hard-code the
number of periods and break as the horizon grows.

**Cohort size matters as much as the rate.** Emit the denominator, or a cohort of four users
produces a 75% curve that dominates the chart.

## Funnels

```sql
SELECT
  COUNT(DISTINCT CASE WHEN step >= 1 THEN user_id END) AS viewed,
  COUNT(DISTINCT CASE WHEN step >= 2 THEN user_id END) AS added_to_cart,
  COUNT(DISTINCT CASE WHEN step >= 3 THEN user_id END) AS purchased
FROM (
  SELECT user_id,
    MAX(CASE WHEN event = 'view'      THEN 1 ELSE 0 END) AS step1,
    MAX(CASE WHEN event = 'add_cart'  THEN 1 ELSE 0 END) AS step2,
    MAX(CASE WHEN event = 'purchase' THEN 1 ELSE 0 END) AS step3,
    GREATEST(
      MAX(CASE WHEN event = 'view'      THEN 1 ELSE 0 END),
      MAX(CASE WHEN event = 'add_cart'  THEN 2 ELSE 0 END),
      MAX(CASE WHEN event = 'purchase' THEN 3 ELSE 0 END)
    ) AS step
  FROM events
  GROUP BY user_id
) u;
```

It computes "reached at least step N", which is the usual funnel definition. It does **not**
enforce ordering (a purchase without a view still counts as step 3). Strict ordering needs the
first timestamp of each step and a comparison chain, which is more expensive.

## Slowly changing dimensions

A type-1 change overwrites the attribute; history is lost. A type-2 change adds a row with
validity dates, preserving history.

```sql
-- Type 2: close the current version, insert the new one
UPDATE dim_customer
SET valid_to = CURRENT_DATE - 1, is_current = FALSE
WHERE customer_id = 42 AND is_current = TRUE;

INSERT INTO dim_customer
  (customer_key, customer_id, country, valid_from, valid_to, is_current)
VALUES
  (9001, 42, 'IN', CURRENT_DATE, DATE '9999-12-31', TRUE);
```

Then join facts at the time they occurred, using a half-open interval:

```sql
SELECT o.order_id, c.country
FROM orders o
JOIN dim_customer c
  ON c.customer_id = o.customer_id
 AND o.order_ts >= c.valid_from
 AND o.order_ts <  c.valid_to;
```

Use `< valid_to`, not `<=`: with a sentinel `9999-12-31` and daily granularity, `<=` double-
counts the boundary day. Prefer deriving `valid_to` as `LEAD(valid_from) - 1 day` rather than
maintaining it with updates — it removes the window in which two versions are both "current".

Snowflake and BigQuery make this cheaper with `MERGE`; dbt snapshots implement exactly this
pattern and add a `dbt_valid_from`/`dbt_valid_to` pair. The pattern is the same everywhere: a
surrogate key per version, a natural key, validity bounds, and a current flag that is derived,
not trusted.

## Common mistakes

- Using `ROWS` when you meant calendar days, or vice versa.
- `LAG(x, 12)` on a series with missing months.
- Forgetting `NULLIF` on a ratio and dividing by zero.
- Building a funnel that does not enforce order but calling it a funnel.
- SCD2 joins with `BETWEEN` on inclusive bounds.

## Production notes

These patterns all benefit from being materialised once rather than recomputed per dashboard
tile: a `fct_sessions` or `dim_customer_history` table turns an expensive window query into a
cheap scan. Name the grain in the table name, test uniqueness on the key, and record the
`loaded_at`. The pattern that survives is the one with a test attached.
