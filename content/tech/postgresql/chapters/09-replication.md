# Replication — Streaming, Logical, and Slots

PostgreSQL replicates by shipping its write-ahead log. Everything else is a policy decision about
who reads that log, how much of it is retained, and whether the subscriber interprets it as
physical pages or as row changes. The two mechanisms answer different questions, and the
operational failure modes — WAL filling a disk, a replica replaying past a query, a logical slot
that nobody is consuming — are where the incidents come from.

## WAL in one paragraph

Every change is written to `pg_wal` before the data page is modified (write-ahead). Segments are
16 MB. `wal_level` decides how much detail is logged and therefore what is possible:

| `wal_level` | Enables |
| --- | --- |
| `minimal` | crash recovery only; no replication, no archiving useful for PITR |
| `replica` (default) | physical streaming replication, base backups, PITR |
| `logical` | everything above plus logical decoding (publications, CDC, Debezium) |

`max_wal_senders` (default 10) caps concurrent streaming connections; `max_replication_slots`
(default 10) caps slots. Both require a restart to change, and running out of senders is a silent
failure: the replica simply retries and falls behind.

## Physical streaming replication

The standby connects, receives WAL from the current point, and replays it continuously. It is a
byte-for-byte copy of the cluster: same major version, same architecture, all databases, all roles.

```bash
pg_basebackup -h primary -U replicator -D /var/lib/postgresql/17/main \
  -Fp -Xs -P -R
```

- `-X stream` includes the WAL needed to make the backup consistent; without it the backup is not
  self-sufficient.
- `-R` writes `standby.signal` and a `primary_conninfo` into `postgresql.auto.conf`, which is the
  difference between a copy and a replica.
- `-Fp` (plain) is resumable-ish and simple; `-Ft` (tar) suits object storage pipelines.

The standby is read-only and can serve queries (`hot_standby = on`, default). Those queries
conflict with WAL replay: replaying a `VACUUM` that removes rows a long query can still see causes
the query to be cancelled with `canceling statement due to conflict with recovery`.

Two controls, pulling in opposite directions:

- `max_standby_streaming_delay` (default 30 s) — how long replay waits for a query before
  cancelling it. Raising it protects reports and increases lag.
- `hot_standby_feedback = on` — the standby tells the primary its oldest snapshot, so vacuum on the
  primary does not remove rows the replica still needs. This eliminates most conflicts and causes
  **bloat on the primary**, because a long report on the replica now holds back vacuum there.

Choosing between them is a statement about which workload you care about. A reporting replica with
long queries wants both raised; a failover standby wants neither.

## Synchronous replication

By default replication is asynchronous: a commit returns when the local WAL is flushed, and a
primary crash can lose the last few hundred milliseconds. `synchronous_commit` and
`synchronous_standby_names` change that:

```ini
synchronous_standby_names = 'ANY 1 (pg2, pg3)'
synchronous_commit = on
```

| `synchronous_commit` | Waits for |
| --- | --- |
| `off` | local WAL write, not flush (loss window up to ~3× `wal_writer_delay`) |
| `local` | local flush only |
| `on` | local flush + standby flush |
| `remote_write` | local flush + standby received |
| `remote_apply` | local flush + standby replayed and visible to its readers |

Use `ANY 1 (...)` (quorum) rather than `FIRST 1 (...)`: with `FIRST`, the named standby is required
and its failure stalls every commit. Quorum degrades to the surviving member. Even so, synchronous
replication with a single standby converts a standby outage into a write outage unless the
application can tolerate it — many teams run `synchronous_commit = local` plus a measured RPO
instead.

## Replication slots

A slot is a promise: "I will keep the WAL this consumer has not confirmed." Physical slots keep
WAL for a standby that is temporarily down; logical slots keep WAL for a subscriber.

