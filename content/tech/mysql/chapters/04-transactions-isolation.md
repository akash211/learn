# Transactions, Isolation, MVCC, and Gap Locks

InnoDB transactions combine atomic changes, isolation between concurrent sessions, and recovery after failure. The transaction boundary also defines how long locks and old row versions must remain available. A short query inside a long transaction can therefore have a large operational footprint. Keep the application transaction as small as correctness allows, and make its isolation assumptions explicit.

## Commit and rollback

With autocommit enabled, each successful statement is its own transaction unless an explicit transaction is opened. `START TRANSACTION` begins a unit of work; `COMMIT` makes its changes visible and durable according to server and storage settings; `ROLLBACK` abandons its uncommitted changes. DDL has implicit-commit behaviour in MySQL, so schema changes do not generally participate in an application's multi-statement transaction as an ordinary DML statement would.

```sql
START TRANSACTION;
UPDATE accounts SET balance = balance - 25 WHERE account_id = 10;
UPDATE accounts SET balance = balance + 25 WHERE account_id = 20;
COMMIT;
```

Both updates should be checked for the expected affected-row count before commit. If the second update fails or the business invariant is not met, roll back. A deadlock victim is rolled back by InnoDB; application code must be prepared to retry the complete transaction, with bounded retries and idempotent external side effects.

## InnoDB MVCC and read views

InnoDB keeps transaction metadata and undo records that let a consistent read reconstruct a version visible to its read view. Ordinary consistent `SELECT` statements do not generally lock the rows they read. This is why readers can coexist with writers without every read blocking a change, while an update creates a new version and older versions remain available until no active read view needs them and purge can clean them up.

This is not the same physical model as PostgreSQL's heap tuple versions: InnoDB's clustered row is updated in place when possible, with undo preserving prior values. A long-running transaction can hold an old read view and prevent purge from discarding historical versions. That can grow undo history even if the transaction is not actively issuing queries. `SHOW ENGINE INNODB STATUS\G` and transaction views help identify old transactions; fix the transaction lifecycle rather than treating undo growth as a routine reason to expand storage.

## Isolation levels

InnoDB supports `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`, and `SERIALIZABLE`. MySQL's default for InnoDB is `REPEATABLE READ`, unless changed by configuration or the session. At `READ COMMITTED`, each consistent read gets a fresh snapshot; at `REPEATABLE READ`, consistent reads in a transaction normally share a read view established by the first consistent read. Exact behaviour differs between consistent nonlocking reads and locking reads.

A locking read such as `SELECT ... FOR UPDATE` requests locks on records it accesses and is used when application logic must reserve rows before deciding what to write. `SELECT ... FOR SHARE` acquires shared locks. A plain consistent read under repeatable read does not become a current read just because another transaction commits later. Mixing snapshot reads with locking reads can surprise code if the two see different notions of current data; structure the transaction around one clear concurrency-control pattern.

## Next-key and gap locking

InnoDB's locking reads and writes can acquire record locks, gap locks on index intervals, or next-key locks that combine a record and the gap before it. At the default `REPEATABLE READ`, next-key locking helps prevent phantom rows for range operations. A range update or `SELECT ... FOR UPDATE` can therefore block an insert into a gap even when the inserted key does not yet exist. This is a frequent source of apparently unrelated insert waits.

At `READ COMMITTED`, gap locking is generally reduced for searches and index scans, though it remains relevant in cases such as foreign-key and duplicate-key checking. Exact lock behaviour depends on the access path and statement. The index used is crucial: a broad scan can lock far more records and gaps than the business predicate suggests. Use `performance_schema.data_locks` and `data_lock_waits` on supported MySQL 8.0 releases to inspect current lock holders and waiters.

Deadlocks are expected in a system that permits concurrency. Two transactions can take locks in opposite orders; InnoDB detects the cycle and aborts one. Reduce frequency by accessing rows in a consistent order, keeping transactions short, and indexing predicates so scans do not lock excessive ranges. Do not disable deadlock detection as a first response; diagnose the actual lock graph and retry correctly.

## Isolation is not a substitute for constraints

Application-side check-then-insert logic can race: two sessions both observe no row and both insert. Encode invariants with unique constraints or foreign keys where possible. For more complex invariants, choose a locking protocol or transaction isolation deliberately and verify it under concurrent tests. `SERIALIZABLE` can strengthen guarantees but may introduce more waits and aborts; it is not a free correctness switch.

## Inspecting locks and transaction age

For a live incident, take a snapshot of blocking relationships before they disappear. `performance_schema.data_locks` contains held and requested data locks, while `performance_schema.data_lock_waits` links waiters to blockers in current MySQL 8.0 releases. Join these records to transaction and thread information where useful, then map the connection to its application request. Metadata locks are a separate mechanism; inspect Performance Schema metadata-lock instrumentation when DDL is stuck. A row-lock view alone cannot explain every blocked statement.

The slowest-looking query is not always the blocker. A transaction may have performed one update, then remained open while the application made a remote call. It holds row locks and can retain an old consistent-read view even when the connection is now sleeping. Record transaction start time and state, then coordinate safe rollback. Rollback itself may take a while for a large transaction and can compete for I/O, so plan capacity rather than assuming a kill instantly frees everything.

Deadlock reports show a selected cycle and the statements and locks involved; they are evidence for the conflicting access order. Reproduce with two sessions in a test environment. If the application retries, include all reads and writes in the retry and use bounded randomized backoff to avoid synchronized retry storms. Keep externally visible side effects outside the retryable unit or make them idempotent.

## Production notes

- Set lock and statement timeouts at a layer appropriate to the server version and client library; monitor lock wait duration.
- Record transaction age, deadlocks, and rollback/retry rates, not just query latency.
- Avoid user interaction or network calls inside a database transaction.
- Be explicit about transaction boundaries in connection pools, where a forgotten commit can leak state to the next borrower.

## Common mistakes

- Assuming a plain `SELECT` always locks rows or that every read sees the latest committed version.
- Assuming gap locks are absent because a lock wait names a key that is not present.
- Retrying only the failed statement after a deadlock instead of retrying the full transaction.
- Leaving a transaction open while application code waits on unrelated work.
- Using `SERIALIZABLE` without understanding its increased contention and retry behaviour.
