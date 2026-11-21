# Retention, Compaction and Tiered Storage

Kafka is a durable log with a configurable history, not an infinite archive. Topic cleanup policy determines whether old log segments expire, whether keys are compacted to their latest values, or both. Retention is a correctness boundary: a consumer that is offline longer than the available history may no longer be able to resume from its previous offset. Storage planning should therefore start from replay and recovery requirements, not only from disk cost.

## Delete-based retention

The default `cleanup.policy=delete` removes old segments according to retention rules. `retention.ms` sets the time horizon and `retention.bytes` limits retained data per partition; whichever configured limit is reached can trigger cleanup. Time and size retention are asynchronous and segment-granular. A record does not disappear at the exact millisecond its timestamp ages out: Kafka deletes eligible whole segments during log cleanup. An active segment must roll before it can be deleted, so `segment.ms` and `segment.bytes` affect the granularity and delay of cleanup.

Retention applies independently to each partition. If traffic rates differ significantly, a topic-wide byte assumption can obscure that one partition grows much faster. Estimate storage from encoded and compressed bytes, replication factor, partition-level traffic, retention window, segment/index overhead, and operational headroom for replica movement and recovery. Include the period needed to rebuild a failed broker or restore a consumer after maintenance. Disk fullness is an availability incident, not a capacity metric to discover at 99 percent.

Producer timestamps can be create-time or broker append-time, depending on topic configuration. Time-based retention uses record timestamps within broker guardrails, so a producer with a badly skewed clock can affect expiration behavior. Use broker-side timestamping when the producer's clock is not trustworthy, and monitor timestamp anomalies rather than assuming event time and append time are equivalent.

## Compaction: keyed state, not a free archive

With `cleanup.policy=compact`, Kafka retains at least the latest known value for each key as segments are cleaned. A record with a null value is a **tombstone**: it signals deletion for that key. Tombstones themselves are eventually removed after `delete.retention.ms`, so a consumer rebuilding state must see the tombstone within the configured horizon. Compaction is asynchronous. It does not make the log instantly contain only one record per key, and multiple versions can coexist across active and not-yet-cleaned segments.

A compacted topic is useful for changelog/state recovery: a consumer can read from the beginning and reconstruct the latest value per key. It is not necessarily a complete audit history. Compaction can remove intermediate updates, while tombstone expiry can remove delete evidence. If legal, analytical, or forensic history is required, preserve an immutable event topic or archive separately.

Compaction depends on keys. Null keys cannot provide meaningful per-entity latest-value semantics. Key identity must remain stable across schema evolution and application versions; changing key serialization or key meaning can leave apparently duplicate logical entities in different compacted key spaces. Compacted topics also need sufficient disk and cleaner capacity; cleaner lag means the topic is larger than its theoretical steady state for a time.

`cleanup.policy=compact,delete` combines compaction and time/size deletion. It can bound history while keeping recent key updates, but it does not mean “retain exactly the latest state forever.” Choose this policy only after defining the window in which a consumer may recover and the semantics of tombstone cleanup.

## Segment anatomy and cleanup

The cleaner operates on closed segments, so segment size and roll cadence influence both cleanup efficiency and storage granularity. Larger segments reduce per-file overhead but delay eligibility and create bigger units to move or process. Smaller segments increase file and index activity. Retention deletion and compaction are not the same mechanism: deletion discards a whole eligible segment; compaction rewrites eligible segments to preserve the latest record per key and relevant tombstones.

Operational controls include topic-level retention overrides, broker log cleaner settings, and quotas or monitoring around disk. Before reducing retention, ask whether disaster recovery, consumer downtime, regulatory replay, and a backfill all still fit. Before increasing it, consider replica storage multiplication, restore duration, and whether a data lake archive is cheaper and more appropriate for long-term analytics.

## Tiered storage

Tiered storage separates a local broker tier from a remote object or file-system tier. Local segments serve the active and latency-sensitive tail; completed older segments can be copied to remote storage and fetched later for replay. The design can decouple long retention from local broker disk, but it does not eliminate storage cost, data governance, or recovery planning. Remote reads have different latency and throughput characteristics from local page-cache reads, so a consumer replaying old data may behave very differently from a steady real-time consumer.

Kafka's KIP-405 defines the tiered-storage architecture. Support is version- and deployment-dependent: core Kafka offers the framework, while the remote storage implementation and operational integration may be vendor-provided or otherwise specific to the deployment. Validate which release marks the feature production-ready in the target environment and read its limitations. In particular, do not assume all topic cleanup modes, storage layouts, or broker operations combine freely with remote storage. Compaction interactions and migration constraints must be checked against the chosen implementation and release.

Tiering introduces additional lifecycle questions. When is a segment safe to delete locally? What happens if remote upload is delayed or fails? Can a broker fetch an old segment while the remote object store is throttled or unavailable? How are remote metadata, encryption keys, retention and deletion requests managed? Test consumer resets that cross from local to remote data, and measure backfill performance under realistic remote service limits. A tiered log is still not automatically a lakehouse: consumers continue to use Kafka APIs, and analytical table layout, indexing, and query engines remain separate concerns.

## Common mistakes

- Treating `retention.ms` as a per-record timer with exact deletion timing; cleanup works on segments and is asynchronous.
- Assuming `retention.bytes` is a topic-wide quota rather than a per-partition constraint.
- Treating a compacted topic as a complete immutable event history.
- Removing tombstones too quickly for the slowest rebuilding consumer.
- Assuming remote storage makes replay free, fast, or independent of a particular implementation.
- Setting retention from current consumer lag only, forgetting disaster recovery and planned maintenance.

## Production notes

For every topic, record cleanup policy, key semantics, retention horizon, replication factor, owners, consumers' maximum recovery window, and whether historical replay is supported. Alert on broker disk growth, cleaner lag, retention deletion activity, remote upload/fetch failures, and consumer offsets approaching the log start. A consumer whose offset falls behind the log start cannot recover by retrying; operators must choose a new valid position or restore from another archive. Run a replay exercise before an incident forces that decision.