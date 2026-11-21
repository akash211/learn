# Transactions, Locking and WAL Concurrency

SQLite's concurrency model is small enough to hold in your head: **many readers, one writer, no
server to arbitrate**. There is no lock manager process, no row locks, no deadlock detector. Locks
are bytes in the database file (or in the `-shm` file in WAL mode) taken with POSIX advisory
locks, and the isolation guarantee is serializable because there is only ever one writer. Every
"database is locked" incident is one of four or five patterns, and each has a specific fix.

## The transaction surface

```sql
BEGIN;                 -- DEFERRED by default
BEGIN IMMEDIATE;       -- take the write lock now
BEGIN EXCLUSIVE;       -- take it now and keep readers out (rollback mode)
COMMIT;
ROLLBACK;
SAVEPOINT sp1;
ROLLBACK TO sp1;
RELEASE sp1;
```

Outside a `BEGIN`, every statement is its own transaction — autocommit. `BEGIN DEFERRED` takes no
lock at all until the first statement: a `SELECT` takes a shared lock, a write takes a reserved
lock. That laziness is the source of the classic upgrade failure described below. `SAVEPOINT`
works inside or outside a transaction and is the correct tool for nested logic in application
code: `RELEASE` of the outermost savepoint commits, and `ROLLBACK TO` undoes only the inner work.

## Rollback journal locking, in four states

| State | Held by | Blocks |
| --- | --- | --- |
| SHARED | Readers | A writer's transition to EXCLUSIVE |
| RESERVED | One writer, still reading | Other writers (they get `SQLITE_BUSY`) |
| PENDING | Writer ready to commit | New SHARED locks |
| EXCLUSIVE | Writer committing | Everything |

A writer can hold RESERVED while readers hold SHARED, which is why writes and reads overlap for
most of a transaction. The problem is the last step: to copy pages back into the database, the
writer needs EXCLUSIVE, which means waiting for every reader to finish. In a read-heavy rollback
database a long `SELECT` therefore stalls commits, and a commit waiting for EXCLUSIVE blocks all
new readers behind it.

## WAL: readers and the writer stop blocking each other

WAL mode changes the shape completely. New pages are appended to the log, so the writer never
needs to overwrite pages a reader is using. Readers take a snapshot — the last committed frame at
the moment their read transaction starts — and keep reading that version while the writer appends.

- Readers do not block the writer, and the writer does not block readers. Verified in one line:
  a `SELECT` inside an open transaction still returns the old count while another connection
  commits an insert.
- There is still exactly **one writer**. A second `BEGIN IMMEDIATE` gets `SQLITE_BUSY` and waits,
  or fails if the busy timeout expires.
- Checkpoints copy WAL frames back into the database. A checkpoint cannot overwrite a page that
  some reader's snapshot still needs, so long-lived readers cause the WAL to grow, not to corrupt.
- The `-shm` file is shared memory holding the wal-index. It is why WAL does not work on network
  filesystems: the locking and mmap semantics SQLite relies on are not reliable over NFS or SMB.

```sql
PRAGMA journal_mode = WAL;         -- persistent, survives reopen
PRAGMA synchronous = NORMAL;       -- the usual production pairing
PRAGMA busy_timeout = 5000;        -- milliseconds, per connection
PRAGMA wal_autocheckpoint = 1000;  -- pages, default
PRAGMA journal_size_limit = 67108864;  -- cap WAL after checkpoint (64 MB)
```

## The upgrade problem, and why BEGIN IMMEDIATE exists

Consider the read-modify-write that every application has:

```sql
BEGIN;                                   -- deferred
SELECT balance FROM accounts WHERE id = 1;   -- takes a read snapshot
-- application decides to subtract 100
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

If another connection commits between the `SELECT` and the `UPDATE`, this connection's snapshot is
stale. SQLite cannot let it write, because doing so would mix two snapshots. It returns
`SQLITE_BUSY_SNAPSHOT` immediately — the busy handler is **not** invoked, so `busy_timeout` does
not help. The transaction must be rolled back and retried from the beginning. The fix is to take
the write lock before reading:

```sql
BEGIN IMMEDIATE;
SELECT balance FROM accounts WHERE id = 1;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

