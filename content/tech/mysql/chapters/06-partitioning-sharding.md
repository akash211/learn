# Partitioning and Sharding Considerations

Partitioning splits one logical MySQL table into physical partitions managed by a single MySQL server. Sharding distributes data across multiple independent servers. Both techniques can help with specific scale and lifecycle needs, but they add constraints and operational complexity. They are not interchangeable, and neither should be chosen before measuring query, index, storage, and maintenance bottlenecks.

## What MySQL partitioning does

MySQL supports range, list, hash, and key partitioning. With range partitioning, the server routes rows to partitions based on a partition expression. Partition pruning can avoid scanning partitions that cannot match a query predicate. This makes partitioning useful for lifecycle management—such as dropping old time ranges—or for workloads whose queries consistently constrain the partition key. It is not a substitute for a good local index within each partition.

```sql
CREATE TABLE events (
  event_id BIGINT NOT NULL,
  occurred_at DATETIME NOT NULL,
  payload JSON,
  PRIMARY KEY (event_id, occurred_at)
)
PARTITION BY RANGE COLUMNS (occurred_at) (
  PARTITION p2026q1 VALUES LESS THAN ('2026-04-01'),
  PARTITION p2026q2 VALUES LESS THAN ('2026-07-01'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);
```

For MySQL partitioned tables, every unique key, including the primary key, must include all columns used in the partitioning expression. This constraint has schema consequences: if an application requires global uniqueness of `event_id`, adding `occurred_at` to the primary key no longer enforces uniqueness of the ID alone. You may need an external ID allocation strategy or a different design. Verify this rule and partitioning limitations against the exact server release.

## Pruning and partition design

The optimizer can prune partitions when it can infer relevant bounds from the query. Direct predicates on the partitioning column are easier to reason about than expressions that obscure it. Use `EXPLAIN` to verify which partitions are accessed; creating partitions does not guarantee pruning. A query that omits the partition key may touch every partition and incur the same or greater work than an unpartitioned table.

Partition count is not free. Each partition brings metadata and management overhead, and very large counts can make planning, DDL, and operational inspection cumbersome. Avoid creating one partition per customer or per tiny time interval without evidence. Plan future partitions and handle the `MAXVALUE` partition deliberately; reorganizing it can be an expensive operation if it accumulates data.

Dropping or truncating a partition can remove a large range of data efficiently compared with row-by-row deletes, but it is irreversible data deletion from the live table. Confirm retention rules, backups, and replicas before execution. Partition maintenance DDL can still acquire metadata locks and should be scheduled and monitored.

## What sharding changes

A shard is typically a separate database instance or cluster that owns a subset of the keyspace. The application or routing layer maps a shard key—often tenant ID or account ID—to a shard. This can expand write and storage capacity beyond one host, but it changes data placement into an application-level concern. A request that needs multiple shards may require fan-out, result merging, and coordination for transactions or uniqueness.

Shard-key choice shapes nearly every operation. A tenant identifier can localize tenant transactions and support independent data placement, but a hot tenant can overload one shard. A monotonically increasing key may create hot spots depending on routing. Rebalancing data between shards, backup and restore, cross-shard joins, and global uniqueness require explicit solutions. Avoid a shard key that cannot be determined at query time for the critical access paths.

## Scale first with evidence

Before partitioning or sharding, confirm the bottleneck. A slow query may be fixed by an index or query plan. A large table may still fit comfortably on one server with suitable storage and buffer pool. Write contention may come from one hot row, an oversized transaction, or a secondary-index maintenance burden rather than raw data volume. Replicas can offload reads but do not increase single-primary write throughput in the same way sharding might.

Partitioning is most compelling when pruning is predictable or data lifecycle operations benefit materially. Sharding is justified when a single server's measured capacity or availability limits cannot meet requirements and the organization can operate distributed data ownership. A measured migration path is preferable to speculative complexity.

## Retention automation and operational boundaries

A partitioned retention scheme needs a lifecycle controller, not just an initial `CREATE TABLE`. Create future partitions ahead of time, verify their boundaries, and alert well before inserts reach a missing range. A catch-all `MAXVALUE` partition prevents immediate insert failure in some designs, but it can accumulate rows silently; splitting it later may require moving a large volume of data. Automate a review of partition definitions and row counts so unexpected growth becomes visible.

Dropping a partition is a structural DDL operation, not an ordinary row delete. It is fast relative to deleting millions of rows, but it may still need metadata locks and has irreversible consequences for online queries. Ensure the backup and archival copy cover the intended retention period and that replicas and downstream consumers have processed relevant changes. Binary logging and replication effects depend on the exact operation and configuration; test the production version and topology. Retention jobs should be idempotent, logged, and guarded by an expected date range or explicit approval.

Partitioning also affects query ergonomics. A unique lookup by a non-partition key may require broader work, and every unique key rule can constrain identity design. Foreign-key support and other feature limitations should be checked for the exact MySQL version and partitioning mode. Data migration into a partitioned design can require substantial copy time and disk headroom. Compare that cost with alternatives such as time-bounded tables, archival systems, or batched deletion before committing.

Sharding adds a second lifecycle problem: balancing tenants and moving a shard key when its owner changes. Keep a mapping from key range or tenant to shard, define how mappings are updated atomically, and ensure caches do not route writes to old owners. During resharding, dual writes are difficult to make correct; prefer a tested copy-and-catch-up protocol with a defined cutover and rollback window. Treat cross-shard reporting as a separate analytical workload rather than letting fan-out queries overload every transactional shard.

## Production notes

- Benchmark pruning with representative SQL and verify plans after release upgrades.
- Test uniqueness and foreign-key requirements against partitioning restrictions before committing to a schema.
- Automate creation of upcoming partitions and alert before inserts reach an unintended catch-all or fail due to missing partition.
- For sharding, define routing, resharding, transaction, and failure semantics as part of the application architecture.

## Common mistakes

- Assuming partitions automatically make all queries faster or increase CPU capacity across multiple servers.
- Partitioning by a column not used by important filters or retention operations.
- Forgetting that unique keys on partitioned tables must include the partition key.
- Treating sharding as a transparent infrastructure toggle instead of distributed data design.
- Creating huge numbers of partitions without measuring planning and management costs.
