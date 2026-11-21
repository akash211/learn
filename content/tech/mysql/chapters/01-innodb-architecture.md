# InnoDB Architecture: Buffer Pool, Redo, Undo, and Doublewrite

InnoDB turns SQL changes into durable page modifications while allowing many transactions to share the same tables. Its central design is a write-back cache: pages are changed in memory, a sequential redo record makes those changes recoverable, and background threads eventually flush the pages to their tablespace files. Undo records preserve older row versions and support rollback. Understanding the distinction between these paths explains why a successful commit need not mean that every modified data page has already reached its final disk location.

## The buffer pool is a cache of database pages

InnoDB stores table and index data in fixed-size pages, usually 16 KiB by default. The buffer pool caches those pages in RAM. A point lookup first finds the relevant index page, then may fetch a clustered-index page. A cache hit avoids storage I/O; a miss requires reading a page into a buffer-pool frame. Dirty pages have been modified in memory but not yet written to their tablespace. They are not lost when the process crashes because redo can reconstruct modifications after recovery.

The buffer pool also contains metadata and participates in internal management. It is divided into instances when configured to reduce contention at very high concurrency, though modern MySQL defaults and automatic sizing make unnecessary manual partitioning a poor first move. The LRU-like replacement strategy is not a simple least-recently-used list: InnoDB uses a midpoint insertion strategy to keep one-pass scans from evicting the hot working set. A large reporting scan can still displace useful pages, so workload and memory pressure matter.

```sql
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_pages%';
```

Interpret counters as rates over an interval, not isolated lifetime totals. Physical reads relative to logical requests, page eviction activity, free pages, and dirty pages help test a cache hypothesis. A high hit ratio is not proof of health: one latency-sensitive query can repeatedly miss, and a server can achieve a flattering ratio while suffering from random reads on a large working set. Configure `innodb_buffer_pool_size` with room for connections, temporary work, operating-system cache, and other processes; do not allocate nearly all host RAM blindly.

## Redo makes page changes recoverable

When a transaction modifies a page, InnoDB generates redo records describing changes. Redo is written to the redo log, a sequential write-ahead log. The write-ahead rule is that the redo required to recover a changed page must be durable before the corresponding dirty page is allowed to become durable. At restart, InnoDB scans redo from a checkpoint and re-applies changes as needed, then resolves incomplete transactions using undo.

A commit's durability depends on settings and the storage stack. `innodb_flush_log_at_trx_commit=1` requests a log write and flush at each commit; `2` writes to the operating system at commit and flushes approximately once per second; `0` delays both approximately once per second. The latter settings may lose recently acknowledged transactions after an OS crash or power loss. Actual guarantees also depend on the filesystem, controller, virtualized disk, and whether flush requests are honored. Do not trade durability for throughput without an explicit recovery-point requirement and tests.

```sql
SHOW VARIABLES LIKE 'innodb_flush_log_at_trx_commit';
SHOW VARIABLES LIKE 'innodb_redo_log_capacity';
```

Redo capacity affects checkpoint pressure and burst tolerance, not the maximum amount of uncommitted work. If the system generates redo faster than dirty pages can be flushed, checkpoint age grows and foreground work may be throttled. A larger redo area can smooth bursts but cannot fix sustained storage throughput deficits. In MySQL 8.0.30 and later, `innodb_redo_log_capacity` is the primary capacity setting; older 8.0 releases used log-file sizing variables. Confirm the exact release before changing configuration.

## Undo supports rollback and consistent reads

Undo logs store information needed to reverse changes and to reconstruct older versions for MVCC consistent reads. An update usually creates a new clustered-index record version; older values remain reachable through undo until no active transaction needs them and purge can remove them. Undo is therefore not a backup and not a permanent history table. Long-running transactions can keep old versions alive, delaying purge and increasing undo history.

The history list length is a useful pressure signal, but it must be interpreted with workload and transaction age. Find open transactions rather than reflexively increasing tablespace size. A long `REPEATABLE READ` transaction that only appears idle can still keep an old read view alive. Monitor transaction age and investigate the application path that fails to commit or roll back promptly.

## Doublewrite protects against torn pages

A data page is larger than the smallest write unit that storage may guarantee atomically. A crash during a page write could leave a torn page, whose mixture of old and new sectors cannot safely be repaired by replaying redo alone. InnoDB's doublewrite mechanism first writes pages to a protected doublewrite area, flushes them, and then writes them to their tablespace locations. During recovery, a torn page can be restored from the complete doublewrite copy before redo is applied.

MySQL 8.0.20 and later support a dedicated doublewrite file; earlier versions use a region in the system tablespace. `innodb_doublewrite` is enabled by default and should generally remain enabled unless the storage layer provides a documented equivalent guarantee and the risk is consciously accepted. Atomic-write claims are device- and filesystem-specific; do not assume a cloud block volume provides page-atomic writes merely because it is durable.

## How the paths fit during a transaction

A write commonly touches a clustered-index page, one or more secondary-index pages, undo pages, and redo structures. The client commit can be acknowledged after the commit record is durable, while dirty data pages are written later. On a crash, recovery restores torn pages if needed, replays redo to a consistent state, then rolls back transactions without a durable commit using undo. This separation enables efficient sequential logging and deferred page writes, but it creates distinct operational signals: redo pressure, dirty-page flushing, undo history, and storage latency are related but not identical.

## Production notes

- Track buffer-pool and redo trends over intervals and correlate them with disk latency and query latency.
- Keep backups independent of the live buffer pool and redo log; they solve different failure classes.
- Use `SHOW ENGINE INNODB STATUS\G` for a point-in-time summary, but prefer durable time-series metrics for incident diagnosis.
- Validate durability settings under the actual storage and failover design, including abrupt-host-loss tests where feasible.

## Common mistakes

- Treating a high buffer-pool hit ratio as proof that all important queries are cache-resident.
- Assuming acknowledged commits are durable regardless of `innodb_flush_log_at_trx_commit` and storage semantics.
- Calling undo a backup or assuming redo alone retains a user-queryable transaction history.
- Disabling doublewrite based on an unverified assumption of atomic page writes.
