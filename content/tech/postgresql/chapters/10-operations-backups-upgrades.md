# Operations — Backups, PITR, Monitoring, Upgrades

The difference between a database that is operated and one that is merely running is a set of
answers written down in advance: what is the recovery point objective, when was the last restore
tested, what does the alert mean, and how does a major version change happen without a maintenance
window. This chapter is those answers for PostgreSQL.

## Two kinds of backup, for two different jobs

**Logical** (`pg_dump`) exports SQL or a custom-format archive. It is version-independent, allows
selective restore of one table, and is the right tool for migrating a small database or moving
between architectures.

```bash
pg_dump -Fc -Z zstd -j 8 -f app.dump appdb
pg_restore -d appdb_new -j 8 --no-owner --exit-on-error app.dump
pg_dumpall --globals-only -f globals.sql
```

It is **not** a disaster-recovery strategy for a large database: the dump takes hours and gives you
the state at the moment it started, not a continuous recovery window.

**Physical** copies the data directory plus enough WAL to make it consistent. This is the basis of
PITR. `pg_basebackup` does it over the replication protocol:

```bash
pg_basebackup -h primary -D /backup/base -Ft -z -Xs -P --checkpoint=fast
```

Version 17 added **incremental base backups**, which is the most significant backup change in
years: `pg_basebackup --incremental=/backup/incr1 --incremental-base=...` captures only changed
blocks, and `pg_combinebackup` assembles a full backup from the chain. For a 2 TB database with 5%
daily churn, that turns a nightly 2 TB copy into a 100 GB one. The chain must be complete — an
incremental backup is not independently restorable.

Managed services usually replace this with a control-plane API; the underlying requirement does
not change: a base backup plus a continuous WAL archive, in a different failure domain from the
primary.

## PITR in practice

Continuous archiving requires `archive_mode = on` and a command that pushes each completed segment
somewhere durable:

```ini
archive_mode = on
archive_command = 'pgbackrest --stanza=main archive-push %p'
archive_timeout = 60s          # force a switch so the loss window is bounded
wal_level = replica
```

`archive_timeout` is the setting that defines your real RPO: with a 60-second timeout, a crash can
lose up to 60 seconds of commits even though `synchronous_commit = on`. Without it, a quiet
database might not archive for hours.

Restore is base backup, then:

```ini
restore_command = 'pgbackrest --stanza=main archive-get %f %p'
recovery_target_time = '2026-11-20 14:32:00+00'
recovery_target_action = 'promote'
```

plus an empty `recovery.signal` file. `recovery_target_xid`, `_lsn` and `_name` (with
`recovery_target_name` set via `pg_create_restore_point`) are the alternatives; the last is the one
to use before a risky migration — name a point, then you can return to it exactly.

Two traps. First, the target time is in the server's `TimeZone` unless you specify an offset; a
"14:32" restore that lands at 14:32 UTC on a Europe/Berlin server is four hours off. Second,
recovery replays to the *end of the target*, which for `recovery_target_time` means the last commit
before it — if the bad transaction is at 14:32:00 and you target 14:32:00, you may or may not
include it depending on commit timestamp resolution. Target a minute earlier and reconcile.

**Test the restore.** A backup that has never been restored is a hypothesis. A monthly restore into
a scratch instance, with a row count and a checksum comparison against the primary, is the only
evidence that the archive is complete and the runbook is correct.

## WAL, checkpoints and disk

| Setting | Default | Effect |
| --- | --- | --- |
| `max_wal_size` | 1 GB | WAL allowed to accumulate between checkpoints |
| `min_wal_size` | 80 MB | WAL kept for reuse rather than deleted |
| `checkpoint_timeout` | 5 min | Maximum time between checkpoints |
| `checkpoint_completion_target` | 0.9 | Spread write-back over 90% of the interval |
| `wal_compression` | off | `lz4`/`zstd` (15+) shrinks full-page writes |
| `full_page_writes` | on | Required for crash safety after a torn page |

A spike in `pg_stat_bgwriter`'s `buffers_backend` — removed in 17, where `pg_stat_io` reports the
same work as writebacks from client backends — means backends are evicting dirty pages themselves
because checkpoints are not keeping up. The classic cause is `max_wal_size` too small for the write
rate, which forces checkpoints far more often than `checkpoint_timeout`. Raising `max_wal_size`
reduces checkpoint frequency and total I/O, at the cost of a longer crash recovery.

