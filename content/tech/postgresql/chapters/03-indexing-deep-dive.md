# Indexing Deep Dive

PostgreSQL ships six index access methods, and they are not variations on one idea. A B-tree
answers "which rows equal or fall in this range, in order"; GIN answers "which documents contain
this element"; GiST answers "which geometries or ranges overlap this one"; BRIN answers "which
block ranges might contain this value" using almost no disk. Picking the wrong one does not
degrade gracefully — the planner simply stops using it.

## B-tree: the default, and what it actually stores

A B-tree is a balanced tree of 8 kB pages. Interior pages hold separator keys and child pointers;
leaf pages hold keys plus a `ctid` into the heap, and are linked left-to-right so a range scan is
a sequential walk of the leaf level.

```sql
CREATE INDEX idx_orders_customer_ts ON orders (customer_id, order_ts DESC)
  INCLUDE (total_amount, status)
  WITH (fillfactor = 90);
```

- **Column order is the design.** `(customer_id, order_ts)` supports `customer_id = ?` and
  `customer_id = ? AND order_ts > ?`, and supplies ordering for `ORDER BY order_ts`. It does not
  support `order_ts > ?` alone. Equality columns first, range or sort column last.
- **Deduplication** (13+) collapses repeated keys in a leaf when `deduplicate_items = on`
  (default). It is why an index on a low-cardinality leading column is smaller than the
  arithmetic suggests — but it does not make that column selective.
- **`INCLUDE`** adds non-key payload columns at the leaf only. They cannot be searched or sorted
  but they let a query avoid the heap.
- **Index-only scans still visit the heap** unless the visibility map says the page is
  all-visible. `EXPLAIN (ANALYZE)` reports `Heap Fetches: N`; on a write-heavy table that number
  is the gap between the index's promise and reality, and only vacuum closes it.

`fillfactor = 90` leaves a tenth of each leaf page free so inserts land in order rather than
splitting pages. On a monotonically increasing key (a sequence, a timestamp) default 100 is
correct; on random keys 80–90 reduces write amplification measurably.

## GIN: inverted indexes for values inside values

GIN stores, per indexed element, the list of rows containing it. It is the index for `jsonb`,
`text[]`, `tsvector`, and `pg_trgm` similarity.

```sql
CREATE INDEX idx_products_attrs ON products USING gin (attrs jsonb_path_ops);
CREATE INDEX idx_orders_tags   ON orders   USING gin (tags);
```

- `jsonb_ops` (default) supports `@>`, `?`, `?|`, `?&`. `jsonb_path_ops` supports only `@>` but is
  roughly half the size and faster for containment — which is most queries.
- GIN is **lossy**: a bitmap can point at a page that no longer matches, so `EXPLAIN` shows
  `Rows Removed by Index Recheck`. That is normal, not a misconfiguration.
- `fastupdate = on` (default) buffers new entries in a pending list flushed by vacuum or when
  `gin_pending_list_limit` (4 MB) is exceeded. This makes inserts cheap and recent rows slower to
  find; on a bulk load, create the index afterwards.
- Index build is the expensive part: GIN builds are memory-hungry and `maintenance_work_mem`
  governs their speed far more than CPU.

## GiST and SP-GiST: trees for things that are not scalars

GiST is a balanced tree of *predicates*: each node covers a bounding box, range or prefix, and a
search descends only into nodes whose predicate could match. It is extendable, which is why
PostGIS, `tsrange`/`tstzrange` exclusion constraints and `pg_trgm` all use it.

```sql
CREATE INDEX idx_bookings_period ON bookings USING gist (period);
SELECT * FROM bookings WHERE period && tstzrange(now(), now() + interval '1 hour');

ALTER TABLE bookings ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (room_id WITH =, period WITH &&);
```

That `EXCLUDE` constraint is the one thing only GiST can do: a uniqueness rule over a range
overlap, enforced by the index itself. KNN ordering (`ORDER BY embedding <-> query`) is also a
GiST feature, via the distance operator.

SP-GiST partitions space instead of balancing on order — quadtrees, k-d trees, radix trees. It
shines for text prefix search (`text_ops` supports `LIKE 'abc%'` without `pg_trgm`), `inet`
containment, and point data with natural clustering. It does not support KNN.

