# Design Patterns, Replay and When Kafka Is Overkill

Kafka is valuable when multiple systems need a durable, replayable stream with independent consumers and a clear partitioned ordering model. It is not a default replacement for every database table, task queue, or synchronous API. Good design starts from the business fact being represented and the failure behavior required, then chooses a pattern that Kafka supports without pretending it removes distributed-systems tradeoffs.

## Event sourcing and event-driven integration

In **event sourcing**, the authoritative state is derived from an append-only sequence of domain events. Events such as `OrderPlaced` and `PaymentCaptured` describe facts that happened; a consumer builds a projection or read model. Kafka's append-only partitions, retention, and replay can support this architecture, but a topic is not automatically an event store. Retention may remove history, compaction may discard intermediate changes, and partition ordering is local. If the event log is the legal system of record, durability, backup, schema governance, access control, and long-term retention must be designed accordingly.

Many Kafka systems are event-driven without being event-sourced. A relational database remains the source of truth, while Kafka distributes change notifications to downstream services. The distinction matters: rebuilding a projection from Kafka is possible only if the retained stream contains the complete facts needed to do so. A `CustomerUpdated` snapshot event may rebuild current state but not explain how it evolved; a sequence of domain events can, but requires more care around schema and domain semantics.

Events should name facts, carry a stable event identifier and entity key, and document timestamp meaning. Consumers should tolerate duplicates and out-of-order arrival across partitions. Within a key's partition, order is preserved; events for different keys have no global order. If a business invariant depends on a total order across entities, Kafka partitioning alone will not provide it.

## The outbox pattern

A service that writes to a database and publishes to Kafka faces a dual-write problem. A database commit followed by a failed publish loses the notification; publish before commit can expose a fact that later rolls back. The **transactional outbox** stores the business change and an outbox row in the same database transaction. A relay process or CDC connector reads committed outbox rows and publishes them. The database transaction makes creation of business state and intent to publish atomic.

The relay may publish an outbox event more than once if it crashes after Kafka accepts the record but before it records source progress. Consumers should deduplicate using the event ID or make their effect idempotent. Outbox tables need cleanup, access controls, schema versioning, and monitoring of oldest unpublished row. A single poller can become a bottleneck; CDC-based capture can scale differently but adds database log and connector operations. Do not delete outbox rows before the relay has advanced and the recovery policy allows it.

## Dead-letter and retry patterns

A **dead-letter topic** holds records that a consumer cannot process after an intentional retry policy. It should preserve the original key, value, headers, topic/partition/offset, error class, and a safe diagnostic context. Do not include credentials or sensitive exception text without review. A DLQ is not a trash can: assign an owner, alert on volume, define remediation, and provide a safe replay procedure. A poison record should not block an entire partition forever, but skipping it can violate ordering or state invariants, so decide what the business can tolerate.

Retry topics can delay processing before another attempt, but they alter ordering: later events may pass a delayed earlier event. If strict per-key order matters, a separate retry pipeline may be unsafe unless it pauses that key or otherwise preserves ordering. Infinite retries create unbounded delay and can clog partitions. Use bounded attempts, exponential backoff where appropriate, and route irrecoverable failures with enough context for repair.

## Replay as an operational capability

Replay means reading records again from a chosen offset and applying them to a sink. It is one of Kafka's strongest features and one of its biggest sources of accidental side effects. Before resetting offsets, identify the group, topic and partitions; record current committed offsets; estimate replay volume; verify retention; confirm sink idempotency; and decide whether existing output must be deleted or versioned. Replaying an event into a payment API is not equivalent to rebuilding a disposable cache.

A safe rebuild often writes to a new projection or table version, validates counts and invariants, then atomically switches readers. This avoids mixing old and replayed results in place. If the consumer has external state, define a snapshot/checkpoint and the offset boundary it corresponds to. A database snapshot without a matching Kafka position can create gaps or duplicates.

## When Kafka is overkill

Kafka adds brokers or a managed service, partitioning decisions, schema and topic governance, consumer operations, monitoring, security, retention planning, and failure handling. It can be unnecessary when one application makes a synchronous request to one service, a small scheduled job reads a database directly, or a modest durable work queue is better served by a simpler broker. A database outbox plus polling can be sufficient for low volume. A cloud queue may fit independent work items with per-message acknowledgment and visibility timeouts more naturally.

Kafka is a strong choice when multiple consumers need independent read positions, event replay matters, write and read rates justify the platform, partitioned ordering is useful, and the organization can operate or buy the service with clear guarantees. A managed service reduces broker administration but does not remove application design: keys, offsets, schemas, transactions, retention, ACLs, and replay remain the team's responsibility.

A simple decision checklist: How many independent consumers? How much data and for how long? Is replay a requirement or merely a possibility? What ordering boundary is needed? Can consumers handle duplicates? Who owns cluster or service operations? What is the consequence of lag, broker unavailability, or expired data? If those questions have simple answers and the workload is small, start simpler and preserve the option to evolve.

## Common mistakes

- Calling a Kafka integration “event sourcing” when the database remains authoritative and the topic is only a notification feed.
- Publishing directly after a database commit and assuming producer idempotence closes the dual-write gap.
- Moving a failed event to a DLQ without documenting how it is fixed, replayed, or reconciled.
- Resetting a group offset in production without saving the previous values and checking side effects.
- Using retry topics that reorder events while claiming strict per-key order.
- Selecting Kafka for prestige or anticipated scale without accounting for ongoing operations and simpler alternatives.

## Production notes

Every topic deserves an owner, purpose, key, schema policy, retention policy, access policy, and documented replay contract. Every consumer needs a failure and lag response. For important pipelines, maintain a replay runbook and test it in a non-production environment with real schema versions and realistic data. Define what success looks like after replay: counts, checksums, balances, or domain invariants. The right design is not the one with the most Kafka features; it is the one whose data and failure semantics are understandable to the team that must recover it.