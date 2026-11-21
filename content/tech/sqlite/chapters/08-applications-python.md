# SQLite in Applications, and When to Leave

The engine is only half the story. The other half is how the application opens it, how many
processes touch it, where transactions begin and end, and whether the deployment model is one
binary on one machine or twenty pods behind a load balancer. Most SQLite incidents are application
architecture mistakes wearing a database error message.

## Python's `sqlite3`, precisely

```python
import sqlite3

db = sqlite3.connect(
    "app.db",
    timeout=5.0,              # busy timeout in seconds
    isolation_level=None,     # no implicit BEGIN; you control transactions
    check_same_thread=True,   # default; keep it unless you serialise access yourself
)
db.row_factory = sqlite3.Row
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA synchronous=NORMAL")
db.execute("PRAGMA foreign_keys=ON")
db.execute("PRAGMA busy_timeout=5000")
```

Four things about the standard library module cause most of the confusion:

**Transaction control is implicit by default.** With the default `isolation_level=""`, the module
opens a transaction before `INSERT`/`UPDATE`/`DELETE` and not before `SELECT` or DDL. Verified:
after `CREATE TABLE`, `Connection.in_transaction` is `False`; after the first `INSERT`, it is
`True`, and a `rollback()` loses the row. That asymmetry means a migration script can half-apply
without a transaction, and a read-modify-write can run outside one. Set `isolation_level=None` and
issue `BEGIN IMMEDIATE` / `COMMIT` yourself, or use the `autocommit` attribute added in 3.12.

**DDL is not transactional in the legacy mode.** Because no transaction is open, each `CREATE
TABLE` commits on its own. Wrap schema changes explicitly.

**`executescript()` commits first.** It issues an implicit `COMMIT` before running the script, so
it cannot be used to compose a larger transaction — a common surprise in migration runners.

**Connections are not thread-safe by contract.** `check_same_thread=False` disables the module's
guard; it does not add locking. It is only safe when the SQLite library is compiled serialized
(`sqlite3.threadsafety == 3`, which is the usual case) and even then it serialises everything on
one connection, which is the opposite of what you wanted.

Defaults worth overriding: `cached_statements=128` is fine; `detect_types` and the default date
adapters are deprecated in 3.12 and should be replaced with explicit ISO strings; and `timeout` is
per connection, so a pool of connections needs the pragma on each.

## Concurrency patterns that work

**One connection per thread, WAL, busy timeout.** The simple version: a connection per request or
per worker thread, `journal_mode=WAL` set once, `busy_timeout` and `synchronous` on every connect,
and `BEGIN IMMEDIATE` for anything that reads before it writes. This handles a handful of threads
and processes well.

**One writer, many readers.** The pattern that scales furthest inside one machine is a dedicated
writer thread owning the only write connection, fed by a `queue.Queue`, while readers open their
own connections (or a small pool). Writes are serialized by design, so making the serialization
explicit removes lock contention and gives you one place to retry, batch and prioritise.

```python
def writer_loop(path, q):
    db = sqlite3.connect(path, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    while (item := q.get()) is not None:
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("INSERT INTO events(kind, payload) VALUES(?, ?)", item)
            db.commit()
        except Exception:
            db.rollback()
            raise
```

**Batch the writes.** A thousand rows in one transaction is roughly three orders of magnitude
faster than a thousand autocommit inserts, because the cost is the commit (fsync), not the insert.
`executemany` inside one transaction is the single biggest performance lever in SQLite.

**Retry the transaction, not the statement.** On `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT`, roll
back, sleep with jitter, and start over. Add an idempotency key if the operation is not naturally
repeatable.

**Do not do I/O inside a transaction.** No HTTP calls, no `await` on a network round trip, no
sleeping. In WAL mode a long read transaction blocks checkpointing; a long write transaction blocks
every other writer. Both are self-inflicted outages.

## Schema and connection settings as code

Pragmas split into two classes, and mixing them up is a common bug:

| Pragmas | Scope |
| --- | --- |
| `journal_mode`, `page_size`, `auto_vacuum`, `user_version` | Persistent, stored in the file |
| `foreign_keys`, `busy_timeout`, `synchronous`, `cache_size`, `temp_store`, `mmap_size` | Per connection |

`journal_mode=WAL` survives reopen; `foreign_keys=ON` does not, and a connection opened by a
migration tool or a BI client will enforce nothing. Put the per-connection set in one function and
call it from every code path that opens the database, including tests.

Read-only access deserves its own treatment. A WAL database still needs to create or open `-shm`
for readers, so a read-only mount fails unless the file is immutable:

```python
db = sqlite3.connect("file:/data/app.db?mode=ro&immutable=1", uri=True)
```

`immutable=1` tells SQLite the file cannot change and to skip locking entirely — correct for a
baked image or a backup on object storage, catastrophic if a writer exists.

## When to move to PostgreSQL

SQLite stops being the right answer at specific, observable points:

| Signal | Why SQLite struggles | What Postgres gives |
| --- | --- | --- |
| More than one machine writes | The file is local; locking is not networked | Client-server access, connection pooling |
| Sustained write concurrency beyond one writer | Serialized commits, `SQLITE_BUSY` under load | Row-level locks, many writers |
| Read replicas or HA failover | No built-in replication (Litestream is DR, not HA) | Streaming replication, Patroni |
| Analytical queries over the same tables | Long reads block checkpoints and compete for cache | Parallel query, better plans, separate replica |
| Rich types: arrays, ranges, `jsonb`, `vector` | Only five storage classes, JSON as text | Native types and extensions |
| Per-user permissions, row-level security | No users, no roles, no GRANT | Roles, RLS, `pg_hba` |
| Online schema change on large tables | `ALTER TABLE` is minimal; rebuilds take a write lock | Concurrent DDL, transactional DDL |
| Hundreds of concurrent connections | One writer, per-connection memory | Connection pool + many backends |

What does *not* justify a move: "it might not scale" without a measurement, a dataset that fits in
one file with one writer, or a desire for a network hop between the app and its data. Plenty of
production systems serve millions of requests a day from a single SQLite file.

When the move is real, the migration is mostly dialect work: `AUTOINCREMENT` becomes `GENERATED ...
AS IDENTITY`, `strftime` becomes `to_char`/`date_trunc`, `group_concat` becomes `string_agg`,
`INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`, `json_extract` becomes `->>`/`jsonb`, integers
become booleans, and `PRAGMA` becomes `SET`. `sqlite3 .dump` does not load into `psql`; use an ORM
that emits portable SQL, or a tool such as pgloader, and run the same test suite against both
engines before cutting over.

## Common mistakes

- Sharing one connection across threads with `check_same_thread=False` and calling it a pool.
- Leaving the default `isolation_level` and assuming DDL and `SELECT` participate in transactions.
- Running `VACUUM` or `integrity_check` from a request handler.
- Opening a second writer process "just for the cron job" on a workload that already has one.
- Blaming SQLite for `database is locked` when the real bug is a transaction held open across a
  network call.
- Migrating to PostgreSQL for concurrency and keeping the single-writer queue architecture, so
  nothing gets faster.
