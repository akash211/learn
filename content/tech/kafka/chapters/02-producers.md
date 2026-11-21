# Producers: Acknowledgments, Idempotence, Batching and Keys

A producer converts application events into Kafka records and sends batches to partition leaders. Its configuration determines how much it waits, what it can retry safely, how it groups data, and where records land. Production producer design is not a contest to find the largest batch or shortest acknowledgment time. It is a decision about the failure contract the application can tolerate while keeping latency and broker load within a measured budget.

## Acknowledgment and durability

The `acks` setting controls when a send is considered successful from the producer's perspective. `acks=0` does not wait for a broker acknowledgment; it can be useful only when loss is acceptable and is generally unsuitable for business events. `acks=1` waits for the leader to append the record, but an immediate leader failure before replication can lose acknowledged data. `acks=all` (also accepted as `-1`) waits for the leader's required replica condition, which includes the current in-sync replicas and the topic's `min.insync.replicas` policy.

The relationship between `acks=all` and `min.insync.replicas` is a deliberate availability/durability choice. With replication factor three and a minimum ISR of two, a partition that has only one in-sync replica refuses writes instead of acknowledging a write that cannot meet the configured threshold. The producer receives an error and must decide whether and how to retry. A larger minimum protects against a narrow failure but makes writes unavailable under more replica loss. Neither setting creates a backup, nor does it protect from an operator deleting the topic or a bug publishing incorrect values.

When the application must not proceed without Kafka acceptance, check the send result or await the future. Fire-and-forget hides failures. Also distinguish broker acceptance from business completion: an acknowledged append does not mean a downstream consumer has processed the event or an external database has committed a corresponding row.

## Retries and idempotence

Transient failures are normal: a leader can move, a request can time out after reaching the broker, or the network can lose a response. A retry may be necessary even when the original append succeeded. Without duplicate protection, that uncertainty can produce duplicate records.

`enable.idempotence=true` makes the producer assign sequence numbers per producer ID and partition, allowing the broker to reject duplicate retries within the supported producer session semantics. Modern producer clients enable idempotence by default when compatible settings permit it; set and verify it explicitly when correctness depends on it, and check the client version and effective configuration. Idempotence is not global deduplication: it does not prevent an application from intentionally sending the same event twice, nor does it deduplicate across unrelated producer instances after a restart.

Idempotence works with compatible retry and in-flight request settings; current clients validate incompatible combinations. Avoid turning retries off just to suppress duplicates. For multiple records that must be atomically visible, use a transactional producer and consumer isolation controls rather than assuming idempotence groups separate sends into one atomic unit.

## Batching, latency, and compression

Network requests carry batches of records for a partition. `batch.size` sets the target upper size for a producer batch, while `linger.ms` allows a short delay for more records to arrive and fill a batch. Larger batches can reduce per-record request overhead and improve compression, but they consume memory and may add latency for sparse traffic. `buffer.memory` limits the producer's buffering space; if brokers cannot accept data fast enough, `send()` eventually blocks up to `max.block.ms` or fails. Monitor buffer availability and request latency rather than guessing from configuration alone.

Compression is applied to batches, so similar records grouped together often compress better than isolated records. `compression.type` supports codecs such as `gzip`, `snappy`, `lz4`, and `zstd` depending on client/broker compatibility. Compression spends CPU to reduce network and storage bytes; choose from representative payloads and end-to-end measurements. Highly compressed data can increase producer CPU, and a downstream consumer still spends CPU decompressing. Kafka brokers can retain compressed batches rather than decompressing and recompressing on every path, but behavior depends on codec and record format compatibility.

A common tuning sequence is: establish correctness (`acks`, idempotence, key, schema), measure baseline throughput and tail latency, then adjust batching and compression while observing broker request metrics, producer queue time, request latency, and downstream lag. Avoid setting `linger.ms` so high that an empty or low-rate topic feels stalled. For a latency-sensitive command stream, a small linger may be preferable to maximum throughput; for bulk ingestion, larger batches may be appropriate.

## Keys and partitioning

A key commonly defines the per-entity ordering boundary: all updates for `account-42` should be processed in order by selecting that account as the key. The default partitioner hashes a non-null key to a partition. If a key is null, records are distributed according to the client's partitioning strategy, which may use sticky behavior to fill batches efficiently. Custom partitioners are available but add operational complexity.

Good keys balance two objectives: related records need stable placement for ordering and locality, while partitions need an even load distribution. A key such as a popular country code can produce a hot partition even when the cluster has many brokers. Randomizing a key may spread load but forfeits per-entity ordering. “Add partitions” can also change mapping for a hash-based partitioner, so records for one key may start landing in a new partition; the old and new histories then have no shared ordering. If strict order matters across a repartitioning event, use a migration plan or a stable partitioning scheme.

Record headers carry lightweight metadata without changing the value schema, often for tracing, content type, or routing hints. They are not a substitute for a well-defined event contract. Keep secrets out of keys, values, and headers; Kafka retention and replication make accidental disclosure persistent.

## Delivery errors and application shape

In asynchronous APIs, `send()` commonly queues work and returns a future. A callback handles eventual success or failure. Bound the number of outstanding records and propagate failures into application health; otherwise an ingestion process may look alive while accumulating an ever-growing backlog. Distinguish retriable errors (temporary leader movement, throttling) from fatal configuration, authorization, serialization, or message-size errors. Retry logic should respect `delivery.timeout.ms`, `request.timeout.ms`, and `max.block.ms` rather than layering an unbounded application retry loop on top of client retries.

For a database-to-Kafka publish path, writing the database then publishing can lose an event if the process crashes between the operations; publishing first can emit an event for a transaction that later rolls back. Producer idempotence cannot atomically include an unrelated database. The transactional outbox pattern solves this dual-write gap (chapter 10), with a relay or CDC connector publishing committed outbox rows.

## Common mistakes

- Treating `acks=all` as “wait for every configured replica.” It is tied to the ISR and minimum-ISR policy.
- Disabling idempotence because a retry could duplicate data. That removes broker-side retry deduplication rather than creating exactly-once behavior.
- Using a random key to solve hot partitions without acknowledging that the ordering boundary is lost.
- Increasing `batch.size` to increase throughput without checking whether traffic fills the batches, memory pressure, and tail latency.
- Calling `send()` and discarding the result, then discovering only later that serialization or authorization errors were ignored.

## Production notes

Start with a producer configuration that states its reliability intent explicitly. For durable business events, teams commonly combine `acks=all`, `enable.idempotence=true`, a deliberate replication factor and `min.insync.replicas`, bounded delivery timeouts, and an explicit key. The exact values depend on failure objectives and deployment constraints; do not cargo-cult one configuration across an interactive API, telemetry firehose, and financial ledger. Test broker failover, credential rotation, serialization errors, and a full producer buffer in staging. A successful happy-path benchmark says little about the behavior that matters during an incident.