# Database Migrations in Pipelines

Application code and database schema are two deployments that cannot be atomic. During a rolling
update, old and new code run simultaneously against one schema; during a rollback, old code runs
against a schema the new code created. Almost every "zero-downtime deploy" incident is really a
schema change that assumed otherwise.

## The constraint

Take a rolling update with `maxUnavailable: 0`. For a few minutes, N-1 pods run version A and one
runs version B, all against the same database. The schema must therefore satisfy both:

- Version A must still work — so nothing A reads or writes may be removed or renamed.
- Version B must work — so anything new must exist before B starts.

That is the whole problem, and it has one standard solution: split every change into steps that
are individually compatible with both versions, and spread them across releases.

## Expand and contract

Three phases, usually across three deploys.

**Phase 1 — expand.** Add the new structure without touching the old. Nullable column, new table,
new index, new enum value. Old code ignores it; new code writes to it but still writes the old
path too.

```sql
ALTER TABLE orders ADD COLUMN customer_ref text;
CREATE INDEX CONCURRENTLY idx_orders_customer_ref ON orders (customer_ref);
```

**Phase 2 — migrate and dual-write.** Backfill existing rows in batches, and have the new code
write both representations while reading the new one with a fallback to the old. When the backfill
is complete and verified, reads can switch entirely.

**Phase 3 — contract.** Once no running version reads the old structure, remove it. This is a
*separate release*, after the code that used it is gone:

```sql
ALTER TABLE orders DROP COLUMN customer_id;
```

The discipline is that destructive statements never ship in the same release as the code that
stops using the thing. A rollback of the code after a destructive migration is impossible, and
that is exactly when someone wants it.

## Renames are three changes, not one

`ALTER TABLE ... RENAME COLUMN` is instant and breaks every running instance at once. The safe
sequence is: add the new column, dual-write, backfill, switch reads, stop writing the old column,
drop it in a later release. Four deploys for something that looks like a one-line change — which is
why the honest answer to "can we rename this column" is "yes, over two weeks".

The same applies to table renames, splitting a column into two, and changing a type
(`text` → `uuid`, `int` → `bigint`). In each case the expand/contract pattern is the only thing
that survives a rolling deploy.

## Locks, and the queue behind them

In Postgres, DDL takes a lock, and locks queue. The dangerous pattern is not a slow `ALTER`; it is a
fast `ALTER` that waits behind a long-running transaction while every subsequent query queues
behind *it*. The service appears to hang, and the cause is a migration that would have taken
milliseconds.

Two defences: set a `lock_timeout` so the migration fails fast rather than blocking the table, and
run destructive or locking DDL outside peak hours regardless.

```sql
SET lock_timeout = '3s';
SET statement_timeout = '30s';
ALTER TABLE orders ADD COLUMN customer_ref text;
```

Statements worth knowing for zero-downtime work, all Postgres-specific but the pattern transfers:

| Change | Safe form | Notes |
|---|---|---|
| Add nullable column | `ADD COLUMN … NULL` | Metadata-only |
| Add column with default | `ADD COLUMN … DEFAULT x` | Metadata-only since PG 11 for non-volatile defaults |
| Add NOT NULL | `CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT` | `VALIDATE` takes a light lock, no full-table write block |
| Create index | `CREATE INDEX CONCURRENTLY` | Cannot run inside a transaction block |
| Change type | New column + backfill + swap | `ALTER TYPE` rewrites the table |
| Drop column | Deferred release | Irreversible for old code |

`CREATE INDEX CONCURRENTLY` is the one people get wrong: it cannot run in a transaction, it can
leave an invalid index behind if it fails, and it takes longer. A migration tool that wraps every
migration in a transaction needs a per-migration opt-out.

## Backfills

A backfill is a data migration, and it should be a job rather than a migration step:

- Batched (`WHERE id BETWEEN … LIMIT 1000` or keyset pagination), never one `UPDATE` over millions
  of rows — a single statement holds locks and bloats the table.
