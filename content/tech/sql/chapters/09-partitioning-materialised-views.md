# Partitioning, Materialised Views and Access Patterns

Two techniques dominate physical design at scale: split a large table into pieces the engine
can skip, and precompute answers so the engine does not have to derive them. Both are
trade-offs about freshness and maintenance, and both are frequently applied to the wrong
problem.

## Partitioning: splitting the table

A partitioned table is one logical relation stored as many physical ones. The engine routes
each row to a partition using a **partition key**, and — crucially — can skip partitions whose
key range cannot match the query. That skipping is called **partition pruning**, and it is the
entire point.

PostgreSQL declarative partitioning:

```sql
CREATE TABLE orders (
  order_id     BIGINT NOT NULL,
  customer_id  BIGINT NOT NULL,
  order_ts     TIMESTAMP NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL
) PARTITION BY RANGE (order_ts);

CREATE TABLE orders_2026_01 PARTITION OF orders
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE orders_2026_02 PARTITION OF orders
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE INDEX ON orders (customer_id, order_ts);
```

The index on the parent is created on every partition automatically. A query with
`WHERE order_ts >= '2026-02-01'` prunes to the February partition; a query without a predicate
on `order_ts` reads all of them — partitioning helps only the queries that filter on the key.

SQL Server requires more ceremony: a **partition function** maps values to numbers, a
**partition scheme** maps numbers to filegroups, and the table is created `ON` the scheme.

```sql
CREATE PARTITION FUNCTION pf_month (datetime2)
  AS RANGE RIGHT FOR VALUES ('2026-02-01','2026-03-01','2026-04-01');
CREATE PARTITION SCHEME ps_month
  AS PARTITION pf_month ALL TO ([PRIMARY]);

CREATE TABLE orders (
  order_id    BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  order_ts    datetime2 NOT NULL,
  total_amount decimal(12,2) NOT NULL
) ON ps_month (order_ts);
```

`RANGE RIGHT` means the boundary value belongs to the partition on the right, which is the
convention that matches "month starts on the 1st". Getting `RANGE LEFT` versus `RIGHT`
backwards produces off-by-one-month partitions that nobody notices until a report is wrong.

**Snowflake has no partitions.** Micro-partitions are created automatically as data is
loaded, and pruning happens through their min/max metadata. You influence it with clustering
keys, not DDL. Do not port a `PARTITION BY` clause and expect a performance win; the
equivalent lever is `CLUSTER BY`.

## What partitioning actually buys

| Benefit | Mechanism |
|---|---|
| Pruning | Fewer partitions read for filtered queries |
| Cheap retention | `DROP`/`TRUNCATE` a partition instead of `DELETE` millions of rows |
| Smaller maintenance | Vacuum, reindex, and statistics run per partition |
| Partition-wise joins | Two tables partitioned identically can join partition by partition |
| Load isolation | A bulk load into one partition does not touch the others |

And what it costs:

- **More objects.** A daily partition on five years of data is ~1,800 tables; DDL, backups and
  catalog queries get slower.
- **Cross-partition queries.** A query without the key is now *worse* than before, because it
  unions many physical tables.
- **Unique constraints are hard.** PostgreSQL requires a unique constraint to include the
  partition key, so "unique email globally" is impossible on a table partitioned by date
  without a separate lookup table.
- **Routing overhead** on insert, small but non-zero.

Retention is the underrated use. `ALTER TABLE orders DETACH PARTITION orders_2025_01` then
`DROP TABLE` releases space instantly; the equivalent `DELETE FROM orders WHERE order_ts < …`
writes WAL, bloats the table, and needs vacuum. On a high-volume event table, partition-based
retention is often the deciding argument.

## Materialised views: cached query results

A materialised view stores the *result* of a query, not the query itself. Reads are fast;
writes are stale until you refresh.

**PostgreSQL** has real, manual materialised views:

```sql
CREATE MATERIALIZED VIEW mv_daily_revenue AS
SELECT
  o.order_ts::date AS order_date,
  c.country,
  SUM(o.total_amount) AS revenue,
  COUNT(*)            AS orders
FROM orders o
JOIN customers c USING (customer_id)
WHERE o.status = 'completed'
GROUP BY 1, 2;

CREATE UNIQUE INDEX ON mv_daily_revenue (order_date, country);

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_revenue;
```

