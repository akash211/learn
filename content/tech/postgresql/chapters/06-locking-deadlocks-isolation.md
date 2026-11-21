# Locking, Deadlocks and Isolation in Practice

PostgreSQL has two concurrency mechanisms that are easy to confuse. **MVCC** handles read/write
conflicts without locks at all. **Locks** handle write/write conflicts, and the isolation level
decides which read anomalies the engine must additionally prevent. Most production incidents
labelled "locking" are really one of: a transaction that is too long, a lock taken at the wrong
granularity, or an isolation level that does not provide the guarantee the code assumes.

## Table-level locks

Every statement takes a lock on the table itself, in one of eight modes. The names are historical
and unhelpful; what matters is what conflicts.

| Statement | Lock taken |
| --- | --- |
| `SELECT` | `ACCESS SHARE` |
| `SELECT ... FOR UPDATE` | `ROW SHARE` |
| `INSERT`, `UPDATE`, `DELETE` | `ROW EXCLUSIVE` |
| `VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` |
| `CREATE INDEX` (without `CONCURRENTLY`) | `SHARE` |
| `CREATE TRIGGER`, some `ALTER TABLE` forms | `SHARE ROW EXCLUSIVE` |
| `ALTER TABLE`, `TRUNCATE`, `DROP`, `VACUUM FULL` | `ACCESS EXCLUSIVE` |

The practical rule: `ACCESS EXCLUSIVE` blocks everything including `SELECT`, and it queues. Because
PostgreSQL's lock queue is (essentially) first-in-first-out, a single `ALTER TABLE` waiting behind
a long query will block every subsequent `SELECT` on that table even though `SELECT` does not
conflict with the `ALTER` itself. This is the classic "a migration locked the whole site" incident.

Always run DDL with a timeout:

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN channel text;
```

If it times out, retry later — the migration did not half-apply.

## Row locks live in the tuple, not in a lock table

`UPDATE` takes an exclusive row lock by setting `xmax` in the new tuple header. There is no
in-memory lock table entry per row, so updating a million rows does not consume a million locks;
`max_locks_per_transaction` is about *objects*, not rows. Memory grows only when multiple
transactions lock the same row, which produces a **multixact**.

Row lock modes, weakest to strongest:

| Clause | Blocks |
| --- | --- |
| `FOR KEY SHARE` | only `FOR UPDATE`; taken by foreign-key checks |
| `FOR SHARE` | `FOR UPDATE`, `FOR NO KEY UPDATE`, `UPDATE`/`DELETE` |
| `FOR NO KEY UPDATE` | writers that change the key; implied by a non-key `UPDATE` |
| `FOR UPDATE` | every other row lock and every writer |

The `NO KEY` variants exist so that an `UPDATE` of a non-key column does not block a foreign-key
check on that row. This is why a hot parent row does not serialise every child insert — but it does
if you take `FOR UPDATE` on it unnecessarily.

`FOR UPDATE` also re-reads the *latest* committed version (in READ COMMITTED), which is what makes
it a correct read-modify-write primitive. `FOR UPDATE NOWAIT` fails immediately instead of
queueing; `SKIP LOCKED` steps over locked rows, which is the basis of a work queue:

```sql
WITH claimed AS (
  SELECT id FROM jobs
  WHERE status = 'queued'
  ORDER BY id
  FOR UPDATE SKIP LOCKED
  LIMIT 10
)
UPDATE jobs j SET status = 'running', started_at = now()
FROM claimed c
WHERE j.id = c.id
RETURNING j.*;
```

This is correct and scales to many consumers. It is not a queue with ordering guarantees, and a
worker that dies mid-job leaves the row `running` — you still need a reaper.

## Deadlocks

A deadlock is a cycle in the wait-for graph. PostgreSQL detects it after `deadlock_timeout`
(default 1 s) and terminates one transaction with SQLSTATE `40P01`; the survivor proceeds.

```
session A: UPDATE accounts SET ... WHERE id = 1;   -- holds row 1
session B: UPDATE accounts SET ... WHERE id = 2;   -- holds row 2
session A: UPDATE accounts SET ... WHERE id = 2;   -- waits on B
session B: UPDATE accounts SET ... WHERE id = 1;   -- waits on A -> deadlock
```

Three causes cover most cases:

1. **Inconsistent lock ordering.** Two code paths touch the same rows in different orders. Sort the
   keys before locking — `SELECT ... WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE` — and make
   the ordering a rule, not a habit.
2. **Multi-row `INSERT ... ON CONFLICT DO UPDATE`.** Two sessions inserting overlapping key sets in
   different orders deadlock on the speculative insertion locks. Sort the input rows by key before
   the statement.
3. **Foreign keys plus explicit locks.** An insert takes `KEY SHARE` on the parent; if the same
   transaction also updates the parent, the combined lock order can cycle with another session
   doing the reverse.

Diagnosis:

```sql
SELECT pid, pg_blocking_pids(pid) AS blockers, state,
       wait_event_type, wait_event, now() - xact_start AS xact_age,
       left(query, 80) AS query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0
