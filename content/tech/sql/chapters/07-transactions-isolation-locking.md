# Transactions, Isolation and Locking

A transaction is a unit of work that either commits entirely or not at all. Isolation is the
promise about what concurrent transactions can see of each other. The two are usually taught
together and then forgotten, which is why concurrency bugs appear as "impossible" data states
that no single query can reproduce.

## ACID, without the ceremony

- **Atomicity** — all statements commit or none do. Implemented with a write-ahead log: the
  log record hits durable storage before the data page does.
- **Consistency** — constraints hold at commit. This is partly the database's job
  (`NOT NULL`, `UNIQUE`, `CHECK`, `FOREIGN KEY`) and partly the application's.
- **Isolation** — concurrent transactions do not observe each other's uncommitted work.
- **Durability** — a committed transaction survives a crash. `fsync`, not vibes.

Atomicity and durability come from the log. Isolation comes from concurrency control.

## The anomalies

| Anomaly | What happens |
|---|---|
| Dirty read | You read another transaction's uncommitted write |
| Non-repeatable read | You read the same row twice within a transaction and get different values |
| Phantom read | You re-run a predicate and new rows appear |
| Lost update | Two transactions read the same value, both write, one overwrites the other |
| Write skew | Two transactions read overlapping sets, each writes a different row, together they violate an invariant |

Write skew is the one that surprises people. A classic example: two on-call doctors, each
checks "is someone else on call?" (yes), each goes off call, and now nobody is on call. No
single row was updated by both transactions, so row-level locks never conflict.

## Isolation levels, and what they actually mean

| Level | Dirty read | Non-repeatable read | Phantom | Engines |
|---|---|---|---|---|
| `READ UNCOMMITTED` | Possible | Possible | Possible | SQL Server (`NOLOCK`); not real in PostgreSQL |
| `READ COMMITTED` | No | Possible | Possible | Default in PostgreSQL, SQL Server, Snowflake |
| `REPEATABLE READ` | No | No | Possible in the standard; prevented in PostgreSQL | PostgreSQL, SQL Server |
| `SERIALIZABLE` | No | No | No | All three, with different implementations |

The standard's table is a floor, not a description. Implementations differ sharply:

**PostgreSQL** uses MVCC. `READ UNCOMMITTED` is silently promoted to `READ COMMITTED`.
`REPEATABLE READ` is snapshot isolation: the transaction sees the database as of its first
statement, and a concurrent update to the same row causes a serialization failure rather than
a lost update. `SERIALIZABLE` adds Serializable Snapshot Isolation, which detects dangerous
read/write dependencies and aborts one transaction with SQLSTATE `40001`.

**SQL Server** defaults to locking `READ COMMITTED`: readers take shared locks and block
writers. `READ_COMMITTED_SNAPSHOT` (RCSI), when enabled at the database level, switches to
row-versioning and removes reader/writer blocking — a common production fix, but it changes
tempdb load and cannot be assumed. `SNAPSHOT` isolation is opt-in per database and gives
statement-consistent snapshots. `READ UNCOMMITTED` really does allow dirty reads; it is what
`WITH (NOLOCK)` means, and it is not a performance tuning button.

**Snowflake** enforces `READ COMMITTED` only. There is no user-selectable isolation level, no
dirty reads, and no lock hints. DML acquires partition-level locks while it runs and a table
lock at commit, so two large `UPDATE`s against the same table serialise — you cannot "tune"
your way around it, you design around it (separate tables, or `MERGE` in one statement).
`INSERT` writes new partitions and can often proceed in parallel; `UPDATE`, `DELETE` and
`MERGE` cannot.

## MVCC versus locking, in one paragraph

In an MVCC engine, an `UPDATE` writes a new row version and marks the old one dead; readers
keep reading the old version until it is safe to remove. Readers never block writers and
writers never block readers, at the cost of storage (dead tuples) and cleanup (vacuum in
PostgreSQL, version store in SQL Server). In a locking engine, readers and writers compete for
locks on the same rows. Neither model is universally better.

PostgreSQL's cleanup is the operational catch: every transaction holds back the xmin horizon,
so a long-running transaction — even a read-only one — prevents vacuum from reclaiming dead
rows across the whole database. A forgotten `BEGIN` in a connection pool can bloat every table
in the cluster.

## Explicit locking

