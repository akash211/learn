# Delivery Semantics and Exactly-Once Processing

“Exactly once” is a statement about a defined boundary, not a magic property of Kafka or an application. A producer may retry after a timeout even if the broker appended the original request; a consumer may repeat a side effect after a crash; a database commit and Kafka offset commit are separate actions. Useful guarantees emerge only after specifying which records, which state changes, and which failure boundaries are covered.

## At-most-once, at-least-once, effectively-once

With **at-most-once** processing, the application advances its position before processing. A crash after the commit can skip a record permanently. This may be acceptable for lossy telemetry or replaceable state updates, but should be explicit.

With **at-least-once** processing, the application performs the effect and then commits the input offset. A crash between these steps causes the record to be processed again. No records need be lost because of that ordering, but effects can be duplicated. A common solution is an idempotent sink: write with a unique event ID and use a database constraint or upsert so the same event has the same effect once. Another is to process a partition into a deterministic output table keyed by entity/version.

“Effectively once” often describes this pattern: at-least-once delivery plus a deduplicating or idempotent effect makes externally visible results behave as one application. It is not the same as Kafka coordinating an arbitrary external database transaction. This language is useful when teams name the deduplication key, retention horizon, and sink transaction explicitly.

## Producer idempotence versus transactions

An idempotent producer uses producer identity and sequence numbers so retries of a batch to a partition do not create duplicate log entries within the producer's supported session. `enable.idempotence=true` addresses a specific ambiguity: the broker accepted a request, but its acknowledgment did not reach the client. It does not make all calls across a fleet one logical operation and does not make two distinct sends atomic.

A **transactional producer** uses a stable `transactional.id` to begin and commit or abort a transaction spanning output partitions and the consumer offsets included in that transaction. The producer must be initialized and fenced correctly; only one active producer epoch for a transactional ID is allowed to make progress. A replacement producer can take over after a failure, fencing an older instance that wakes up late.

A typical consume-transform-produce cycle uses a consumer with `enable.auto.commit=false`, starts a producer transaction, writes output records, and calls `sendOffsetsToTransaction()` with the offsets of input records already processed. It then commits the Kafka transaction. If it aborts, both output records and the included offset advances are rolled back from the point of view of committed readers. This composes input position and output append within Kafka, so recovery can repeat the input without exposing duplicate committed output.

The consumer must set `isolation.level=read_committed` to ignore aborted transactional records. `read_uncommitted` is the default in common client configurations and may expose records written by transactions that later abort. Read-committed consumption stops at the last stable offset while an earlier transaction remains open; a long-lived transaction can therefore delay visibility of later records in the same partition. Keep transactions bounded and handle commit/abort failures rather than leaving them open during long external work.

## The boundary of the guarantee

Kafka transactions cover Kafka records and Kafka group offsets. They do not automatically include a relational database, object store, HTTP call, email, or payment provider. If a consumer writes to PostgreSQL and then commits its Kafka offset, a crash after the database commit but before the offset commit may repeat the database operation. If it commits the offset first, a crash before the database write can lose the effect. Use database transactions and idempotency keys, an outbox/inbox pattern, or a framework that deliberately coordinates the specific systems involved.

A transactional outbox writes a business row and an event row in one database transaction. A CDC connector later publishes the committed outbox event. This removes the application's database-plus-Kafka dual write, though connector delivery and downstream effects still need replay-safe handling. An inbox table can record an event ID in the same transaction as a consumer's state change to deduplicate retries.

Transactions also have operational costs. They require a transactional ID strategy that is unique per logical producer shard, broker transaction state management, compatible topic settings, and monitoring of aborts and timeouts. Reusing one ID concurrently causes fencing; generating a new random ID on every restart can undermine continuity and complicate recovery. If a transaction spans many partitions, it may increase coordination work and delay visibility. Keep the scope as small as the atomicity requirement allows.

## Error handling

The client distinguishes retriable failures from errors that require aborting or reinitializing. A transaction can time out, be fenced by a newer producer, or fail while committing. The application must not assume that an exception means “nothing was written”; transaction state and committed visibility matter. Use the client transaction API's prescribed recovery path, abort when appropriate, and avoid hiding fatal errors behind a generic retry loop.

Consumers should also consider rebalances. If a partition is revoked while a transactional processing unit is open, the application needs to abort or complete work safely and avoid committing offsets for partitions it no longer owns. Group membership and transaction ownership are related application concerns, but they are not the same mechanism.

## Choosing the guarantee for a pipeline

Start by drawing the boundaries between input, compute, and output. For a Kafka-to-Kafka transform, a transaction can include offsets from the input group and records sent to output topics. For a consumer that updates a relational table, the database transaction is outside Kafka's transaction coordinator. A safe design might insert the event ID into an inbox table and update business state in the same database transaction; a uniqueness constraint then makes a replay a no-op. Another design can use an upsert whose result is deterministic for the same event.

The right answer also depends on what a caller observes. A producer may receive a timeout even though the transaction committed, so a retry at the API boundary can create a second business command unless that command carries an idempotency key. A downstream `read_committed` consumer sees committed output, but it cannot tell whether an external email or payment API was called twice. Map each visible side effect and include its deduplication or reconciliation strategy in the guarantee statement.

## Common mistakes

- Saying “Kafka is exactly-once” without stating producer-to-log, Kafka-to-Kafka, or Kafka-to-database scope.
- Setting `enable.idempotence=true` and assuming it prevents duplicate application events or external side effects.
- Using `read_uncommitted` when aborted output must remain invisible.
- Processing a long remote API request inside an open Kafka transaction and causing read-committed consumers to stall behind the transaction.
- Assigning the same `transactional.id` to concurrently active logical producers.
- Committing input offsets separately before output in a consume-transform-produce pipeline.

## Production notes

Write down the failure table for the pipeline: crash before input fetch, after fetch, after effect, during output, during transaction commit, and after commit before acknowledgment to the caller. For every point, specify what is replayed and why the resulting state is correct. Test broker failover and process termination, not only normal transaction commits. Track transaction abort rate, timeout rate, fencing errors, and the age of open transactions. Exactly-once is a system property of the whole path that has been designed and tested—not a checkbox attached to an application.