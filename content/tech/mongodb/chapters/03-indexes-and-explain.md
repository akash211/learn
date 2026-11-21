# Indexes and Explain Plans

An index is a maintained access path, not a free cache. MongoDB's default `_id` index supports identity lookups; other indexes should be designed from real filters, sorts, and projections. Each index consumes memory and disk and adds work to inserts, updates, deletes, replication, and builds. The question is not "can this field be indexed?" but "does this index reduce the measured work enough to justify its costs?"

## Compound indexes and prefixes

A compound index orders keys lexicographically. For a frequent request filtering by tenant and state, then sorting newest first, a candidate is:

```javascript
db.orders.createIndex({ tenantId: 1, status: 1, createdAt: -1 })
db.orders.find({ tenantId: "t-9", status: "open" }).sort({ createdAt: -1 }).limit(50)
```

The leading fields matter. This index can support queries constrained by `tenantId`, and by `tenantId` plus `status`; it is not a general index for `status` alone. Equality, sort, and range placement follows the workload and the Equality-Sort-Range guideline, but is not a rigid formula: selectivity, sort requirements, and whether the index can cover the request must be evaluated together. A compound index can provide sort order when directions are compatible with the index pattern (or its complete inverse).

Avoid creating many near-duplicate indexes without checking existing prefixes. Index intersection may help some query shapes, but a well-matched compound index is often more predictable for filter-and-sort requests. Use `getIndexes()` and `explain("executionStats")` to confirm actual index use and examined work.

## Multikey indexes

An index on an array field becomes multikey: MongoDB indexes array elements so membership queries can use the index. A compound multikey index has restrictions, including that a document cannot contribute array values for more than one indexed field in the same compound index. Multikey bounds also have subtleties for arrays of embedded documents; `$elemMatch` often lets the planner compound bounds for predicates that must match the same element. Validate the exact query and data shape with explain rather than assuming that an index makes every array query cheap.

## Partial and TTL indexes

A partial index contains only documents satisfying a filter expression:

```javascript
db.orders.createIndex(
  { tenantId: 1, createdAt: -1 },
  { partialFilterExpression: { status: "open" }, name: "open_orders_by_tenant" }
)
```

It can be smaller and cheaper to maintain than a full index, but the query must imply the partial filter for the index to be eligible. Partial unique indexes are useful for conditional uniqueness, such as one active record per key, but carefully define which records participate.

A TTL index removes documents after a duration from a date field:

```javascript
db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

TTL deletion is asynchronous background cleanup, not a precise scheduler and not a substitute for access-control expiry checks. The field should hold a BSON Date; the TTL process may remove expired documents after a delay. A TTL index is single-field, so it does not also serve as a compound query index.

## Text indexes

A text index supports MongoDB's built-in text search over string fields, with language-aware tokenization and weights. It is not equivalent to a search engine: it has constraints on the number and structure of text indexes, ranking behavior is limited compared with dedicated search systems, and its index design does not provide the broad relevance and fuzzy-search features of a specialized engine. Atlas Search is a separate service feature with its own index and query syntax. Choose deliberately based on product requirements.

## Explain and execution statistics

```javascript
db.orders.find({ tenantId: "t-9", status: "open" })
  .sort({ createdAt: -1 }).limit(50)
  .explain("executionStats")
```

Read the winning plan and execution statistics. `COLLSCAN` means scanning collection records; `IXSCAN` identifies an index scan. Compare `totalKeysExamined` and `totalDocsExamined` with `nReturned`. A query returning 50 documents after examining hundreds of thousands may still be poor even though it uses an index. A `FETCH` stage means the index did not supply all required fields or predicates. A blocking `SORT` stage indicates the chosen access path did not provide the requested ordering. Explain output differs by execution engine and server version; look at the logical stages and work counts, not one hard-coded JSON tree.

An explain executes the operation for execution statistics but does not populate the normal plan cache in the same way as a regular query. Use production telemetry and representative parameter values too, especially when tenants or key values are skewed. `hint()` is a diagnostic or carefully governed operational tool, not a substitute for understanding why the planner chose a plan.

## Index builds and operations

Modern MongoDB index builds coordinate across replica set members and allow concurrent reads and writes, but they still consume resources and may be constrained by memory, disk, replication lag, or commit quorum. Monitor build progress and deployment health. A unique index build can fail if existing data violates uniqueness. Validate duplicates before scheduling it, and plan rolling or online application changes around the constraint.

For MongoDB 8.0, query settings are the cluster-level mechanism for influencing planning by query shape; index filters are deprecated. Query settings may constrain candidate indexes but do not guarantee an index scan—the planner may still choose a collection scan. Their availability and behavior depend on deployment and version, so verify support in the target environment.

## Common mistakes

- Believing the existence of an index guarantees its selection or a fast query.
- Building `{a: 1, b: 1}` and expecting it to serve `b`-only requests.
- Using TTL deletion as an exact-time expiry guarantee.
- Adding indexes without measuring write amplification and working-set residency.
- Calling any `IXSCAN` efficient without comparing keys and documents examined to results returned.

## Production notes

Capture the query shape, representative parameters, latency distribution, and explain statistics before changing indexes. Re-test after the change under realistic data volume and concurrency. In MongoDB 8.0, query shape and plan-cache fields have changed: logs can include `queryShapeHash` and `planCacheShapeHash`; do not build monitoring that assumes one field name across all supported versions.
## Read an explain plan as evidence

The shell can expose a compact execution summary:

```javascript
db.orders.find({ tenantId: "t-9", status: "open" })
  .sort({ createdAt: -1 }).limit(50)
  .explain("executionStats")
```

A representative summary might show `nReturned: 50`, `totalKeysExamined: 52`, and `totalDocsExamined: 50`, with an `IXSCAN` feeding a `FETCH` and no blocking `SORT`. That pattern is plausible for a selective bounded page, but it is not a universal target: a covered query can examine keys without fetching documents, while a query that legitimately returns many records may examine many documents. Conversely, `nReturned: 50` with 80,000 keys examined points to a broad scan or poor bounds even if the stage says `IXSCAN`. Treat these numbers as workload evidence and compare across representative tenants and values.

A `COLLSCAN` is not automatically a bug. It can be the right plan for a tiny collection or a request expected to read a large fraction of records. An index can be worse when it causes many random fetches or competes with hotter pages in cache. Ask whether the plan's work is proportional to the result and whether it meets latency goals under realistic load. `explain()` output differs across classic and slot-based execution engines and server releases; focus on logical work, bounds, and stages rather than copying a specific JSON path into a fragile script.

## Building and reviewing an index safely

Before a unique index build, detect duplicate values and decide how to resolve them; the build cannot make existing conflicts disappear. Estimate index size and write rate, monitor free disk, replication lag, and cache pressure, and schedule around peak load. Index builds are coordinated by the server and are designed to coexist with operations, but they still consume CPU, memory, and I/O. On a replica set or sharded cluster, check the deployment's build behavior and quorum requirements for its exact version.

A useful review includes the query shapes that benefit, the write paths that maintain the index, and redundant prefixes already present. After deploying, compare latency percentiles and examined work, then observe all important query shapes before dropping an index. Do not use `hint()` to conceal a plan regression without understanding the regression; it can pin a plan that becomes poor as distributions change. An index portfolio is an operational budget, not a checklist in which every queried field receives its own index.
