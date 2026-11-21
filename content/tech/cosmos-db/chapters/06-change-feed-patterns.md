# Change Feed and Event-driven Patterns

The change feed exposes changes made to a Cosmos DB container so applications can process them asynchronously. It is useful for maintaining search indexes, building projections, sending notifications, and moving data into analytical or integration systems. It is not a general-purpose event store with unlimited history, nor should a consumer infer global ordering or exactly-once side effects from a feed. Design around delivery, checkpointing, retention, and replay semantics.

## Change feed modes and guarantees

The native NoSQL API provides a latest-version mode and, under applicable account and backup configuration, an all-versions-and-deletes mode. Latest-version mode exposes the current version of items as they change; it generally does not provide a distinct delete event and intermediate updates can be superseded before a consumer reads them. It is well suited to keeping a derived state synchronized when only the latest representation matters. All-versions-and-deletes can expose create, update, and delete history within the supported continuous-backup window; this mode has prerequisites and a bounded history horizon, so confirm current eligibility and retention before relying on it.

Changes are ordered within a logical partition, not as one total order across all partition-key values. Consumers should not infer a global sequence from timestamps or item IDs. In multi-region-write accounts, conflict resolution and the service's feed ordering metadata introduce further subtleties; test the mode and SDK behavior for the topology in use. The feed's source is the container's changes, not a durable business event log that records every external intent.

The change feed processor library distributes work across partition ranges and stores leases/checkpoints in a lease container. Its normal processing model is at least once: a crash after a downstream side effect but before checkpointing can replay the change. This is a useful reliability trade: duplicate delivery is manageable with idempotent consumers. Persisting a checkpoint before the downstream effect risks data loss. Build deduplication around stable item identity plus version, event identity, or downstream idempotency key according to what changes mean.

## Materialized views and transactional outbox

A common pattern maintains a search index or read model from source items. The consumer reads changes, transforms each item, and writes the projection. Make projection updates idempotent: replace a document keyed by source `id`, apply a monotonic version check, or record processed event identifiers. Deletes require deliberate handling; in latest-version mode, soft-delete markers or tombstones can communicate deletion, while all-versions-and-deletes mode may provide delete records within its configured window. Reconcile periodically so missed or malformed projection updates can be repaired.

For external messages, don't assume a database write and queue publish can commit atomically. A transactional outbox pattern stores the business change and an outbox record within the same logical partition and transaction boundary where possible. The change feed then relays the outbox entry to a broker. The relay can publish twice if it crashes after publish but before checkpoint; consumers use idempotency keys. If the outbox and business item are in different logical partitions, the single-partition transaction guarantee no longer applies, so reconsider the data model or accept a saga and reconciliation design.

A change feed can also drive cache invalidation. Invalidation events should be idempotent and tolerant of reordering across partition keys. If the consumer uses a coalescing strategy, it should fetch current source state before updating a cache rather than applying stale deltas blindly. For audit or financial records, keep an authoritative append-only event log or external durable log if every transition must be retained; do not assume latest-version feed mode will preserve each intermediate item update.

## Recovery and operations

Monitor lease ownership, lag, processing errors, restart count, throughput, and downstream latency. Provision RU/s for feed reads as well as application requests when they share a container's throughput. A large backlog can create a feedback loop: the consumer falls behind, replay work adds load, and primary requests become throttled. Cap concurrency and coordinate capacity before catch-up.

Checkpoint age and recoverability depend on the selected mode and service history. If a consumer is offline beyond the retained changes, a resume point may no longer be available. The recovery plan should include an idempotent full scan or snapshot, a method to establish a change boundary, and a safe handoff from backfill to live processing. Avoid simply starting from "now," which can skip changes between the old checkpoint and the new start. Practice recovery against a non-production container with realistic item volume.

Leases and checkpoints are operational state. Protect the lease container, avoid accidental cleanup, and size it for the number of ranges and processors. During deployment, don't run incompatible consumer versions against the same leases without a planned handoff. A poison item should be isolated with bounded retries and an observable dead-letter or repair workflow, not allowed to block a partition indefinitely or silently discarded.

## Common mistakes

- Treating the feed as a global ordered log or assuming every update is a distinct event in latest-version mode.
- Advancing a checkpoint before the downstream effect is durable.
- Assuming one delivery means exactly once; crashes can produce replays.
- Forgetting how deletes appear or fail to appear in the selected mode.
- Assuming the feed can resume indefinitely after an extended outage.
- Publishing external effects inside a database transaction and claiming atomicity across services.

## Production notes

Choose the feed mode based on whether consumers need current state or a bounded history of all changes. Make every consumer restartable and idempotent. Alert on lag relative to recovery horizon, not merely process health. Reconcile projections periodically, document backfill procedure, and test duplicate delivery, poison items, failover, and retention gaps before launch.

## Ordering, tombstones, and consumer contracts

The useful unit of ordering is the logical partition, so a consumer that combines records from different keys should not impose a global sequence unless it has an application-level ordering key. Timestamps can help diagnose delay, but they are not a universal substitute for a per-entity version. If two updates to one item arrive close together, a projection should avoid letting a delayed older version overwrite a newer one. Store source version metadata or re-read the latest item when only current state matters.

Delete handling needs an explicit data contract. A soft delete can be represented as a normal item update and consumed in latest-version mode, but it leaves a tombstone to expire or archive. A hard delete may require a mode that exposes deletes or a separate durable outbox event. Consumers should also handle TTL expiration according to the selected mode. Test delete, recreate, and item-ID reuse carefully, because a stale projection can otherwise resurrect a deleted record.

Design poison-message behavior without sacrificing visibility: record the item identity and error, apply a bounded retry policy, then quarantine for manual repair or code correction while allowing healthy work to continue if the processor model permits. Reprocessing should be idempotent. Maintain a runbook for rebuilding from source, clearing and recreating leases safely, and validating projection parity. A consumer is not operationally reliable merely because it starts; its lag, checkpoint age, error rate, and recovery horizon must be observed.