```sql
SELECT slot_name, slot_type, active, restart_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

The failure mode is severe and common: a decommissioned replica or a paused subscriber leaves an
inactive slot, the primary retains WAL forever, `pg_wal` fills the disk, and the primary stops
accepting writes. Nothing in the logs says "slot" until the disk is full.

```ini
max_slot_wal_keep_size = '20GB'
```

That setting makes PostgreSQL invalidate a slot that falls further behind than the limit
(`wal_status` becomes `lost`) instead of filling the disk. It converts an outage into a broken
replica, which is the correct trade every time. Alert on retained bytes per slot, not on slot
existence.

## Logical replication

Logical decoding turns WAL into row-level changes, which a subscriber applies as ordinary SQL. It
is version-independent (a 17 subscriber can consume a 14 publisher), selective (one table, not one
cluster), and writable on the subscriber.

```sql
-- publisher, wal_level = logical
CREATE PUBLICATION orders_pub
  FOR TABLE orders, order_items
  WHERE (created_at >= '2025-01-01');

-- subscriber
CREATE SUBSCRIPTION orders_sub
  CONNECTION 'host=pub dbname=app user=repl password=...'
  PUBLICATION orders_pub
  WITH (copy_data = true, binary = true, streaming = parallel);
```

What it does and does not do:

| Replicated | Not replicated |
| --- | --- |
| `INSERT`, `UPDATE`, `DELETE` | DDL (`CREATE TABLE`, `ALTER`) |
| `TRUNCATE` (11+) | sequences (identity/serial values) |
| Row filters and column lists (15+) | large objects |
| Initial table copy (`copy_data`) | indexes, constraints (created separately) |

For `UPDATE` and `DELETE` the publisher needs a **replica identity** — the primary key by default.
A table without one requires `REPLICA IDENTITY FULL`, which logs the entire old row for every
change and is dramatically more expensive. Add a primary key before publishing a table.

Row filters (15+) are the reason logical replication became practical for analytics: publish the
EU rows, or only the columns the warehouse needs, and skip the rest of the WAL processing. Column
lists reduce bandwidth and subscriber storage; they do not reduce publisher WAL volume.

Parallel apply (16+) applies independent transactions with up to
`max_parallel_apply_workers_per_subscription` workers (default 2), which matters for a subscriber
catching up after a bulk load. On the publisher side, 16 also allows logical decoding **from a
standby**, so the primary's CPU is not spent decoding.

Slots are essential here and dangerous in the same way: a subscription's slot retains WAL until the
subscriber confirms. Dropping a subscription without dropping the slot (`DROP SUBSCRIPTION` tries,
and fails if the publisher is unreachable) leaves WAL accumulating.

PostgreSQL 17 addressed the HA gap: logical slots can be synchronized to standbys
(`sync_replication_slots = on`, `pg_sync_replication_slots()`), so a failover does not lose the
subscriber's position. Before 17 a logical slot existed only on the primary, and a promotion
required recreating it — with a fresh initial copy or a manual LSN.

## Monitoring

```sql
SELECT application_name, state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS lag_bytes,
       write_lag, flush_lag, replay_lag, sync_state
FROM pg_stat_replication;
```

Measure lag in **bytes and seconds**, not just one: a replica that has received everything
(`sent_lsn` current) but not replayed is a lagging replica for readers. On the subscriber,
`pg_stat_subscription` shows `last_msg_send_time` and any apply error; since 15,
`pg_stat_subscription_stats` counts apply errors, sync errors and (17+) conflicts, which is where a
constraint violation on the subscriber shows up.

## Choosing

- **Failover / read scaling on identical data** → physical streaming, synchronous if the RPO
  demands it, plus a slot with `max_slot_wal_keep_size` set.
- **Selective tables, cross-version, CDC into a warehouse, zero-downtime major upgrade** → logical
  replication.
- **Both** is normal: a physical standby for HA and a logical subscriber for analytics.

## Common mistakes

- Creating a slot and never monitoring retained WAL.
- `synchronous_standby_names = 'FIRST 1 (only_replica)'` and calling the resulting write outage a
  database bug.
- Assuming logical replication carries DDL, so schema changes stay in sync automatically.
- Publishing a table with no primary key, then wondering why WAL volume tripled.
- Setting `hot_standby_feedback = on` on a reporting replica and blaming the primary for bloat.
