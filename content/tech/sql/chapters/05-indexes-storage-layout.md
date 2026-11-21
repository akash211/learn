# Indexes and Storage Layout

An index is a redundant, sorted copy of part of a table. Every index makes reads cheaper and
writes more expensive, so the design question is never "should this column be indexed" but
"which access paths does this workload actually need". Answering it requires knowing what the
storage engine does underneath — and that answer is completely different for a row store and
a columnar warehouse.

## Pages, rows and the heap

Row-store engines (PostgreSQL, SQL Server) move data in fixed-size pages — 8 kB in both. A
row cannot span pages arbitrarily, so very wide rows are pushed out: PostgreSQL uses TOAST
(the oversized values go to a side table, compressed), SQL Server caps an in-row row at 8,060
bytes and moves `VARCHAR(MAX)`/`NVARCHAR(MAX)` off-row.

Two consequences follow:

1. **Rows are physically clustered by insertion order, not by key** — unless you tell the
   engine otherwise.
2. **Wide rows mean fewer rows per page**, so every full scan reads more pages. A table with
   forty unused `VARCHAR(500)` columns costs real I/O even if nobody selects them.

## B-tree indexes

A B-tree is a balanced tree of pages: root, interior levels, leaf level. Each interior page
holds key values plus pointers to child pages, so a lookup is `log n` page reads. The leaf
level holds the key and either the row location (PostgreSQL: a TID pointing at a heap page;
SQL Server nonclustered: the clustering key or a row locator).

```sql
CREATE INDEX idx_orders_customer_ts
  ON orders (customer_id, order_ts DESC);
```

**Column order is the whole design.** A composite index on `(customer_id, order_ts)` supports:

- `WHERE customer_id = ?` — yes (leftmost prefix)
- `WHERE customer_id = ? AND order_ts > ?` — yes, as a range on the second column
- `WHERE order_ts > ?` — no (the leading column is missing, so the index cannot be seeked;
  some engines can scan it fully, but that is rarely better than the table)

Leading equality columns first, then the range/sort column. An index on `(a, b)` is not an
index on `(b, a)`.

**Covering indexes** include every column the query needs so the engine never touches the
heap. PostgreSQL has `INCLUDE`:

```sql
CREATE INDEX idx_orders_customer_covering
  ON orders (customer_id, order_ts) INCLUDE (total_amount, status);
```

SQL Server has the same syntax and calls the result a covering index when all referenced
columns are present. The trade-off is size and write cost: every `INCLUDE` column is copied
on every insert.

**Index-only scans** require more than a covering index in PostgreSQL. The visibility map
must show the page as all-visible, which means autovacuum has run recently. A table with
heavy write traffic will show `Heap Fetches: N` in `EXPLAIN (ANALYZE)` even with a perfect
covering index — that is not a bug, it is MVCC.

## Selectivity is relative

An index on a column with three distinct values is usually useless for a single-value
predicate: the planner will prefer a sequential scan because reading 33% of the table through
random I/O is slower than reading it linearly. An index on `email` (millions of distinct
values) is excellent. The threshold is engine- and workload-specific, but the principle is
not: **indexes pay when the predicate is selective, or when the index supplies an ordering
the query needs.**

Ordering is the underrated case. `ORDER BY order_ts DESC LIMIT 20` on a table with an index on
`order_ts` is an index scan that stops after 20 rows. Without the index it is a full scan plus
a sort of everything.

## SQL Server: clustered versus heap

In SQL Server, the **clustered index is the table**. Its leaf level *is* the data, ordered by
the clustering key. A heap (no clustered index) stores rows unordered with a row identifier.

- Every nonclustered index carries the clustering key as its row locator. A wide clustering
  key (say, a `UNIQUEIDENTIFIER`) therefore bloats every nonclustered index.
- A lookup by clustering key is a seek; a lookup by anything else through a nonclustered index
  is a seek plus a **key lookup** (random I/O per row). Past a few hundred rows the optimiser
  switches to a scan.
- Sequential `UNIQUEIDENTIFIER` keys (NEWSEQUENTIALID) avoid page splits that random GUIDs
  cause; random GUIDs fragment the clustered index badly.

