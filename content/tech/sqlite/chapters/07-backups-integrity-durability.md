# Backups, Integrity Checks and Durability

A SQLite backup is a page-level copy of a file that may be changing under you. That framing
explains both the tools and the failure modes: `cp` is not a backup, a `.db` file without its
`-wal` is not a backup, and a backup you have never restored is a rumour. The good news is that
the engine provides a consistent snapshot mechanism that works while the application is running,
and it is three lines of SQL.

## The three legitimate ways to copy a live database

**1. `VACUUM INTO`** (3.27+) writes a compacted, transactionally consistent copy:

```sql
VACUUM INTO '/backups/app-2026-11-21.db';
```

It takes a read lock for the duration, reads through a stable snapshot, drops free pages and
defragments, so the output is often smaller than the source. It refuses to overwrite an existing
file (`output file already exists`), so timestamped names are mandatory. It copies the `main`
database only — not attached databases — and cannot run inside a transaction.

**2. The backup API**, exposed in Python as `Connection.backup()`:

```python
src = sqlite3.connect("app.db")
dst = sqlite3.connect("/backups/app.db")
with dst:
    src.backup(dst, pages=256, progress=lambda s, r, t: None, sleep=0.05)
dst.close()
```

The C API copies pages in bounded steps, restarting if the source is written during the copy, and
holds only a read lock per step. That makes it suitable for a long-running backup on a busy
database, where `VACUUM INTO` would hold a single long read transaction. `pages` and `sleep` exist
precisely to throttle it.

**3. WAL shipping.** Litestream tails the `-wal` and uploads frames to object storage, giving
point-in-time restore to within seconds; LiteFS does the same over a FUSE filesystem with read
replicas; `sqlite3_rsync` copies only changed pages between two hosts and is restartable. All three
depend on the same fact as the backup API: the WAL is an ordered log of page images, so copying it
in order is a backup.

## Why `cp` is not a backup

In rollback-journal mode, a copy taken mid-commit can contain a mix of old and new pages with no
journal to resolve them. In WAL mode, the main file may be arbitrarily far behind, and the truth is
in `-wal`; copying `.db` alone silently loses recent commits, while copying `.db`, `-wal` and
`-shm` non-atomically can produce a WAL that does not match the header's salt values.

If you must copy files — a stopped application, a container volume snapshot with the process
paused — copy `.db`, `-wal` and `-shm` together, and only after the process has exited cleanly.
The supported path is always `VACUUM INTO` or the backup API.

## Verifying, not hoping

```sql
PRAGMA integrity_check;        -- full: b-tree structure, page linkage, index vs table
PRAGMA integrity_check(10);    -- stop after 10 errors; faster on a broken file
PRAGMA quick_check;            -- skips index-content cross-checks and UNIQUE verification
PRAGMA foreign_key_check;      -- referential violations, independent of the pragma setting
PRAGMA cell_size_check = ON;   -- extra cell-boundary checks on every read
```

`integrity_check` returns a single row `ok` when clean, otherwise up to 100 error strings by
default. Run it on the **backup**, not the production file at peak: it reads the entire database
and holds a read transaction, which in WAL mode prevents checkpointing for its duration.

`quick_check` is meaningfully weaker — it verifies b-tree structure and the freelist but does not
confirm that every index entry points at a matching row. It is the right tool for a startup smoke
test on a large file; `integrity_check` is the one for a restore drill.

A restore drill is more than `integrity_check`:

```sql
PRAGMA user_version;            -- does the schema version match what the app expects?
SELECT count(*) FROM orders;    -- sanity on row count, not proof of recency
SELECT max(created_at) FROM orders;  -- recency check
```

Then actually start the application against the restored file. The most common backup failure is
not corruption; it is a backup that is structurally perfect and three days stale.

## Durability: what `synchronous` actually promises

| Setting | Rollback journal | WAL |
| --- | --- | --- |
| `OFF` (0) | No fsync; corruption possible on power loss | Same |
| `NORMAL` (1) | Syncs the journal before writing, but not the database; a small power-loss corruption window on old filesystems | Syncs only at checkpoint; recent commits can be lost on power loss, **no corruption** |
| `FULL` (2) | fsync journal and database on commit | fsync WAL on every commit; committed means on disk |
| `EXTRA` (3) | FULL plus syncing the directory after the journal is unlinked | Same as FULL; the extra step applies to rollback journals |

The pairing that most production systems use is:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_size_limit = 67108864;
PRAGMA wal_autocheckpoint = 1000;
```

`NORMAL` in WAL mode is durable against application crashes — the WAL is written before the commit
returns — and on power loss it can lose the last few transactions but cannot corrupt the database.
That is a good trade for a web application and a bad one for a ledger; a payments table should run
`FULL`, and should measure the fsync cost rather than assume it.

Two related knobs: `PRAGMA fullfsync = ON` uses `F_FULLFSYNC` on macOS, which is the only way to
get real media sync there; and `PRAGMA checkpoint_fullfsync` applies it to checkpoints.

## Corruption: the causes that are not SQLite's fault

- `synchronous = OFF` combined with a power cut or a kernel panic.
- WAL mode on a network filesystem (NFS, SMB, some container overlays) where shared-memory
  locking is not coherent.
- Two processes opening the same file from different mount namespaces or containers without
  shared locking.
- Copying a live database, then opening the copy.
- Failing disks and lying SSDs — `integrity_check` catches these, which is the argument for
  running it on a schedule against a backup.

## Space, VACUUM and the freelist

A backup is also the moment to reclaim space. `VACUUM` rebuilds the file and needs free disk equal
to its size; `VACUUM INTO` does the same into a new file, which is the better option when you want
to keep the original. For incremental reclamation, `PRAGMA auto_vacuum = INCREMENTAL` (set before
the first table, or enabled by a `VACUUM`) plus `PRAGMA incremental_vacuum(1000)` returns pages a
thousand at a time. On a multi-gigabyte file, `VACUUM` is a maintenance-window operation, not
something to run from a request handler.

## Restoring

1. Stop every writer. Confirm with `lsof app.db` that nothing holds the file.
2. Verify the backup: `integrity_check`, `user_version`, row counts.
3. Move the current file aside (do not delete it yet).
4. Copy the backup into place, and **delete any stale `-wal` and `-shm` files** next to it. A WAL
   from the old database applied to a restored file is a corruption event.
5. Start the app, run a read query, then a write, then check `PRAGMA wal_checkpoint`.
6. Keep the old file until the next successful backup.

## Common mistakes

- Backing up with `cp` while the application is running, then discovering the copy is missing the
  WAL or half a transaction.
- Running `integrity_check` on the live database during peak traffic and calling the latency
  regression a SQLite problem.
- Restoring a `.db` file and leaving the old `-wal` beside it.
- Setting `synchronous = OFF` for benchmark numbers and shipping the same pragma.
- Treating `quick_check` as equivalent to `integrity_check` in a restore drill.
- Owning a backup schedule with no restore schedule.