```sql
-- PostgreSQL: lock the rows you are about to update
BEGIN;
SELECT * FROM orders WHERE order_id = 1042 FOR UPDATE;
UPDATE orders SET status = 'shipped' WHERE order_id = 1042;
COMMIT;

-- Queue processing: claim one row without blocking other workers
SELECT order_id FROM orders
WHERE status = 'pending'
ORDER BY order_ts
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE` takes a row-level exclusive lock; `FOR NO KEY UPDATE` is weaker and does not
block foreign-key checks. `SKIP LOCKED` makes a work queue scale: each worker takes a
different row instead of serialising behind the first. SQL Server's equivalent is
`WITH (UPDLOCK, READPAST)`. Snowflake has no row-level locking on standard tables, so queue
patterns must be built with `MERGE` and a claim column, accepting occasional contention.

Lock granularity matters: PostgreSQL locks rows and pages (and takes relation-level locks for
DDL); SQL Server escalates row locks to page and table locks, turning a hot update into a
table-wide block.

## Deadlocks

A deadlock is a cycle in the wait-for graph. Engines detect it and kill one transaction
(victim selection is engine-specific); the survivor proceeds.

```text
T1: UPDATE orders   WHERE order_id = 1;   -- locks order 1
T2: UPDATE orders   WHERE order_id = 2;   -- locks order 2
T1: UPDATE orders   WHERE order_id = 2;   -- waits for T2
T2: UPDATE orders   WHERE order_id = 1;   -- waits for T1  → cycle
```

Three defences, in order of value:

1. **Consistent lock ordering.** Always touch rows in a deterministic order (by primary key
   ascending). This eliminates most application-caused deadlocks.
2. **Short transactions.** Never hold a transaction open across a network call, a file read,
   or a user's think time.
3. **Retry on deadlock.** SQLSTATE `40P01` in PostgreSQL, error 1205 in SQL Server. A retry
   loop with jitter is mandatory for any transaction that can deadlock.

Note that a `UNIQUE` constraint violation under concurrency can also deadlock: two sessions
insert the same key, both wait on the index gap. The fix is usually `INSERT … ON CONFLICT DO
NOTHING` (PostgreSQL) or `MERGE` (SQL Server, Snowflake) rather than check-then-insert.

## Savepoints and partial rollback

PostgreSQL and SQL Server support savepoints:

```sql
BEGIN;
INSERT INTO orders (order_id, customer_id, order_ts, status, total_amount)
VALUES (2001, 17, now(), 'pending', 99.00);
SAVEPOINT after_order;
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
VALUES (2001, 501, 1, 99.00);
ROLLBACK TO SAVEPOINT after_order;   -- order survives, item does not
COMMIT;
```

Snowflake does not support savepoints. Its transactions are also auto-committed by DDL:
issuing `CREATE TABLE` inside a transaction commits the open transaction, splitting what you
thought was atomic work.

## DDL and transactions

PostgreSQL has fully transactional DDL: `CREATE TABLE`, `ALTER TABLE`, `DROP` can be rolled
back. SQL Server is transactional for most DDL too, with exceptions (`CREATE DATABASE`,
some `ALTER DATABASE` operations). Snowflake auto-commits DDL and has no rollback for it.

This affects migrations. A PostgreSQL migration that fails halfway rolls back cleanly; the same
migration on Snowflake may leave a half-created table for the next run to detect. Migrations
should therefore be idempotent (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER`) and versioned,
not just "run once and hope".

## Common mistakes

- Assuming `READ COMMITTED` gives repeatable reads within a transaction. It does not — each
  statement gets a fresh snapshot.
- Using `NOLOCK`/`READ UNCOMMITTED` to "make it faster" and accepting dirty reads as a result.
- Holding a transaction open while calling an external API.
- Catching a deadlock and treating it as fatal instead of retrying.
- Using `SELECT` then `INSERT` to implement "insert if not exists" — a race between the check
  and the write. Use a unique constraint plus `ON CONFLICT`/`MERGE`, and let the database
  arbitrate.

## Production notes

Monitor: PostgreSQL `pg_stat_activity` for long transactions and `pg_locks` for waits; SQL
Server `sys.dm_tran_locks`, `sys.dm_os_waiting_tasks`, and blocking-chain reports; Snowflake
`QUERY_HISTORY` for blocked time and lock waits. Alert on transaction age, not just query
duration — a transaction idle in `idle in transaction` for ten minutes is a bigger incident
than a slow SELECT.
