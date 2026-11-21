# Indexes: B+Trees, Covering, Cardinality, and Index Merge

An InnoDB index is a data structure that changes the amount and pattern of work needed to find rows. Most MySQL indexes are B+trees: internal pages direct a search to leaf pages, and leaf entries are ordered by key. Choosing an index is not simply a matter of indexing every filter column. Key order, selectivity, row lookup cost, write amplification, and the actual query predicates all determine whether an index helps.

## The clustered index defines row storage

InnoDB stores each table as a clustered index. The leaf pages of the primary-key B+tree contain the full row, so a primary-key lookup reaches the row directly. If no primary key exists, InnoDB uses the first suitable `UNIQUE` index whose key columns are all `NOT NULL`; otherwise it creates a hidden clustered row identifier. A deliberate primary key avoids relying on that fallback and makes row identity explicit.

Every secondary-index leaf record contains its indexed key plus the table's primary-key columns. A secondary-index lookup therefore finds the primary key in the secondary tree, then follows it to the clustered tree to fetch non-indexed columns. This is a second traversal and potentially a random page read. A wide primary key is repeated in every secondary index, so key width affects storage, cache density, and write cost throughout the table. Prefer stable, compact keys when the domain permits, while accounting for distributed ID generation and insertion patterns.

## Composite indexes and the leftmost prefix

The order of columns in a composite index defines the usable search prefixes. An index on `(tenant_id, created_at, status)` can efficiently locate a tenant and a time range, and can often use `status` as a residual condition after the range. It generally cannot seek directly to a `created_at` value without the leading tenant key. Equality predicates commonly come before the first range column; ordering and grouping requirements may further influence order.

```sql
CREATE INDEX idx_orders_tenant_time ON orders (tenant_id, created_at DESC);

SELECT order_id, created_at
FROM orders
WHERE tenant_id = 42
  AND created_at >= '2026-01-01'
ORDER BY created_at DESC
LIMIT 50;
```

Index key order also influences sort avoidance. Match the query's equality, range, and ordering pattern rather than copying the WHERE clause column list mechanically. MySQL 8.0 supports descending key parts. The optimizer may use a prefix of the index and evaluate remaining conditions after locating candidate rows. A range condition often limits use of later key parts for narrowing, though later parts may still help coverage or filtering.

## Covering indexes and write costs

A covering index contains all columns needed for a query, allowing InnoDB to answer from the secondary index without fetching each clustered row. This can reduce random I/O, especially for a narrow projection over many candidate rows. But a covering index is not free: every added column makes leaf records wider, reduces page fan-out, consumes buffer pool and disk, and makes inserts and updates more expensive. Only add payload columns after confirming that the avoided row lookups matter.

```sql
CREATE INDEX idx_orders_lookup
  ON orders (tenant_id, status, created_at);

EXPLAIN SELECT created_at
FROM orders
WHERE tenant_id = 42 AND status = 'open';
```

MySQL's InnoDB secondary records already carry the primary key, but unlike PostgreSQL's `INCLUDE`, MySQL does not offer a separate non-key include list for ordinary B-tree indexes. A column appended for coverage participates in the ordered key and changes index semantics and size.

## Cardinality and selectivity

Cardinality in index metadata is an estimate of distinct key values, not an exact per-query selectivity guarantee. Statistics inform the optimizer's cost comparison: an index that narrows a million rows to ten may be attractive, while a low-cardinality flag that matches half the table may cost more than a scan. InnoDB statistics can be sampled and may become stale after substantial data changes. `ANALYZE TABLE` refreshes key distribution estimates; it does not make every estimate exact or permanently correct.

```sql
SHOW INDEX FROM orders;
ANALYZE TABLE orders;
```

Check the estimated row count in `EXPLAIN` against observed behavior from safe representative queries. Avoid forcibly pinning an index based only on a single explain result; data skew, parameter values, and table growth may make the hint a future regression. Histogram statistics can improve estimates for skewed non-indexed columns, but they do not replace a well-designed access path.

## Index Merge and alternatives

Index Merge is an optimizer strategy that combines multiple range scans, often with intersection for `AND` or union for `OR`, then retrieves matching rows. It can be useful when separate indexes are already present and each predicate is selective. It is not automatically equivalent to a composite index. Combining scans, deduplicating row identifiers, and fetching table rows may cost more than a composite access path that finds the conjunction directly.

```sql
EXPLAIN SELECT * FROM orders
WHERE customer_id = 42 AND status = 'open';
```

When the same query repeatedly combines predicates, compare the observed plan with a composite index such as `(customer_id, status)`. Conversely, an index merge can be reasonable when several independent query shapes use different individual indexes. Confirm with execution data, not the `Using intersect(...)` or `Using union(...)` label alone.

## Reading index evidence

`EXPLAIN` reports the chosen access method, possible and selected keys, estimated rows, and extra properties. `type=range` means a range scan, `ref` an equality lookup using a nonunique key, `eq_ref` a unique lookup in a join, and `ALL` a table scan. Those labels describe access, not performance in isolation. A full scan of a tiny table may be best. A lookup returning a large fraction of a large table may still be expensive even when it uses an index.

A primary key should usually be immutable. Updating it changes clustered placement and all secondary records that carry it. Foreign-key columns on the child side should be indexed to make parent changes and joins efficient; InnoDB requires suitable indexes for foreign keys and may create one if none exists, but explicit naming and review make the schema easier to reason about.

## Production notes

- Inventory unused and redundant indexes, but measure across a complete workload cycle before removing them.
- Each additional index increases write work and can lengthen locks or replication apply time.
- Check actual key length limits, character set, collation, and prefix-index semantics for string keys.
- Use invisible indexes in supported MySQL 8.0 releases to test optimizer behaviour without immediately dropping an index; verify availability for your exact version.

## Common mistakes

- Indexing every column independently instead of matching composite query patterns.
- Treating low cardinality as a binary reason never to index; combined predicates can still be selective.
- Forgetting that a wide primary key is stored in every InnoDB secondary index.
- Assuming Index Merge is always as efficient as one composite index.
- Calling every index plan faster than a table scan without considering rows read and clustered lookups.
