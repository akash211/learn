# Sharding and Horizontal Scale

Sharding distributes a collection's documents across shards. A sharded cluster typically has multiple replica-set shards, config servers that store cluster metadata, and `mongos` routers that direct client operations. Sharding can increase storage capacity and throughput, but it adds routing, balancing, operational, and query-design constraints. It is not a switch that makes a poorly indexed or hot workload scale automatically.

## Choosing a shard key

The shard key determines how documents are partitioned and where an operation is routed. Evaluate cardinality, frequency distribution, write distribution, query targeting, and monotonicity. A key with few distinct values cannot distribute data evenly. A key dominated by one popular tenant can create a hot shard. A monotonically increasing key may send inserts to one range/chunk at the active end, creating an ingestion hotspot. Hashed keys distribute point values more evenly but generally do not preserve useful range locality; range queries may scatter across shards.

A compound shard key can combine a partitioning prefix with useful targeting dimensions. Hashed sharding hashes the selected key value; a compound key may include hashed and range components subject to server rules. The shard key is not just an index choice: it shapes where reads and writes go and can constrain unique indexes and update operations. Since MongoDB 5.0, resharding provides a supported path to change a shard key in some deployments, but it is a major data movement operation, not a casual schema tweak. Choose with expected growth and query shapes in mind.

A query containing the shard key (or a useful prefix, depending on key pattern and predicate) can be targeted to one or a subset of shards. A query lacking shard-key information may be broadcast to all shards and merged by `mongos`. Scatter-gather reads may work for low-rate administrative or analytical requests but can multiply work and tail latency. `explain()` on the router can show whether the query is targeted or broadcast; inspect per-shard plans and result-merging stages.

## Chunks and balancing

For range sharding, the data range is divided into chunks. The balancer migrates chunks to reduce distribution imbalance, subject to configuration and workload. Chunk boundaries split ranges; jumbo chunks or indivisible large documents can prevent normal movement. The balancer does not understand business importance or the query's performance objective—it balances data distribution according to cluster metadata. Monitor migrations, chunk distribution, shard capacity, and latency while balancing is active.

Hashed sharding generally distributes hash ranges evenly, but it can sacrifice efficient range reads and still does not eliminate hotspots caused by a single key value receiving concentrated updates. A unique shard-key index must obey the server's uniqueness restrictions; unique indexes on sharded collections generally need the shard key as a prefix (with special considerations for `_id` when it is not the shard key). Validate uniqueness and index requirements against the exact server version and key before deployment.

## Zone sharding and locality

Zones associate shard-key ranges with selected shards, enabling geographic or hardware placement policies. They can support data-locality and retention strategies but only if the key maps cleanly to the intended ranges. Zones do not by themselves provide legal compliance guarantees; backup, logs, analytics, and operator access also matter. Range design should avoid placing all active writes in a narrow range.

## Common mistakes

- Choosing a shard key only for cardinality without considering query targeting and write distribution.
- Using a monotonic key and then wondering why the newest chunk is a write hotspot.
- Assuming hashed distribution is ideal for range queries.
- Measuring only cluster-wide averages that hide one overloaded shard.
- Treating automatic balancing as an instant fix for an incompatible shard key.

## Production notes

Before sharding, determine that a replica set cannot meet capacity or workload needs after schema and index tuning. Load-test with representative key distributions and skew, not uniformly random synthetic IDs alone. Review sharding support and restrictions for transactions, unique indexes, change streams, and aggregation in the chosen version. Track per-shard utilization, chunk ranges, migrations, and scatter-gather frequency, and rehearse resharding or shard removal procedures where relevant. Record a pre-change baseline and a rollback trigger—for example, a rise in targeted-query latency or queueing on the new key distribution—so the team can distinguish a balancing delay from a design flaw. The goal is not identical chunk counts but sustainable load and acceptable query fan-out.
## Evaluate routing with real queries

A shard key must be judged across competing objectives. Consider a workload partitioned by `tenantId` and time: tenant-scoped history queries benefit from a tenant prefix, while a single very large tenant may dominate one shard. A time-first range key supports time-window locality but a monotonically advancing timestamp can funnel all new writes to the newest range. A hashed tenant component can spread tenant values, but may make a tenant-plus-time request route to more than one shard depending on the key and bounds. There is no universally best compound key; the exact query predicates, key skew, growth rate, and shard count determine the trade.

Use explain through `mongos` for representative operations and check the router's targeting and per-shard work. A point lookup containing the complete shard key can often target one shard; a predicate that omits shard-key information may fan out. A scatter-gather query can return correct results while incurring network and merge costs across every shard. Monitor p95/p99 latency per shard, not only cluster averages: one hot tenant, jumbo range, or uneven storage load can disappear in aggregate metrics.

Before enabling sharding, benchmark the unsharded replica set after correcting schema and indexes. Sharding adds config servers, routers, balancing, metadata, and operational failure modes. The shard key also affects unique index rules and some update targeting requirements. Verify the current release's constraints for the precise index and collection design rather than assuming that an `_id` index provides global uniqueness in every topology.

## Balancing is data movement, not workload balancing

The balancer migrates chunks to address data distribution, but equal chunk counts do not imply equal CPU, write rate, or query load. Chunk migration consumes network and disk I/O and can compete with production requests. It cannot distribute updates to one indivisible hot key across multiple shards, and a chunk that cannot be split or moved may remain problematic. Observe migration activity alongside query queues, per-shard disk pressure, and replication health. Schedule large migrations with capacity headroom and a rollback trigger.

If a new key is needed, plan resharding or a staged collection migration as a data project: rehearse it, estimate temporary space, validate indexes and unique constraints, dual-read or capture writes only with explicit consistency rules, and reconcile after cutover. Include rollback conditions and a way to pause data movement. A design is successful when common queries are targeted enough and writes distribute sustainably, not simply when a dashboard shows similar bytes per shard.