- Throttled, with a sleep or a rate limit, so replication lag and I/O stay acceptable.
- Idempotent, so a re-run after a failure resumes rather than double-applying.
- Observable, emitting progress so a stuck backfill is visible before it becomes an incident.
- Resumable, with the cursor stored somewhere durable.

```sql
UPDATE orders SET customer_ref = legacy_ref
WHERE id IN (
  SELECT id FROM orders WHERE customer_ref IS NULL ORDER BY id LIMIT 1000
);
```

Run the backfill as a separate pipeline stage or a scheduled job after the expand deploy — not
inside the migration that adds the column, where it will hold a transaction for an hour.

## Who runs the migration

Not the application, at least not from every replica. If migrations run on startup, ten replicas
race, and the winner is arbitrary; with a migration tool that does not take an advisory lock, the
result is partial schema and a crash loop. The workable options:

- **A dedicated migration job** in the pipeline, running once before the new version rolls out.
  Simple, observable, and the ordering is explicit.
- **An init container or a Job** in Kubernetes, with the app gated on its completion. Works, but
  needs care so a failed migration blocks the rollout rather than crash-looping.
- **Application startup with an advisory lock** (`pg_advisory_lock`), so only one instance migrates
  and the rest wait. Convenient for small deployments; couples schema to app lifecycle.

Whichever you choose, the pipeline must fail the deploy if the migration fails, and must not
proceed to roll out code that requires the new schema.

## Compatibility order

The safe sequence for a release with both code and schema changes: expand migration, then the new
code (which tolerates both shapes), then the backfill, then verification, then a later release that
contracts and deletes the compatibility code. The reverse — deploy code that needs a column, then
add it — produces a window where every request fails, and it is the most common cause of a
"successful" deploy that takes the service down.

## Rollback is a code operation

Down migrations look like safety and usually are not. A `downgrade()` that drops the column the
previous version needs will destroy data, and one that "restores" a dropped column restores the
shape, not the values. In practice:

- Roll back the **code** to the previous digest; the schema stays where it is.
- Make every schema change compatible with the previous code for at least one release, which is
  what expand/contract buys you.
- Treat destructive changes as one-way doors: back up, gate them, and wait until the release is
  proven.
- For data corruption, restore is a separate, rehearsed procedure — not a migration.

A useful rule: if a migration cannot be deployed while the previous application version is running,
it does not belong in the same window as that version's deploy.

## Testing migrations

A migration tested only on an empty database has not been tested. On a copy of production-shaped
data it will reveal the things that matter:

- How long the `ALTER` takes to acquire its lock, under concurrent load.
- Whether an index build fits in `maintenance_work_mem` or spills.
- Whether the backfill query uses the index or sequentially scans.
- Whether `NOT NULL` validation succeeds, i.e. whether any row violates it.

```bash
pg_dump --schema-only "$PROD_REPLICA" | psql "$TEST_DB"
psql "$TEST_DB" -c '\timing on' -f migrations/0042_add_customer_ref.sql
```

Run it against a restored snapshot with realistic row counts, and measure. A table with a thousand
rows tells you nothing about a table with fifty million. Tools like Atlas and Squawk lint migrations
for locking behaviour statically, which catches the obvious cases before they reach a rehearsal.

## Common mistakes

- `NOT NULL` added in the same release as the code that populates the column.
- `CREATE INDEX` without `CONCURRENTLY` on a large, live table.
- Migrations running on application startup across many replicas.
- A backfill in a single `UPDATE`, holding locks for minutes.
- A down migration that drops data, relied on as the rollback plan.
- Applying migrations to staging and production from different tool versions, so checksums and
  order diverge.
- Dropping a column in the same release that stops writing it.

## Production notes

Version the migration set with the same rigour as code: checksums, a schema history table, and a
rule that an applied migration is never edited. Keep "schema migrations" (fast, transactional,
reversible-ish) separate from "data migrations" (slow, batched, idempotent, run as jobs). And have
a documented procedure for the case where a migration has already run and the code is being rolled
back — the answer is almost always "roll back code only, fix forward", and writing it down before
the incident is what makes it possible.
