# Aggregation Pipelines

An aggregation pipeline transforms a stream of documents through ordered stages. Each stage receives documents from the prior stage and passes results onward. Aggregation is the right tool for grouping, computed projections, controlled joins, and data reshaping. It can also be the clearest way to express a multi-step read, but a pipeline that processes most of a large collection is not automatically cheaper than application-side code.

## Pipeline structure and stage ordering

A basic pipeline filters early, reshapes what remains, then groups or sorts:

```javascript
db.orders.aggregate([
  { $match: { tenantId: "t-9", status: "paid", createdAt: { $gte: ISODate("2026-01-01") } } },
  { $unwind: "$lines" },
  { $group: {
      _id: "$lines.sku",
      units: { $sum: "$lines.qty" },
      revenue: { $sum: { $multiply: ["$lines.qty", "$lines.unitPrice"] } }
  } },
  { $sort: { revenue: -1 } },
  { $limit: 20 }
])
```

`$match` can often use collection indexes, especially near the start of a pipeline. Put selective filters early unless a later stage creates the fields being filtered. `$project` shapes output and computes values with expressions such as `$concat`, `$ifNull`, `$cond`, `$map`, and `$filter`; the optimizer can move or coalesce some stages, so placement should express semantics first and be verified with explain. `$set` (alias `$addFields`) adds or overwrites fields without explicitly listing all retained fields.

`$unwind` emits one output document per array element. It changes cardinality: a million parent documents with 20 elements each could produce tens of millions of pipeline records. Use `preserveNullAndEmptyArrays` only when parents without elements should remain. `$group` creates one output per group key and supports accumulators such as `$sum`, `$avg`, `$min`, `$max`, `$first`, `$last`, and `$push`. `$first` and `$last` are meaningful only when ordering is defined, usually by a preceding `$sort`.

`$sort` and `$group` can require substantial memory. MongoDB can spill eligible stages to temporary files when disk use is permitted by the command/server settings; spill does not make an unbounded pipeline free. Bound inputs, monitor execution, and understand the deployment's memory and disk behavior. `$limit` early is correct only if it does not change the intended result. For example, limiting before a global sort yields a different top-N result.

## Joining with $lookup

`$lookup` performs a left outer join from the current pipeline stream to a foreign collection and adds an array of matches. The concise equality form is often easiest to index and reason about:

```javascript
db.orders.aggregate([
  { $match: { _id: "ord-1042" } },
  { $lookup: {
      from: "customers",
      localField: "customerId",
      foreignField: "_id",
      as: "customer"
  } },
  { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
  { $project: { status: 1, total: 1, "customer.name": 1 } }
])
```

The foreign join field should have an appropriate index; `_id` is indexed by default. Without one, a lookup can repeatedly scan the foreign collection. The pipeline form of `$lookup` with `let` and a nested `pipeline` enables richer correlated joins and projections, but is more complex and some comparisons have index-use limitations. Inspect explain on realistic data and verify behavior for the server version and topology, particularly when either side is sharded.

A lookup does not prove that the data model should be relationally joined on every request. If every hot request needs the same small, slowly changing field, a deliberate embedded snapshot or materialized projection may be simpler. Conversely, copying mutable data to avoid a lookup creates consistency work. Measure both choices.

## Other useful stages

`$sortByCount` groups by an expression and sorts by count; `$bucket` and `$bucketAuto` create range buckets; `$facet` runs multiple sub-pipelines over the same input stream, useful for page results plus facets but potentially memory intensive. `$setWindowFields` supports computations over ordered partitions such as rolling sums and ranks. `$merge` writes aggregation results into a target collection and can support materialized views; `$out` replaces a collection with pipeline output and has different operational implications. Treat write stages as state-changing jobs with permissions, idempotency, and failure recovery designed explicitly.

