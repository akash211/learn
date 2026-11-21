# Transactions and Consistency Guarantees

MongoDB makes each write to a single document atomic, even when it changes several embedded fields or array elements. This is the primary consistency tool for a document model: keep invariants inside one aggregate where practical. Multi-document transactions extend atomic commit across documents and, on supported deployments, collections and shards. They are useful when a business invariant genuinely crosses document boundaries, but they add coordination, resource use, and retry complexity.

## When a transaction is justified

Suppose a transfer must debit one account and credit another without exposing a half-transfer. If both account balances are separate documents, a multi-document transaction can make the two updates commit or abort together. In contrast, updating an order's status and its embedded payment metadata can usually be a single-document conditional update. Before adding a transaction, ask whether the data model can put the invariant within one document without creating an unbounded or hot aggregate.

Transactions require a replica set or sharded cluster; a standalone `mongod` is not enough. Transactions have a lifetime limit and consume resources while open. Keep them short, avoid user interaction or slow external calls inside them, and do not use them as a wrapper around arbitrary long batch jobs. A transaction coordinates MongoDB state only: it cannot atomically include a payment provider, email, or message broker. Use an outbox or saga pattern for those cross-system workflows.

## Session and retry model

Drivers expose sessions and transaction helpers. A typical pattern is:

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await accounts.updateOne(
      { _id: fromId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { session }
    );
    await accounts.updateOne(
      { _id: toId },
      { $inc: { balance: amount } },
      { session }
    );
    await transfers.insertOne({ fromId, toId, amount, createdAt: new Date() }, { session });
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
} finally {
  await session.endSession();
}
```

This is schematic driver code: production code must check the first update's matched count and handle insufficient funds, missing destination, and limits on the transfer amount. Drivers may retry a transaction after transient errors; the callback can execute more than once. Do not put non-idempotent external side effects inside it. A commit can have an unknown outcome from the client's perspective when the connection fails; use driver transaction APIs that handle retryable commit semantics and design operation identifiers so the application can reconcile safely.

## Read and write concerns

Read concern controls the consistency properties of data returned by a read. `local` is common and may return data not yet majority committed; `majority` reads data acknowledged by a majority of voting members; `snapshot` provides a consistent snapshot for a transaction (and is available for some other operations). Exact guarantees vary with deployment and version; specify the requirement rather than treating a concern as a latency knob.

Write concern defines the acknowledgment required for a write. `w: 1` acknowledges at the primary; `w: "majority"` waits for the write to be committed by a majority of voting members, with journaling behavior depending on configuration and version. `w: 0` is unacknowledged and unsuitable when the application must know whether a write succeeded. A timeout can mean the write outcome is uncertain, not necessarily that no write occurred. Retryable writes can safely retry supported single-document writes with an appropriate driver and deployment, but they do not turn arbitrary business workflows into exactly-once execution.

Causal consistency in a session lets a client observe its own causally ordered operations under appropriate read/write concerns. It does not mean every client sees every write immediately, nor does it replace transactions for invariants. Linearizable read concern provides a stronger real-time ordering guarantee for reads from a primary in supported cases, with availability and latency costs. Use it only when the invariant requires that level of guarantee.

## Transactions across shards

A transaction can span shards, but distributed commit adds coordination and may increase latency. Data locality matters: a transaction that touches many shards increases operational cost and risk of aborts. Design shard keys and document boundaries so common transactional work is targeted. A transaction is not a substitute for selecting a good shard key or for keeping an operation bounded.

## Common mistakes

- Starting a transaction for every write even when one document already provides atomicity.
- Assuming a transaction includes an external payment, queue publish, or email.
- Performing a non-idempotent side effect in a transaction callback that the driver may retry.
- Treating `w: "majority"` as a guarantee of application-level exactly-once behavior.
- Ignoring an ambiguous commit result and blindly repeating business operations.

## Production notes

Define the required invariant first, then choose document atomicity, conditional updates, transactions, or an outbox/saga. Set read and write concerns explicitly where consistency is important. Monitor transaction aborts, duration, lock and cache pressure, and replication conditions. Test failover and retry paths with the actual driver; transaction correctness depends on correct driver usage as well as server semantics.
## A safer transaction shape

The earlier transfer example needs explicit preconditions and a durable identity. A transaction should reject insufficient funds and should not silently continue if the destination is missing. Conceptually, the callback checks the result of each conditional update, writes a transfer record with a unique request ID, and commits all three effects together. If either condition fails, it aborts and the application reports a domain conflict. The unique request ID protects against a client repeating the business request after an ambiguous network result; transaction atomicity alone does not tell the disconnected client whether commit succeeded.

Transactions are optimistic in important ways: concurrent modifications can cause conflicts or transient errors, so callers should expect aborts and retry only according to driver guidance. Keep the callback deterministic with respect to database state and safe to invoke again. Do not generate externally visible side effects in it. Generate a stable transfer ID before starting, and use that identity when reconciling a commit whose result was lost. For operations that also publish an event, insert an outbox document in the same database transaction, then have a separate worker publish it idempotently and mark progress.

## Consistency is a set of choices

A consistency requirement should be phrased as an observable property: “the customer sees their successful update on the next read,” “an acknowledged order survives a primary loss,” or “a balance never goes negative.” Each property suggests different mechanisms. A conditional single-document update can protect one state transition; majority write concern addresses replication acknowledgment; a causal session can preserve ordering across a client's operations; a transaction can commit multiple MongoDB documents together. None automatically guarantees that a cache, search index, external payment provider, and database all change atomically.

Read and write concerns are scoped options and may be set at client, database, collection, or operation level subject to driver rules. Avoid relying on inherited defaults for a critical workflow: make the needed setting visible in code or configuration, and test how it behaves during loss of a member or majority. `wtimeout` limits how long the client waits for the requested acknowledgment; it does not cancel the already-issued write. When a timeout occurs, reconcile by stable ID before deciding to retry.

Transaction duration, number of documents, and cross-shard participation all influence resource cost and abort likelihood. Measure transaction latency and abort reasons, and keep transaction boundaries no larger than the business invariant requires. A transaction is a correctness tool, not a batch-processing convenience or an alternative to an explicit recovery design.
