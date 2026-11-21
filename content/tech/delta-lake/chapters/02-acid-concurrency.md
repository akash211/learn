# ACID, Optimistic Concurrency and Conflict Resolution

Delta Lake adds table-level transaction semantics to files on object storage. The useful mental model is **optimistic concurrency control (OCC)**: writers proceed in parallel without taking a long-lived exclusive lock, then validate their planned changes at commit time. A transaction either publishes a complete new table version or does not become visible as a partial table update. This is strong protection against many races, but it does not imply serializable transactions across every table, engine and external side effect.

## ACID in a file-backed table

**Atomicity:** A reader observes a committed version, not a mixture of old and new data files. New files are staged before the transaction log publishes them. Failed attempts can leave orphan files, but those files are not part of the snapshot and may be reclaimed later.

**Consistency:** Each commit preserves the invariants the client and table declare. Schema checks, constraints, protocol compatibility and operation logic matter here. Delta cannot validate business rules that were never encoded, nor can one writer enforce a constraint it does not understand. A feature requiring a newer protocol can exclude older writers precisely because silently ignoring the feature would violate consistency.

**Isolation:** Readers use a stable snapshot while concurrent changes commit. Writer isolation and conflict detection depend on operation type, predicates, table layout, isolation configuration and implementation. Do not infer a database-wide isolation level from the word ACID; verify the semantics for the runtime and command in use.

**Durability:** After a successful commit is acknowledged, the table version and its referenced data must persist according to storage guarantees. Object-store durability is generally strong, but credentials, lifecycle rules, replication and external deletion policies can still destroy referenced files. Delta cannot protect files removed behind its back.

## The optimistic write path

A writer captures a starting snapshot at version *v*, evaluates its input and identifies the files it reads or may replace. It writes candidate output files, then tries to commit at the next available version. Before publication, it checks whether commits since *v* invalidate the transaction's assumptions. If no conflicting change is found, the commit can proceed. If another writer already took the next version, the candidate may be retried against the new state or rejected as a conflict.

This design is fast when conflicts are rare: readers are not blocked while a writer computes, and append-only writers to disjoint data often coexist well. It shifts cost to validation and retry when contention is high. An application must not mistake a failed transaction for a successfully applied update, and it should not blindly retry non-idempotent upstream effects.

## What conflicts?

A conflict is not simply “two jobs wrote at the same time.” Delta compares the actions and read/write sets, often with partition predicates and operation semantics. Two append operations can often both succeed because they add disjoint files. Two writers replacing overlapping partitions are more likely to conflict. A `MERGE` may read files to find matching keys; a concurrent update to those files can invalidate the merge's result even if the writers produce different output files.

| Pattern | Typical concern |
|---|---|
| Independent append batches | Usually low conflict, but duplicate input or duplicate batch execution remains an application problem. |
| Overwrite of the same partition | Competing replacements can conflict or one must retry from a fresh snapshot. |
| Broad `MERGE` and concurrent updates | Overlapping read sets raise conflict probability; narrow predicates and correct partition pruning help. |
| Metadata/schema change during write | Writers based on old metadata may fail and need to re-plan. |
| Two different tables | Separate table commits do not automatically form a single atomic transaction. |

Exact exception types and the set of conflicts detected vary across OSS Delta, Databricks Runtime, protocol features and version. Treat errors such as concurrent append, delete/read, metadata-changed or protocol-changed failures as signals to inspect the conflicting operations, not as one universal retry category.

## Conflict resolution is an application policy

The safe resolution is often to reload the latest table state and recompute the logical change. If an ingestion batch has a stable identifier, make it idempotent: record or derive that identifier and ensure replay cannot duplicate effects. If changes are keyed CDC events, order them by a source sequence/version and make the merge condition reject stale updates. If two users are editing the same entity, define a business rule (last-write-wins, source priority, reject-and-review) rather than letting job start time choose accidentally.

A retry loop should be bounded, use backoff, and distinguish retryable concurrency conflicts from invalid schema, bad data, authorization errors and unsupported protocol features. Retrying a schema mismatch forever wastes compute. Retrying a conflict with the same stale snapshot may reproduce the conflict. For multi-step workflows, make each task restartable and publish a final success marker only after all required steps complete.

## Isolation levels and guarantees

Delta's default isolation behavior can be configured in some implementations, and platform runtimes may provide optimizations such as row-level concurrency. These features have prerequisites and version constraints. Row-level concurrency is not a general license for arbitrary simultaneous writes; overlapping row predicates, metadata operations, deletion vectors, partitioning and operation type can affect whether transactions proceed independently. State the actual runtime, table features and transaction semantics when designing a high-concurrency system.

A successful `MERGE` is atomic for its target table, but it is not an atomic transaction with a Kafka offset commit, an Airflow task state update or a second table write. End-to-end correctness usually combines source offsets/checkpoints, idempotent writes, deduplication keys and explicit recovery procedures.

## Common mistakes

- **Claiming “Delta prevents duplicates.”** It serializes table commits; it cannot know that the same source batch was submitted twice.
- **Blindly retrying every exception.** Only specific transient conflicts are candidates for recomputation and retry.
- **Treating an overwrite as a lock.** Concurrent overwrite semantics and predicate scope must be understood; broad replacements can conflict or erase intended changes.
- **Assuming cross-table ACID.** A multi-table pipeline can fail between commits and needs reconciliation or a platform feature explicitly providing broader transaction scope.
- **Using driver wall-clock as event order.** Late and out-of-order CDC requires source sequence semantics.

## Production notes

Record table version, source batch identity, operation metrics and retry count with each pipeline run. Alert on conflict rate and repeated retries: rising contention often indicates overlapping partitions, too many writers, overly broad merge predicates or a missing ownership boundary. When a conflict is resolved by re-running, verify the resulting business rows and source progress, not merely that the job returned success. A useful test harness deliberately launches overlapping writes against a disposable table and checks both accepted outcomes and rejected conflicts. This surfaces assumptions about partition predicates before production concurrency makes them expensive.