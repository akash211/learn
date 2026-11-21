# Consumers, Consumer Groups and Rebalancing

A Kafka consumer pulls records and tells Kafka where it intends to resume. The consumer controls the pace of fetching; the broker does not push each record into application code. A standalone consumer can read a partition directly, while a **consumer group** coordinates several members so each partition is assigned to one member at a time under the classic consumer-group model. Groups make horizontal scaling possible without making offsets part of the producer's job.

## The poll loop

The Java `KafkaConsumer` is not generally thread-safe. One thread owns the consumer and repeatedly calls `poll()`, processes returned records, and commits progress. The exact API differs by client language, but the core responsibility is the same: continue heartbeating or polling within the configured limits, handle assignment changes, and make offset commits correspond to completed work.

`max.poll.interval.ms` sets the maximum delay between calls to `poll()` for a consumer using the classic client behavior. If processing a batch takes longer than this interval, the group may consider that member failed and reassign its partitions, even if the process is still alive. `session.timeout.ms` and heartbeat behavior concern detecting a lost member; they are distinct from the processing-progress check. Increasing one timeout does not fix a slow handler or stuck downstream dependency. Prefer bounded processing, pause/resume for backpressure, and carefully designed worker handoff if processing cannot fit in a poll cycle.

`max.poll.records` limits the number of records returned in one poll, not the byte size of the fetch. Fetch-byte settings also influence the volume delivered. A batch that is too large can create long processing pauses and trigger rebalances; a batch that is too small can increase call and coordination overhead. Tune with actual record sizes, processing-time distributions, and the maximum time downstream dependencies may block.

## Partition assignment and parallelism

Within a traditional consumer group, each partition is assigned to at most one active member at a time. A topic with six partitions can give one group at most six members useful partition work under that model; extra members are idle. A member may own several partitions. This gives a simple parallelism bound, but partition count should not be chosen only from the number of current consumers: it also affects broker metadata, file handles, failover work, and future scaling.

The group coordinator manages membership and assignments. Clients can use assignment strategies such as range, round-robin, sticky, or cooperative sticky, subject to client and broker support. Eager rebalancing revokes assignments broadly before a new assignment is installed, which can stop consumption across the group. Cooperative rebalancing tries to revoke only partitions that must move, reducing disruption, but client code still must handle revocation and assignment callbacks correctly.

A rebalance can be triggered by a member joining or leaving, a crash or timeout, subscription changes, or partition metadata changes. Rebalances are normal, but frequent rebalances are an availability and throughput problem: work pauses, in-flight records may be repeated, and lag grows. A **rebalance storm** is a symptom, not a root cause. Look for `max.poll.interval.ms` violations, GC pauses, overloaded consumers, deploy churn, unstable network paths, changing subscriptions, and partitions repeatedly moving between brokers.

## Offsets and commit strategy

Kafka's group offset is a checkpoint, not proof that application side effects succeeded. With automatic commits, the client periodically commits fetched progress. If the application processes records slowly or has queued work elsewhere, automatic commits can move past work not durably completed. A crash then skips that work on restart.

Manual commits let the application define completion. A synchronous commit waits for the coordinator response and is simpler to reason about, but adds latency. An asynchronous commit avoids waiting but requires handling failures and ordering carefully; a late callback must not commit an older position after a newer one. Committing after processing yields at-least-once behavior: a crash after the side effect but before the commit causes redelivery. Committing before processing can lose work. The external side effect must be idempotent or coordinated if duplicates are unacceptable.

When work is parallelized behind the poll thread, track offsets per partition and commit only the highest contiguous completed offset. Suppose offsets 10 and 11 were dispatched to separate workers, 11 finishes first, and 10 is still running. Committing 12 would skip 10 after a crash. Pausing a partition while its work queue is full, then resuming when capacity returns, helps bound memory and preserve poll-loop liveness. Assignment revocation must drain, cancel, or safely fence outstanding work before committing final progress.

Offsets can be reset to `earliest`, `latest`, or a specific value/time depending on the client and administrative tool. If no committed offset exists, `auto.offset.reset` determines the initial position. It does not apply whenever the group restarts: an existing committed offset takes precedence. A reset is operationally a replay or skip request, so coordinate it with downstream effects and ensure retention still contains the intended records.

## Newer group protocol

Kafka's newer consumer group protocol, introduced through KIP-848, moves more group coordination and assignment work to the server and uses incremental reconciliation rather than the older all-members synchronize barrier. Its availability and maturity depend on Kafka and client versions and their configured `group.protocol`; do not assume that upgrading brokers automatically moves every consumer to it. Verify the actual protocol, supported assignor, and operational tooling in the version you run. The classic protocol remains relevant in mixed-version fleets and third-party clients. The essential application duties remain: process within the liveness contract, handle assignments, and commit only completed work.

## Common mistakes

- Adding consumers beyond the partition count and expecting proportional throughput in a classic group.
- Treating `max.poll.interval.ms` and `session.timeout.ms` as interchangeable. One bounds application progress between polls; the other participates in member liveness.
- Committing offsets for records merely fetched or queued, rather than completed.
- Blocking the poll thread for a long database call, then raising timeouts without fixing unbounded processing.
- Assuming a rebalance means Kafka lost data. Usually the issue is progress and duplicated work, not data loss.
- Resetting offsets without validating the effects of replay and the time range still retained.

## Production notes

Observe consumer lag by partition, time since last poll, commit failures, rebalance rate and duration, processing latency, and downstream queue depth. Group-level lag can hide one hot partition: a consumer cannot borrow spare capacity from another partition if a single key dominates. Track assignment changes alongside deploys and broker maintenance, and alert on sustained lag growth rather than every brief spike. A healthy consumer group needs headroom: if every member runs at maximum CPU and every poll is close to the timeout boundary, a routine restart can turn a manageable delay into a long recovery.

For reliable shutdown, stop accepting new work, finish or safely abandon in-flight processing, commit only completed contiguous offsets, and close the consumer so membership is released promptly. Test forced termination at several points: before processing, after the side effect, and before offset commit. Those failure points expose whether the system is at-least-once and whether the side effects tolerate replay.