Now the second writer waits at `BEGIN IMMEDIATE` (subject to `busy_timeout`) instead of failing
mid-transaction. Any read-then-write sequence — counter increments, queue claims, balance
transfers, "insert if not exists" — belongs in `BEGIN IMMEDIATE`. Pure read transactions can stay
deferred.

Rollback mode has an equivalent deadlock: two connections each hold SHARED, both try to upgrade to
RESERVED, and neither can proceed. SQLite detects this and returns `SQLITE_BUSY` without calling
the busy handler, because waiting cannot help. `BEGIN IMMEDIATE` avoids it for the same reason.

## Isolation, precisely

SQLite is serializable. In WAL mode a read transaction sees a consistent snapshot taken at its
first read and holds it until it ends; in rollback mode a read transaction holds SHARED and no
writer can commit underneath it. There is no `READ COMMITTED` mode where each statement sees newer
data, and no snapshot older than the start of your transaction. `PRAGMA read_uncommitted` exists
but only affects shared-cache mode, which is deprecated for good reasons.

Two practical consequences:

1. A read transaction that stays open across user think-time or a network call pins the snapshot
   and prevents checkpointing. Keep read transactions to one query, or accept a growing WAL.
2. Since writes are serialized anyway, batching is not a tradeoff — it is strictly better. A
   thousand inserts in one transaction costs one commit; a thousand autocommit inserts cost a
   thousand.

## Busy handling and retries

`PRAGMA busy_timeout` installs a handler that sleeps and retries for that many milliseconds when a
lock is contended. It does not cover `SQLITE_BUSY_SNAPSHOT`, and it does not cover deadlock
detection. Outside those two cases it turns most contention into latency rather than errors.

The retry pattern that works:

```python
for attempt in range(5):
    try:
        db.execute("BEGIN IMMEDIATE")
        ...
        db.commit()
        break
    except sqlite3.OperationalError as exc:
        db.rollback()
        if "locked" not in str(exc) and "busy" not in str(exc):
            raise
        time.sleep((0.05 * 2 ** attempt) + random.random() * 0.05)
```

Retry the *whole* transaction, not the failed statement. Back off with jitter so that ten workers
do not retry in lockstep. And make the transaction idempotent where possible, because a commit may
have succeeded on the server side of a timeout even when the client saw an error.

## Production notes

- Keep write transactions short and free of I/O: no HTTP calls, no file writes, no `sleep` inside
  `BEGIN IMMEDIATE`.
- In WAL mode, `synchronous=NORMAL` is durable against application crashes and loses at most the
  most recent commits on power loss — it cannot corrupt the database. `FULL` adds an fsync per
  commit and is the right choice for a ledger.
- A checkpoint that cannot run is not an error; it is a WAL that grows. Alert on `-wal` file size,
  not on checkpoint completion. `PRAGMA wal_checkpoint(TRUNCATE)` on clean shutdown keeps things
  tidy.
- `PRAGMA locking_mode=EXCLUSIVE` is for single-process access (embedded, removable media). It
  removes per-transaction lock traffic but makes the file unshareable; never enable it in a
  multi-process service.

## Common mistakes

- Using plain `BEGIN` for read-modify-write and treating `SQLITE_BUSY_SNAPSHOT` as a transient
  error to retry the `UPDATE`.
- Holding a read transaction open while rendering a page or awaiting a network response.
- Setting `busy_timeout` to 30 seconds to "make locks go away", which converts contention into
  latency and thread-pool exhaustion.
- Believing WAL allows concurrent writers. It allows concurrent readers; writers are still one at
  a time.
- Running WAL mode on a network share, then blaming SQLite for corruption.