`CONCURRENTLY` allows reads during refresh but requires a unique index on the view and is
slower — it diffs rather than rebuilds. Without it, `REFRESH` takes an `ACCESS EXCLUSIVE` lock
and the view is unreadable while it rebuilds. There is no automatic refresh: you schedule it
(`pg_cron`, an external scheduler) and you own the staleness.

**SQL Server** has indexed views, which are maintained synchronously on every base-table
write rather than refreshed:

```sql
CREATE VIEW dbo.v_order_totals
WITH SCHEMABINDING AS
SELECT customer_id, COUNT_BIG(*) AS order_count, SUM(total_amount) AS revenue
FROM dbo.orders
GROUP BY customer_id;

CREATE UNIQUE CLUSTERED INDEX IX_v_order_totals
  ON dbo.v_order_totals (customer_id);
```

The restrictions are severe: `SCHEMABINDING` is required, and the view cannot contain outer
joins, subqueries, `UNION`, `DISTINCT`, or most window functions. Aggregates must include
`COUNT_BIG(*)`. In exchange, reads hit an index instead of scanning, and there is no staleness
— at the cost of write amplification on every insert.

**Snowflake** materialised views are auto-maintained by a background service, restricted to a
single table with no joins or subqueries, and consume credits for maintenance. They are useful
for expensive single-table aggregations, not for joining a fact to five dimensions. For that,
the idiomatic answer is a scheduled `CREATE OR REPLACE TABLE … AS SELECT` (a "dynamic table" in
newer accounts), which is a batch job with explicit freshness.

## Choosing the pattern

Ask three questions:

1. **How stale can the answer be?** Seconds → indexed view or nothing. Minutes → dynamic
   table/Snowflake MV. Hours → scheduled summary table. Days → static extract.
2. **How expensive is the source query?** If it takes 200 ms, cache at the application layer,
   not in the database.
3. **How often does the underlying data change?** A synchronously maintained view on a
   write-heavy table is a write-amplification tax on every transaction.

A summary table built by a scheduled job is the most portable and most debuggable option: it
is just a table, its freshness is visible in a `loaded_at` column, and rebuilding it is a
`TRUNCATE`/`INSERT`. Materialised views are better when you want the database to own the
dependency, and worse when you need to backfill, audit, or partially refresh.

## Pre-aggregation and the grain trap

Pre-aggregating to the wrong grain is the classic warehouse bug. If the summary is at
`(date, country)` and someone joins it to `orders` to get customer detail, every row multiplies.

```sql
-- Safe: aggregate the detail to the summary's grain, then join
SELECT s.order_date, s.country, s.revenue, d.manager
FROM mv_daily_revenue s
JOIN dim_country d USING (country);
```

Keep summary tables narrow, name them for their grain (`agg_orders_daily_by_country`), and
never join a summary to a table at a finer grain without re-aggregating first.

## Result and warehouse caches

- **Snowflake result cache**: identical query text within 24 hours returns the cached result
  without starting a warehouse, as long as the underlying tables have not changed. This
  rewards deterministic SQL and punishes `SELECT … WHERE order_ts > CURRENT_TIMESTAMP()`,
  which is never cacheable because the text or the value changes.
- **PostgreSQL**: no result cache, but `shared_buffers` and the OS page cache make repeated
  scans cheap. `pg_prewarm` can load a table into memory after restart.
- **SQL Server**: plan cache and buffer pool; `OPTION (RECOMPILE)` prevents plan reuse, not
  result reuse.

Application-level caching is usually a bigger win than database-level caching for dashboard
queries, and it moves the staleness decision to where the product requirement lives.

## Common mistakes

- Partitioning by a column that queries do not filter on — the pruning never happens.
- Creating thousands of tiny partitions.
- Expecting a PostgreSQL materialised view to refresh itself.
- Using `REFRESH MATERIALIZED VIEW` (non-concurrent) on a view that serves live traffic.
- Indexed views on write-heavy OLTP tables, then wondering why inserts slowed down.
- Joining a pre-aggregated table to detail at a finer grain.

## Production notes

Partitioning and materialisation are both schema-level commitments with an operational tail:
partition creation must be automated before it is needed, and refresh jobs need monitoring,
idempotency, and a backfill path. Add a `loaded_at`/`refreshed_at` column to every derived
table — the first question in any data incident is "how old is this number", and the answer
should not require reading a scheduler's logs.
