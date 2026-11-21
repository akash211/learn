# Vacuum, Autovacuum, Bloat and Freezing

Vacuum has three jobs, and confusing them is why tuning attempts fail: it **reclaims dead tuple
space for reuse**, it **updates statistics** (via `ANALYZE`), and it **advances the transaction ID
horizon** by freezing old tuples. Each has a different trigger, a different cost, and a different
failure mode.

## What plain VACUUM does and does not do

`VACUUM orders;` scans the heap, records dead tuple line pointers as free space, prunes dead
index entries, and marks pages all-visible in the visibility map when no dead tuples remain. It
takes only `SHARE UPDATE EXCLUSIVE` on the table, so reads and writes continue.

It does not shrink the file. Freed space is reused by later inserts and updates, which is fine
for a steady-state table and useless for one that had a single 90% delete. It will truncate pages
that are entirely free at the end of the file (12+ lets you disable that with
`VACUUM (TRUNCATE off)`), which recovers space only when the dead rows happen to be at the end.

`VACUUM FULL` is a different operation: it rewrites the entire table into a new file, takes
`ACCESS EXCLUSIVE` (blocking everything), and needs free disk roughly equal to the table size.
For a 500 GB table that is an outage, not maintenance.

| Operation | Lock | Rewrites | Returns disk | Blocks writes |
| --- | --- | --- | --- | --- |
| `VACUUM` | `SHARE UPDATE EXCLUSIVE` | no | trailing pages only | no |
| `VACUUM FULL` | `ACCESS EXCLUSIVE` | yes | yes | yes |
| `pg_repack` | brief `ACCESS EXCLUSIVE` at start/end | yes (online) | yes | ~no |
| `CLUSTER` | `ACCESS EXCLUSIVE` | yes | yes | yes |

## Autovacuum's trigger arithmetic

Autovacuum launches a worker for a table when dead tuples exceed:

```
autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * reltuples
```

With the defaults (50 and 0.2), a 500-million-row table needs **100 million dead tuples** before a
worker shows up. By then the table is a third dead, every sequential scan reads three times the
pages it should, and the vacuum that finally runs takes hours. The default is calibrated for
small tables and is the most common cause of "PostgreSQL got slow and nobody changed anything".

The per-table fix is a storage parameter, applied without a restart:

```sql
ALTER TABLE events SET (
  autovacuum_vacuum_scale_factor  = 0.01,   -- 1% dead, not 20%
  autovacuum_vacuum_threshold     = 5000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 10000   -- 13+: vacuum insert-only tables too
);
```

`autovacuum_vacuum_insert_threshold` matters for append-only tables with no updates: without it,
nothing triggers a vacuum and the visibility map never gets set, so index-only scans fall back to
heap fetches forever.

## Cost-based delay, and why vacuums crawl

Vacuum throttles itself with a token bucket: each page costs `vacuum_cost_page_hit` (1),
`vacuum_cost_page_miss` (2) or `vacuum_cost_page_dirty` (20); when the accumulated cost exceeds
`autovacuum_vacuum_cost_limit` (200, or `-1` meaning inherit `vacuum_cost_limit`), it sleeps for
`autovacuum_vacuum_cost_delay` (2 ms). At defaults a worker sustains only a few MB/s — deliberately,
so maintenance does not evict the buffer cache.

For a fast SSD with spare IOPS, raise the limit rather than lowering the delay:

```sql
ALTER SYSTEM SET autovacuum_vacuum_cost_limit = 4000;   -- restart not needed, reload is
```

Also check `autovacuum_max_workers` (default 3). Three workers on a database with fifty busy
tables means the queue is the bottleneck, and one enormous table monopolises a worker for hours.
Raising workers raises total I/O, so pair it with the cost limit.

In emergency anti-wraparound mode, autovacuum ignores the delay entirely and runs at full speed.
That is a symptom you never want to see in a log.

## Measuring bloat honestly