Use `$sample` when a random sample is actually required; it is not equivalent to applying an arbitrary limit. `$replaceRoot`/`$replaceWith` reshape the top-level document, while `$unset` removes fields. These are useful for API-ready output but can also discard data needed by later stages.

## Optimization and explain

Use `db.collection.explain("executionStats").aggregate([...])` to examine the plan and work. Look for index use at the initial collection scan, documents/keys examined, cardinality growth after `$unwind`, spills, and expensive foreign-side work. Aggregation explain output is version- and topology-dependent; don't assume every stage appears in a fixed format. A good pipeline often filters and projects early, avoids unwinding data that can be reduced within each document, and limits join inputs. But an early projection is not a performance incantation: the optimizer can prune unused fields itself.

Pipeline optimization can coalesce adjacent stages or move predicates across stages when semantics permit. An `$unwind` followed by a `$match` may be coalesced in some forms. Do not rely on undocumented plan details; preserve correct semantics and verify the actual explain plan.

## Common mistakes

- Putting `$limit` before `$sort` and believing the output is globally top-N.
- Forgetting `$unwind` multiplies rows and can inflate sums or memory use.
- Using `$first` or `$last` without a defined sort order.
- Joining without an index on the foreign join field or without limiting the local input.
- Treating `$merge` as a harmless read; it writes persistent data.

## Production notes

Set a comment on important long-running aggregations so they can be found in profiler/log output. For reusable reports, consider scheduled materialization with a clear freshness contract. Pipelines are executable programs over data; review them for cardinality, worst-case memory, and write effects before deploying.
## Worked pipeline with defensive calculations

Suppose a report ranks products by units and revenue for a tenant in a time range. Filter the parent order documents before expansion, then unwind only the bounded lines array. Use explicit numeric types in stored data and handle optional values intentionally:

```javascript
db.orders.aggregate([
  { $match: {
      tenantId: "t-9", status: "paid",
      createdAt: { $gte: ISODate("2026-01-01T00:00:00Z"), $lt: ISODate("2026-02-01T00:00:00Z") }
  } },
  { $unwind: "$lines" },
  { $group: {
      _id: "$lines.sku",
      units: { $sum: "$lines.qty" },
      revenue: { $sum: { $multiply: ["$lines.qty", "$lines.unitPrice"] } },
      orderCount: { $addToSet: "$_id" }
  } },
  { $set: { distinctOrders: { $size: "$orderCount" } } },
  { $sort: { revenue: -1, _id: 1 } },
  { $limit: 20 },
  { $project: { _id: 0, sku: "$_id", units: 1, revenue: 1, distinctOrders: 1 } }
])
```

This is illustrative, not a recommendation to accumulate unlimited IDs with `$addToSet`; if a group has very high cardinality, use a different metric or a staged approach. A candidate leading index is `{ tenantId: 1, status: 1, createdAt: 1 }`, subject to the actual range and query mix. Verify the initial scan with `explain("executionStats")`, and inspect the number of orders entering `$unwind` and the resulting line count. A correct index on the first stage cannot erase the cost of a huge intermediate stream.

## Memory, disk use, and output discipline

Pipeline stages can retain state for grouping, sorting, or window calculations. Where supported and enabled, eligible stages can spill to disk, but spilling turns memory pressure into disk I/O and can make latency unpredictable. Set `allowDiskUse` deliberately for a job that may exceed in-memory limits, and separately control its input window, concurrency, and runtime. Do not treat successful spilling as proof that the pipeline is appropriately bounded. Check explain and profiler evidence on data at production scale.

`$merge` and `$out` make a pipeline a write job. Define a unique key, whether reruns replace or update prior results, how deleted source records are represented, and whether readers can observe a partially refreshed projection. A periodic materialized view should publish a clear freshness timestamp and have a recovery path if the job stops midway. For a large backfill, use batches or partitioning appropriate to the source, monitor replication and disk capacity, and test idempotent reruns. Those operational properties matter as much as the aggregation expression itself.