ORDER BY xact_age DESC;
```

A deadlock is self-healing; a **blocking chain** is not. The query above distinguishes them: a
blocker with no blockers of its own and a 40-minute-old `xact_start` is the root, and the fix is
usually to end that transaction, not to raise `deadlock_timeout`.

Application code must retry `40P01` and `40001` with backoff, and the retried unit must be the
whole transaction. A retry loop around a single statement inside an aborted transaction retries
into `25P02 in_failed_sql_transaction` forever.

## Isolation levels, and the anomalies that survive

| Anomaly | READ COMMITTED | REPEATABLE READ | SERIALIZABLE |
| --- | --- | --- | --- |
| Dirty read | prevented | prevented | prevented |
| Non-repeatable read | **possible** | prevented | prevented |
| Phantom read | **possible** | prevented (PG) | prevented |
| Lost update | **possible** | raises `40001` | prevented |
| Write skew | **possible** | **possible** | prevented |

Two things surprise people:

**REPEATABLE READ in PostgreSQL is snapshot isolation**, not the ANSI definition (which permits
phantoms). It prevents phantoms, and it converts a concurrent update conflict into
`could not serialize access due to concurrent update`. That is a feature: it makes lost updates
impossible, at the cost of a retry path you must actually implement.

**Write skew survives REPEATABLE READ.** Two transactions each read the same predicate, each update
a *different* row, and together violate an invariant:

```sql
-- Two doctors on call; each goes off call, each checks "the other one is still on"
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM doctors WHERE on_call AND ward = 'ICU';   -- both see 2
UPDATE doctors SET on_call = false WHERE id = $me;             -- each sets a different row
COMMIT;                                                        -- now zero on call
```

Fixes, in order of preference: `SERIALIZABLE` (SSI detects the read-write dependency cycle and
aborts one), or materialise the conflict by locking a common row — a `ward_staffing` row with
`SELECT ... FOR UPDATE` — which is cheaper than SSI and easy to reason about. `SERIALIZABLE` is the
only level where you can write business rules and trust them, but it requires retry logic
everywhere and costs predicate-lock memory (`max_pred_locks_per_transaction`).

## Production notes

- Set `lock_timeout` on application roles (a few seconds) and `statement_timeout` on everything.
  A query that queues for a lock forever also holds a connection and an xmin.
- `idle_in_transaction_session_timeout` bounds the damage from an application that opens a
  transaction and then calls an external API.
- Advisory locks are the right tool for cross-process mutual exclusion:
  `SELECT pg_try_advisory_xact_lock(hashtext('billing:2026-11'))` releases automatically at commit.
- Monitor `pg_locks` count and `pg_stat_database.deadlocks`; a rising deadlock count is a code
  ordering bug, not a tuning problem.

## Common mistakes

- Reaching for `READ UNCOMMITTED` to stop waits. PostgreSQL silently maps it to READ COMMITTED;
  dirty reads are never available.
- Taking `SELECT ... FOR UPDATE` on a large set and holding it across an HTTP call.
- Assuming a deadlock means the database is broken, then raising `deadlock_timeout` so it takes
  longer to detect.
- Implementing retries that wrap one statement instead of the whole transaction.
- Running `ALTER TABLE` without `lock_timeout` and blocking every reader behind the DDL queue.
