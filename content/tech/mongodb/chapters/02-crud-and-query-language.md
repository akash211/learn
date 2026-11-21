# CRUD and Query Operators

MongoDB's CRUD API works with BSON documents and filters expressed as documents. The shell syntax below uses `mongosh`; the same concepts are available in official language drivers, though driver method names and result objects differ. A query is not SQL translated into JSON: operators, array semantics, null and missing-field behavior, and update forms all matter.

## Insert, update, and delete

```javascript
db.orders.insertOne({
  _id: "ord-1042",
  customerId: "cust-18",
  status: "pending",
  createdAt: new Date(),
  lines: [{ sku: "book-7", qty: 2, unitPrice: Decimal128("19.95") }]
})
```

MongoDB creates an ObjectId `_id` if one is omitted. `_id` is unique within a collection and immutable. Choose types deliberately: a date should be BSON Date rather than a formatted string, and monetary values that need decimal arithmetic should generally use Decimal128 or a carefully specified integer minor-unit representation, not binary floating point.

`updateOne()` modifies the first matching document, while `updateMany()` applies to all matches. Update operators make intent explicit:

```javascript
db.orders.updateOne(
  { _id: "ord-1042", status: "pending" },
  { $set: { status: "paid", paidAt: new Date() }, $inc: { revision: 1 } }
)
```

The status in the filter is a compare-and-set guard: if another writer already changed the state, `matchedCount` is zero and the caller can respond accordingly. Use `$unset` to remove a field, `$addToSet` for unique array additions, `$push` for append, `$pull` to remove matching array elements, and `$rename` for controlled field renames. Replacement with `replaceOne()` replaces the document body (apart from `_id`); it is easy to erase fields accidentally if the application constructed an incomplete replacement.

Upsert inserts when no document matches. Provide a deliberate unique identity filter; a broad upsert can create surprising documents. Deleting by filter is also exacting: `deleteMany({})` removes every document in the collection. In production, check the filter, counts, and deployment target before bulk destructive operations.

## Filters and comparison operators

A filter like `{ status: "open" }` matches equality. Comparison operators include `$gt`, `$gte`, `$lt`, `$lte`, and `$ne`; set membership uses `$in` and `$nin`; logical composition uses `$and`, `$or`, `$nor`, and `$not`. MongoDB implicitly ANDs distinct fields, so `{ status: "open", total: { $gte: 100 } }` has both predicates.

```javascript
db.orders.find({
  status: { $in: ["paid", "shipped"] },
  createdAt: { $gte: ISODate("2026-01-01T00:00:00Z") }
}).sort({ createdAt: -1, _id: 1 }).limit(50)
```

The explicit `_id` tie-breaker makes pagination order deterministic when timestamps collide. Offset pagination with large `.skip()` values becomes more expensive as the server walks past earlier results. For deep pagination, use a stable keyset predicate based on the last seen sort values and a matching index.

## Arrays and nested fields

Dot notation addresses nested fields: `{ "shipping.city": "Oslo" }`. Array matching has subtleties. `{ "lines.sku": "book-7", "lines.qty": { $gte: 2 } }` can match different array elements for the two predicates. Use `$elemMatch` when both conditions must apply to the same element:

```javascript
db.orders.find({ lines: { $elemMatch: { sku: "book-7", qty: { $gte: 2 } } } })
```

`$all` requires an array to contain all specified values; `$size` matches an exact array length. `$exists` distinguishes a missing field from a present field. `{ field: null }` matches both explicit null and missing fields, so pair it with `$exists` when that distinction matters. For optional fields, define consistent write semantics and test filters against both cases.

Projection limits returned data: `find(filter, { customerId: 1, status: 1 })` includes those fields and `_id` by default. Inclusion and exclusion generally cannot be mixed except for `_id`. Projection reduces network transfer but does not necessarily make a query index-only; inspect the plan.

## Updates to arrays and positional operators

`$` updates the first array element that matched the query. `$[]` updates all elements, and `$[identifier]` updates elements selected by `arrayFilters`:

```javascript
db.orders.updateOne(
  { _id: "ord-1042" },
  { $set: { "lines.$[line].fulfilled": true } },
  { arrayFilters: [{ "line.sku": "book-7" }] }
)
```

If multiple lines have the same SKU, this marks all matching filtered elements, which may or may not be intended. Include stable element identifiers where operations must target exactly one child. All modifications to a single document are atomic, but an updateMany across documents is not one all-or-nothing transaction.

## Find versus aggregation

`find()` is concise for filtering, sorting, limiting, and projecting documents. Use aggregation when a request needs computed fields, grouping, reshaping, or joins. A simple count can use `countDocuments(filter)`; avoid relying on `estimatedDocumentCount()` when an exact filtered count is required. `distinct()` returns distinct values, but large cardinalities may make it a poor substitute for a paginated aggregation.

## Common mistakes

- Omitting a filter and unintentionally updating or deleting every record.
- Assuming two dotted array predicates apply to the same element instead of using `$elemMatch`.
- Treating missing and explicit `null` as the same in every query.
- Replacing a document when a targeted `$set` was intended.
- Paginating with unstable sort order or increasingly large offsets.
- Assuming `updateMany()` is atomic as a whole; atomicity is per document unless a transaction is used.

## Production notes

Use acknowledged writes appropriate to the durability requirement, inspect `matchedCount` and `modifiedCount`, and make retries safe. A conditional update with an expected prior state is often a better concurrency control mechanism than read-then-write in application code. Use bulk writes to reduce round trips for independent operations, but remember that bulk execution is not inherently one transaction.
## Idempotency and safe state transitions

Network errors can occur after the server commits a write but before the client receives the reply. Therefore a retry policy needs a stable business identity, not just another call to `insertOne()`. For order creation, accept a client request key, store it on the order, and enforce uniqueness with an index. On a duplicate-key response, fetch the existing result and return it if it belongs to the same request. This turns a retry into a lookup rather than a second order. A retryable write supported by the driver handles a narrower transport-retry case; it does not make an entire multi-step checkout exactly once.

Conditional updates are useful for state machines. The filter is both a selection and a precondition:

```javascript
const result = db.orders.updateOne(
  { _id: "ord-1042", status: "pending", revision: 7 },
  { $set: { status: "paid", paidAt: new Date() }, $inc: { revision: 1 } }
)
if (result.matchedCount !== 1) {
  // Re-read and decide whether the request is stale, duplicated, or invalid.
}
```

The revision protects against two writers both acting on a previously read version. The caller must distinguish a missing document from a stale state if the API needs different responses. Avoid reading a value, making a decision only in application memory, and then overwriting it without a predicate: that pattern can lose a concurrent update.

## Keyset pagination example

For a descending `createdAt` feed with `_id` as a deterministic tie-breaker, the next page after `(lastDate, lastId)` uses the lexicographic condition:

```javascript
db.orders.find({
  tenantId: "t-9",
  $or: [
    { createdAt: { $lt: lastDate } },
    { createdAt: lastDate, _id: { $gt: lastId } }
  ]
}).sort({ createdAt: -1, _id: 1 }).limit(50)
```

Choose a compound index compatible with the equality predicate and sort, then confirm with explain. Keyset pagination avoids walking a large skipped prefix, but it does not create a snapshot across page requests: inserts or updates can change what appears between pages. If a report needs a fixed point-in-time view, define that separately using a stable cutoff or an appropriate snapshot strategy. Validate sort direction and boundary operators with duplicate timestamps so records are neither repeated nor omitted.