Watch `pg_wal` directory size against disk. WAL grows from write volume, from an archiver that
cannot keep up (`pg_stat_archiver.failed_count` rising), and from replication slots. Those are three
different alerts that all look like "disk full" on a dashboard.

## What to monitor

| Signal | Source | Why it matters |
| --- | --- | --- |
| Transaction age | `max(now() - xact_start)` in `pg_stat_activity` | Holds the xmin horizon; blocks vacuum |
| Dead tuples / last autovacuum | `pg_stat_user_tables` | Bloat before it becomes latency |
| XID age | `age(datfrozenxid)` per database | Wraparound; alert at 1.5 B |
| Replication lag | `pg_stat_replication` bytes and seconds | Failover readiness and read staleness |
| Retained WAL per slot | `pg_replication_slots` + `pg_wal_lsn_diff` | Disk exhaustion |
| Cache hit ratio | `pg_stat_database.blks_hit` | Working set no longer fits |
| Temp files | `pg_stat_database.temp_bytes`, `log_temp_files` | `work_mem` too small for real queries |
| Locks waiting | `pg_locks`, `pg_blocking_pids()` | Contention, blocked DDL |
| Checkpoint pressure | `pg_stat_bgwriter`, `pg_stat_io` (16+) | I/O spikes |
| Slow queries | `pg_stat_statements`, `auto_explain` | Regressions per query, not per database |

`log_min_duration_statement = '500ms'`, `log_checkpoints = on`,
`log_autovacuum_min_duration = '10s'`, `log_lock_waits = on` and
`log_temp_files = 0` are the logging settings that make an incident reconstructable after the fact.

## Major version upgrades

Three routes:

**1. Dump and restore.** Version-independent, works across architectures, and takes time proportional
to database size. Fine up to tens of GB, or when the schema needs cleanup anyway.

**2. `pg_upgrade`.** In-place: it creates the new cluster's catalogs from the old cluster's
definition and either copies or hard-links the relation files.

```bash
/usr/lib/postgresql/17/bin/pg_upgrade \
  --old-datadir=/var/lib/postgresql/16/main --new-datadir=/var/lib/postgresql/17/main \
  --old-bindir=/usr/lib/postgresql/16/bin --new-bindir=/usr/lib/postgresql/17/bin \
  --check
```

`--check` first, every time. `--link` is fast (minutes even for a terabyte) but destroys the old
cluster as it goes, so it removes your rollback path; without `--link` you need disk for two full
copies. `--jobs` parallelises the copy.

Before any upgrade, inventory the risk:

```sql
SELECT extname, extversion FROM pg_extension ORDER BY 1;
SELECT datname, datcollate, datlocprovider, datcollversion FROM pg_database;
```

Extensions must have a build for the new major version; an extension without one blocks the
upgrade entirely. A change in the collation provider or its version (a glibc upgrade, an ICU
change) silently changes sort order, which invalidates indexes built on text columns — the upgrade
does not fix that, and queries start returning wrong results. Plan a `REINDEX` after any collation
version change, and check `pg_database.datlocversion` afterwards.

**3. Logical replication.** Stand up the new version beside the old, subscribe, let it catch up,
then switch over in seconds. No DDL is replicated, so the schema must be created identically on the
target and any `ALTER` during the catch-up must be applied by hand. Sequences are not replicated,
so set them from `max(id)` before cutover. PostgreSQL 17 added `pg_createsubscriber`, which inverts
the usual flow: it takes a physical replica of the old cluster and converts it into a logical
subscriber, which makes the "upgrade with a replica" pattern practical without hand-built
publications.

After any upgrade: run `ANALYZE`, verify `pg_stat_statements` is reset and capturing, compare the
top ten query plans before and after, and keep the old cluster (or its backup) for a defined
rollback window rather than deleting it in the same change window.

## Runbook checklist

- Restore drill monthly, timed, with the result written down.
- Failover drill quarterly, including the client reconnection path.
- Publish the alert thresholds and what each one means, not just the dashboard.
- Keep `pg_stat_statements` history across deploys so "it got slower" has a before.

## Common mistakes

- Treating `pg_dump` as a PITR strategy.
- `archive_command` that silently fails; `pg_stat_archiver.failed_count` is the alarm, and
  `archive_mode` keeps retrying rather than switching to a fallback.
- Running `pg_upgrade` without `--check`, discovering the missing extension at 02:00.
- Deleting the old cluster in the same change window as the upgrade.
- Monitoring CPU and disk but not transaction age, then being surprised by wraparound warnings.
