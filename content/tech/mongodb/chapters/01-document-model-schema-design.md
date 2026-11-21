# Document Model and Schema Design

MongoDB stores BSON documents in collections. BSON is a typed, binary representation of JSON with extra types such as dates, ObjectIds, binary values, and decimal128. The document is the unit applications read and write; a document can contain nested objects and arrays, and its fields need not be identical to those of every other document in the collection. That flexibility is a storage capability, not a substitute for designing a schema.

## Model around access patterns

Start with the operations the application must perform: which entities are fetched together, how they are filtered and sorted, which values change independently, and what must be atomic. A document boundary is valuable when fields are commonly read together and should be updated together. MongoDB guarantees atomicity for a single-document write, including changes to multiple embedded fields. This makes a well-shaped document a natural aggregate boundary.

For example, an order can embed its shipping address snapshot and line items. The snapshot preserves what the buyer agreed to even if their profile address later changes. A product catalogue's current product description, by contrast, should usually be referenced from a line item if changes to that canonical description should be visible in all orders; historical orders may still copy a subset of descriptive data for audit purposes. Model the meaning of the data, not just its current JSON representation.

## Embedding versus referencing

Embedding avoids a join, keeps related data together, and lets the application retrieve or update the aggregate with one request. It is especially effective for bounded one-to-one or one-to-few relationships: a user's preferences, an order's bounded list of line items, or a device's current configuration. Embedded children inherit the parent's lifecycle and atomicity.

Referencing is a better fit when the related entity is large, independently queried or updated, shared by many parents, or unbounded in number. A post should not embed an ever-growing list of every comment: document size is capped at 16 MiB, and repeatedly rewriting a hot parent or transferring an enormous array is costly. Store comments as their own documents with a `postId`, and index that field. A reference does not create a foreign-key constraint; the application must handle missing references, deletion policy, and consistency.

| Question | Embedding tends to fit | Referencing tends to fit |
| --- | --- | --- |
| Are related values read together? | Yes, in one aggregate | No, queried independently |
| Is cardinality bounded? | Small, known bound | Large or unbounded |
| Is child shared? | No, owned by parent | Yes, many parents use it |
| Must an update be atomic? | Within the single document | Across documents, use a transaction if needed |
| Does the child have independent lifecycle? | Rarely | Often |

The choice is not binary. A common pattern stores a reference to the authoritative entity and copies a few stable or historical fields into the parent. This is intentional denormalization: document why the copy exists and define which copy wins when updates occur.

## Arrays, duplication, and boundedness

Arrays are powerful when they are bounded and queried with operators such as `$elemMatch`. Bound them operationally, not merely by saying they are usually small. A growing event history, audit trail, or membership list should have its own collection, perhaps with a summary or recent-items array on the parent. That trades read-time joins or multiple requests for controlled document growth.

Duplicated data introduces a synchronization obligation. If an address is copied to active subscriptions, decide whether address changes propagate immediately, only at renewal, or never because the copy is a contractual snapshot. Without this rule, duplication creates ambiguity rather than speed.

## Bucket pattern and time-oriented data

The bucket pattern groups a bounded set of measurements into one document, often by device and time window. A bucket can carry `deviceId`, window start/end, count, summary values, and a `measurements` array. This reduces per-record document and index overhead and supports window-level reads. Buckets must be closed or rotated at a definite count, size, or time limit; one unbounded bucket is simply an unbounded-array bug. MongoDB time-series collections provide a specialized bucketed representation for time-stamped measurements, with metadata and time fields declared at creation. Use them when the workload matches time-series semantics, and validate query and update limitations for the deployed version.

## Schema validation and evolution

Flexible schema does not mean unchecked schema. Use collection validation with `$jsonSchema` to enforce required fields, types, and basic constraints at the database boundary. Validation can be strict or permissive; during a migration, a permissive rule can accept both old and new shapes while writers are upgraded. Application code should still validate business rules that are not expressible as document shape constraints.

Version documents when shape changes are meaningful, for example `schemaVersion: 2`. A safe evolution often follows expand-migrate-contract: deploy readers that accept old and new formats, deploy writers for the new format, backfill old records in measured batches, confirm coverage, and only then remove old-format support. Avoid a giant synchronous migration that monopolizes I/O or produces a large replication backlog.

## Common mistakes

- Choosing MongoDB because a payload is JSON-shaped while ignoring joins, constraints, and reporting needs.
- Embedding a child collection that grows without a tested upper bound.
- Treating a reference like a relational foreign key; MongoDB does not enforce referential integrity for you.
- Copying mutable fields without stating whether copies are snapshots or synchronized projections.
- Using one document for unrelated records just to claim single-document atomicity.

## Production notes

A good design lets the common request touch a small number of documents and indexes while keeping documents bounded. Measure representative queries and document growth with realistic data. The 16 MiB document limit is a hard boundary, not a target, and schema changes are application migrations even when the database permits mixed shapes.
## Worked design: order history and product data

Consider an order page that must show the purchased items, the agreed price, shipping destination, and current fulfillment state. Embed a bounded `lines` array and an address snapshot in the order: those values are read together, and the historical price and destination should not silently change when the catalog or customer profile changes. Keep the authoritative product record in a `products` collection, referenced by SKU or product ID. If the UI needs a product name on historical orders, copy that display name deliberately as a purchase-time snapshot. This is not accidental duplication; it encodes a time-specific fact.

Now consider shipment scans. Their count grows over time and operators may query a time range across many orders. Store each scan separately with `orderId`, `occurredAt`, and a stable event ID, and create an index such as `{ orderId: 1, occurredAt: -1 }`. The order document can retain `currentStatus` plus a bounded `recentEvents` list for the common page. The summary and history have different freshness needs: update current status through a defined state transition, and treat history records as append-only. If both must be written together, use a short transaction or an outbox workflow; otherwise document and monitor the projection lag.

## Validate a shape at the boundary

A validator can enforce structural expectations while application code evolves. For example:

```javascript
db.createCollection("orders", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["customerId", "status", "createdAt", "lines"],
      properties: {
        customerId: { bsonType: "string" },
        status: { enum: ["pending", "paid", "cancelled", "shipped"] },
        createdAt: { bsonType: "date" },
        lines: { bsonType: "array", items: { bsonType: "object" } }
      }
    }
  },
  validationLevel: "moderate",
  validationAction: "error"
})
```

A validator is not a full domain model: it cannot enforce every cross-document invariant. Deploy a compatible validator before requiring fields that older writers omit, observe validation failures, then tighten it after all writers and backfills have moved. Test both valid and intentionally malformed documents against the actual server version.

Before settling a design, estimate the upper bound of embedded children, size representative documents, and list each important read and write. A model is stronger when it states which fields are authoritative, which are snapshots, what consistency delay is acceptable, and how a future shape version will be migrated. Those statements make trade-offs reviewable instead of leaving them as hidden assumptions.