## BRIN: an index for tables that are already sorted

BRIN stores, for each range of `pages_per_range` heap blocks (default 128, i.e. 1 MB), the minimum
and maximum value of the indexed column. A 1 TB append-only table gets an index of a few hundred
kilobytes.

```sql
CREATE INDEX idx_events_ts ON events USING brin (created_at)
  WITH (pages_per_range = 32);
```

It works only when physical order correlates with value order — an append-only event table, a
time-series table loaded in order, an IoT table partitioned by device insert order. Check
`pg_stats.correlation` for the column: near 1.0 means BRIN will be effective; near 0 means every
block range matches and the index is dead weight.

```sql
SELECT attname, correlation FROM pg_stats
WHERE tablename = 'events' AND attname = 'created_at';
```

BRIN is also the cheapest index to maintain: inserts touch at most one summary entry, and
`brin_summarize_new_values('idx_events_ts')` fills in ranges created since the last summarise.

## Partial, expression, and covering indexes

A **partial index** indexes a subset, which is both smaller and cheaper to maintain:

```sql
CREATE INDEX idx_orders_pending ON orders (created_at)
  WHERE status = 'pending';
```

The planner uses it only when it can prove your query's predicate implies the index predicate.
`WHERE status = 'pending'` qualifies; `WHERE status IN ('pending','paid')` does not, and
`WHERE status = $1` does not unless the parameter is a constant at plan time. A partial index on
the 2% of rows that are actually queried is often a 50× size win.

An **expression index** indexes a computed value, and requires the expression to be immutable:

```sql
CREATE INDEX idx_users_email_lower ON users (lower(email));
SELECT * FROM users WHERE lower(email) = 'a@b.com';   -- uses it
SELECT * FROM users WHERE email ILIKE 'A@B.COM';      -- does not
```

`now()`, `CURRENT_DATE` and anything timezone-dependent are `STABLE`, not `IMMUTABLE`, and cannot
appear in an index definition.

## Choosing, and paying

| Need | Index | Notes |
| --- | --- | --- |
| Equality and range on scalars, ordering | B-tree | Default choice; supports `INCLUDE` |
| Containment in `jsonb`, arrays, full-text | GIN | Lossy, slow to build, fast to query |
| Overlap of ranges/geometry, KNN distance | GiST | Also the only way to enforce `EXCLUDE` |
| Prefix match, `inet`, spatial partitioning | SP-GiST | No KNN, no ordering |
| Huge append-only tables, range predicates | BRIN | Tiny; needs physical correlation |
| Equality only on very long values | Hash | Rarely wins; no range, no ordering |

Every index is a write cost: one heap insert becomes one insert per index, and each index removes
HOT opportunities. The measurement that matters is
`pg_stat_user_indexes.idx_scan` — an index with zero scans over a full statistics period is
maintenance you are paying for and not using, and `pg_stat_user_tables.seq_scan` on a large table
with a usable index suggests the index is not selective enough to be chosen.

## Production notes

- Build with `CREATE INDEX CONCURRENTLY` on live tables. It cannot run inside a transaction block,
  takes two passes over the table, and can leave an `INVALID` index if it fails — check
  `pg_index.indisvalid` and drop/recreate rather than assuming success.
- `REINDEX INDEX CONCURRENTLY` (12+) rebuilds without blocking writes; `pg_stat_progress_create_index`
  shows progress.
- A failed `CONCURRENTLY` build holds a lock on the table until the transaction ends. Always run it
  with `lock_timeout` set so it fails fast instead of queueing every writer behind it.
- Index bloat is real: after heavy churn, `REINDEX` can halve index size. Check with
  `pgstattuple` on the index relation, not the table.

## Common mistakes

- Indexing a low-cardinality column alone and expecting a win at 30% selectivity.
- Expecting a foreign key to create an index. It does not; the child column needs one explicitly.
- Wrapping the indexed column in a function in the `WHERE` clause and calling the index broken.
- Adding a partial index whose predicate the query cannot imply.
- Building a GIN index on `json` (text) instead of `jsonb` — the operator classes do not apply.