PostgreSQL has no clustered index, but `CLUSTER table USING index` rewrites the heap in index
order once — it does not stay clustered as rows are updated.

## Updates, bloat and fill factor

Both engines do in-place updates when possible, but an update that changes an indexed column
or grows the row may require a new row version.

- PostgreSQL writes a new tuple version and leaves the old one for vacuum. Long-running
  transactions hold back vacuum, the table bloats, scans slow down. `VACUUM (VERBOSE)` and
  `pg_stat_user_tables.n_dead_tup` are the diagnostics.
- **HOT updates** avoid touching indexes when no indexed column changes and the new version
  fits on the same page — which is why over-indexing hurts more than it looks: every index
  removes a HOT opportunity.
- SQL Server uses **fill factor** to leave free space on pages for future inserts, trading
  density for fewer page splits. Default 100 (full pages) is right for read-mostly tables and
  wrong for random-key insert-heavy ones.

## Snowflake: no indexes, different physics

Snowflake has no user-created indexes on standard tables. Data is stored in **micro-partitions**
— immutable, compressed, columnar chunks (roughly 50–500 MB uncompressed) — and each
partition carries metadata: the minimum and maximum value of every column, the number of
distinct values, and NULL counts.

The optimiser uses that metadata to **prune**: if a query filters `order_ts >= '2026-01-01'`
and a partition's maximum `order_ts` is 2025-12-31, the partition is never read. This is why
`SELECT *` and non-sargable predicates are expensive in a way that has nothing to do with
row count — they force every partition to be scanned.

```sql
-- Prunes well: constant predicate on a column correlated with load order
SELECT COUNT(*) FROM orders WHERE order_ts >= '2026-01-01';

-- Prunes badly: the function hides the column from partition metadata
SELECT COUNT(*) FROM orders WHERE YEAR(order_ts) = 2026;
```

**Clustering keys** physically co-locate similar values so that pruning stays effective as
data grows:

```sql
ALTER TABLE orders CLUSTER BY (customer_id, order_ts);
```

Clustering is not free: Snowflake runs a background reclustering service that consumes
credits, and a bad key (high cardinality, or one that does not match query predicates) buys
nothing. Choose the columns that appear in the `WHERE` clause of your most expensive queries,
in order of selectivity.

**Search Optimization Service** is the closest thing to an index: it maintains a persistent
search access path for equality and substring predicates on specified columns. It is a
paid feature, and it is not a substitute for clustering on range predicates.

## How many indexes?

Every index adds write amplification: an insert writes the heap plus one entry per index; an
update of an indexed column does the same. On an OLTP table with eight indexes, a single
insert can touch nine pages. Guidelines:

- Index the primary key and the foreign keys you join on (PostgreSQL does **not** create an
  index for a foreign key automatically — this is a common performance surprise).
- Index the columns in `WHERE`, `JOIN` and `ORDER BY` of your top queries, not every column.
- Drop unused indexes: PostgreSQL `pg_stat_user_indexes.idx_scan`, SQL Server
  `sys.dm_db_index_usage_stats`.
- Prefer one composite index over several single-column ones when the queries have a common
  leading predicate.

## Common mistakes

- Wrapping the indexed column in a function: `WHERE DATE(order_ts) = '2026-01-01'` cannot use
  a plain B-tree index. Use a range: `order_ts >= '2026-01-01' AND order_ts < '2026-01-02'`.
- Indexing low-cardinality columns alone and expecting a win.
- Assuming a foreign key is indexed.
- Adding an index to fix a query whose real problem is a bad estimate or a fan-out join.
- On Snowflake, clustering on a high-cardinality column that no query filters on.

## Production notes

Index changes are schema changes: they need a migration, a rollback plan, and a measurement.
`CREATE INDEX CONCURRENTLY` (PostgreSQL) avoids blocking writes but takes longer and can fail
leaving an invalid index; SQL Server's `ONLINE = ON` requires Enterprise edition. Measure the
plan before and after, and keep the before-plan — "it got faster" is not evidence, a changed
access path is.
