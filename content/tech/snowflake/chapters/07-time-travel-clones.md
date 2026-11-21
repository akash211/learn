# Time Travel, Fail-Safe and Zero-Copy Clones

Because storage keeps immutable micro-partitions and only changes which ones a table points at, Snowflake can offer two things a heap-based database cannot do cheaply: query a table as it existed an hour ago, and create a full copy of a multi-terabyte database in seconds. Both are consequences of the same design, and both are bounded by retention settings that are easy to leave at their defaults and then discover during an incident.

## Time travel

Every table, schema and database carries `DATA_RETENTION_TIME_IN_DAYS`. The default is 1 day. On Enterprise edition it can be set up to 90 days per object; on Standard it is 0 or 1. Transient and temporary tables are capped at 1 day regardless of edition.

```sql
ALTER TABLE analytics.events SET DATA_RETENTION_TIME_IN_DAYS = 7;

-- Query the table as it was an hour ago
SELECT count(*) FROM analytics.events AT (OFFSET => -3600);

-- Or at an absolute timestamp
SELECT * FROM analytics.events AT (TIMESTAMP => '2026-03-15 09:00:00'::timestamp_ltz);

-- Or just before a specific statement ran
SELECT * FROM analytics.events BEFORE (STATEMENT => '01b9f2c4-0001-4a2e-0000-000000000000');
```

`AT` includes the state at that moment; `BEFORE` excludes it, which is what you want when you know the statement that broke things. The statement form needs a query id still inside the retention window, and it is the most precise tool available: find the bad `DELETE` in `QUERY_HISTORY`, then reconstruct the table from just before it.

`UNDROP` restores a dropped object:

```sql
UNDROP TABLE analytics.events;
```

It restores the most recently dropped object with that name, with its data, and fails if a new object now holds the name — rename the replacement first. `UNDROP SCHEMA` and `UNDROP DATABASE` work the same way, and undropping a database restores its schemas and tables as they were at the drop.

Retention is a storage cost, not a free feature. The old partitions remain in storage and are billed until they age out, so a 90-day retention on a heavily mutated table keeps a lot of obsolete data. That is a reasonable price for a table that receives `UPDATE`/`DELETE` and an unreasonable one for an append-only fact table that is never corrected.

## Fail-safe

Beyond time travel there is fail-safe: a further 7 days during which Snowflake Support can recover data after a drop or truncate has aged out of retention. It is not configurable, not queryable, and not available to you directly — it exists for disaster recovery, and only for permanent objects. Transient and temporary tables have no fail-safe at all.

The practical reading: a transient table is a table you have decided you can lose. Use transient for staging and reproducible intermediates, never for a table whose loss would require asking support for a restore.

| Object type | Time travel | Fail-safe |
| --- | --- | --- |
| Permanent table | 0–90 days (edition-dependent) | 7 days |
| Transient table | 0–1 day | None |
| Temporary table | 0–1 day | None |
| Clone | Inherits source retention | Inherits source |

## Zero-copy clones

```sql
CREATE TABLE analytics.events_dev CLONE analytics.events;
CREATE DATABASE analytics_snapshot CLONE analytics AT (OFFSET => -86400);
```

A clone is a new set of metadata pointing at the same micro-partitions. No data is copied, so cloning a 10 TB database takes seconds and consumes no additional storage at the moment of creation. From then on, the clone and the source diverge copy-on-write: when either side modifies a partition, it writes a new partition and points at that, leaving the other side's pointer untouched. Storage grows only by the partitions that changed — but at partition granularity, so changing one row in a 200 MB partition adds 200 MB to the divergence.

Two properties surprise people. First, a clone does not inherit grants: it is owned by the role that created it, and privileges granted on the source are not carried over, so a clone handed to a team needs its own grants. Second, not every object clones: streams are not cloned, and a cloned stage points at the same files rather than copying them. A clone is a copy of structure and table data, not of pipeline state.

## Patterns that earn their keep

**A snapshot before a risky migration.** Clone the schema, run the migration against the clone, compare row counts and checksums, then swap or re-run against production with a rollback point that costs nothing until touched.

```sql
CREATE SCHEMA analytics_migrated CLONE analytics;
-- run migration in analytics_migrated
ALTER SCHEMA analytics SWAP WITH analytics_migrated;
```

`SWAP WITH` exchanges the names of two objects of the same type atomically, which is the cleanest blue/green publish in the platform: consumers keep querying `analytics` and see the new contents with no window where the schema is missing.

**Recovering a subset rather than the whole table.** After a bad `UPDATE`, don't restore 400 million rows. Clone at the offset, copy the affected rows back, drop the clone:

```sql
CREATE TABLE analytics.events_fix CLONE analytics.events AT (OFFSET => -7200);
UPDATE analytics.events t
SET status = f.status
FROM analytics.events_fix f
WHERE t.event_id = f.event_id AND t.status <> f.status;
DROP TABLE analytics.events_fix;
```

**Per-tenant or per-environment copies.** Cloning a database for a new tenant or a training environment is instant, and the clone is isolated the moment it is written to. This is how teams give analysts a full-size dataset without a second storage bill.

## What clones do not protect against

A clone taken *after* the damage contains the damage. The recovery point is only as good as the retention setting on the source, and a `TRUNCATE` on a transient table with one-day retention has a one-day window and no fail-safe behind it. Check the retention on the tables that matter before the incident, not during it.

Clones also do not isolate performance. A clone shares storage, and its queries run on whatever warehouse they are pointed at; two teams hammering the same underlying partitions from different warehouses are still hitting the same object storage.

## Common mistakes

- Assuming time travel is 90 days for everyone. It is edition- and object-dependent, and one day by default.
- Creating transient tables for production facts "to save storage", then discovering there is no fail-safe behind them.
- Cloning a database and handing it to a team without grants, then treating the empty access as a bug.
- Using `UNDROP` while a replacement object holds the name.
- Believing a clone doubles storage cost. It does not, until the two sides diverge — and then only by changed partitions.
- Running `INSERT OVERWRITE` on a huge table to "reset" it, which rewrites every partition and doubles storage until time travel expires.

## Production notes

Set retention per table class, not per account: 1 day for append-only facts, 7–30 for dimensions and anything with human `UPDATE` traffic. Document the recovery procedure — find the query id, clone at the offset, diff, repair — and rehearse it once on a non-production table, because the first time anyone runs it should not be at 02:00 during an incident. And remember that clones count against storage as they diverge: a forgotten `_dev` clone that receives a full nightly load every night is a second copy of the warehouse.