`n_dead_tup` is an estimate from the last vacuum and can be stale. Better signals:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_vacuum,
       pg_size_pretty(pg_total_relation_size(relid)) AS total
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT * FROM pgstattuple_approx('orders');   -- fast, sampling-based
```

`pgstattuple_approx` returns `dead_tuple_percent` and `approx_free_percent`; when free space
exceeds roughly 30% of a large table, `pg_repack` (online, needs a primary key and double disk for
the table's indexes) buys back the space without the `VACUUM FULL` outage.

While a vacuum runs, `pg_stat_progress_vacuum` shows `phase`, `heap_blks_total`,
`heap_blks_scanned` and `max_dead_tuples`. A vacuum stuck in `scanning heap` for hours is not
stuck — it is being throttled, or it is re-reading a table that grew underneath it.

## Freezing and wraparound

Transaction IDs are 32 bits and compared modulo 2³². There are two billion IDs of headroom, and
the special `FrozenTransactionId` (2) is treated as "infinitely old and committed". Freezing
rewrites old tuples' `xmin` to frozen so the ID can be reused.

Relevant settings:

| Setting | Default | Effect |
| --- | --- | --- |
| `autovacuum_freeze_max_age` | 200,000,000 | age at which a table *forces* an anti-wraparound vacuum |
| `vacuum_freeze_min_age` | 50,000,000 | tuples older than this get frozen during any vacuum |
| `autovacuum_multixact_freeze_max_age` | 400,000,000 | same for multixact IDs |
| `vacuum_failsafe_age` | 1,600,000,000 | vacuum abandons throttling and truncation to avoid wraparound |

```sql
SELECT datname, age(datfrozenxid) AS xid_age,
       round(100.0 * age(datfrozenxid) / 2000000000, 1) AS pct_to_wraparound
FROM pg_database ORDER BY 2 DESC;

SELECT relname, age(relfrozenxid) FROM pg_class
WHERE relkind = 'r' ORDER BY 2 DESC LIMIT 10;
```

Alert at 1.5 billion, page at 1.8 billion. A database that reaches 2.1 billion refuses writes
with `database is not accepting commands to avoid wraparound data loss`, and the only fix is a
`VACUUM` in single-user mode — on a large table, that is a multi-hour outage with the system
offline.

Freezing is not free: the first touch of an old page sets hint bits, which dirties it and emits a
full-page WAL record. A table that has never been frozen will produce a WAL spike the first time
it is, which on a replica means replication lag.

## Multixacts

When several transactions hold locks on the same row — `SELECT FOR UPDATE` from three sessions —
PostgreSQL cannot store three IDs in `xmax`. It stores a multixact offset and lets
`pg_multixact/members` hold the list. These need their own freezing, and a multixact-heavy
workload (queue tables, `FOR UPDATE` fan-out) bloats `pg_multixact` in a way `pg_total_relation_size`
does not show. Watch `SELECT * FROM pg_stat_activity` for lock waits combined with
`pg_multixact` directory growth.

## Production notes

- Set per-table scale factors on every table above ~10 million rows. A single global
  `autovacuum_vacuum_scale_factor = 0.05` is a compromise that is wrong for both extremes.
- `maintenance_work_mem` caps the dead-TID array; 17 raised the per-operation limit to 2 GB, and
  `VACUUM (BUFFER_USAGE_LIMIT '256MB')` bounds its ring buffer.
- `VACUUM` on a partitioned table recurses into partitions; it does not run on the parent alone
  unless you say `ONLY`.
- Give autovacuum its own I/O budget and alert on `last_autovacuum IS NULL` for large tables —
  a table that has never been autovacuumed is either tiny or being skipped, and skipping is not
  silent only if you look.

## Common mistakes

- Believing `VACUUM FULL` is routine maintenance. It is an outage with a disk requirement.
- Lowering `autovacuum_vacuum_cost_delay` to 0 globally, then wondering why p99 latency tracks
  the maintenance window.
- Reading `n_dead_tup` as ground truth when no vacuum has run for a week.
- Setting `autovacuum = off` because "it caused a spike". The spike is the work you deferred.
