# Storage Engine: Pages, Extents and the Buffer Pool

SQL Server's storage engine moves data between durable database files and memory in units that are small enough to manage but large enough to amortise I/O. The fundamental unit is the **8-KB page**. Pages are grouped into **extents** of eight consecutive pages, or 64 KB. A rowstore table is a B-tree whose leaf level holds the table's rows; its physical layout, allocation maps and buffer-pool residency explain many behaviours that look mysterious from the SQL layer.

## Pages, records and allocation

A data page has a header, a sequence of records and a slot array at the end. The slot array maps logical row offsets to physical positions, allowing SQL Server to move records within a page without changing the slot number. A record contains metadata and column data. Variable-length columns use an offset array, and large values may be stored off-row through LOB or row-overflow allocation units. Row size and schema design therefore influence not just logical capacity but page density and the number of pages scanned.

An extent is a contiguous allocation of eight pages. SQL Server can allocate a uniform extent to one object or use mixed extents shared among small objects; modern versions allocate uniform extents by default in most cases. Allocation is tracked by structures including PFS (page free space and allocation status), GAM (free extents), SGAM (mixed-extent allocation) and IAM (pages belonging to an allocation unit). These maps help the engine find space; they are not indexes on user data.

A heap has no clustered index ordering its rows. SQL Server still tracks its pages and allocations, and a nonclustered index on a heap uses a RID (file, page, slot) as the row locator. A clustered table instead stores rows at the leaf of its clustered B-tree. Its clustered key becomes the row locator carried by nonclustered indexes, so a wide clustered key increases the cost of every nonclustered index. The key is a logical sort order, not a promise that storage files are physically contiguous in query order.

## Buffer pool and I/O

The buffer pool caches database pages in memory. A read miss brings a page into a buffer; modifications make it **dirty**. A checkpoint and lazy writer write dirty pages to data files, but transaction durability does not wait for those data pages. Instead, write-ahead logging requires the log records describing a change to reach stable storage before the corresponding dirty page can be written. This separation allows write coalescing and crash recovery.

```sql
SELECT database_id, file_id, page_type, numa_node,
       page_count, cached_page_count
FROM sys.dm_os_buffer_descriptors
WHERE database_id = DB_ID();
```

This DMV is a snapshot of cached pages, not a complete performance diagnosis. A large cache footprint can simply mean a frequently used database. For file-level latency, `sys.dm_io_virtual_file_stats` returns cumulative read/write counts, bytes and stall time. Take two samples and calculate interval averages; cumulative totals alone are not current latency.

SQL Server uses a buffer pool per instance and can use memory beyond the classic buffer pool for other consumers. `max server memory` is a critical boundary, but setting it to all physical RAM leaves no space for the OS, drivers, backup compression, linked-server providers and other processes. Monitor memory pressure using performance counters, `sys.dm_os_process_memory`, `sys.dm_os_sys_memory` and wait statistics rather than treating cache size as inherently good or bad.

## Rowstore pages versus columnstore

Rowstore pages store a record's columns together, which suits point lookups and updates to a few rows. Columnstore organizes values by column into compressed rowgroups, better for scanning and aggregating a large fraction of a fact table. Both ultimately use pages and the buffer pool, but their unit of work and compression trade-offs differ. A table can use a clustered columnstore index as its primary storage and optionally add nonclustered rowstore indexes for selective access.

Page density is a practical tuning variable. Fill factor can reserve room on B-tree pages for future inserts or updates, but it does not reserve space in every leaf page forever. Too low a fill factor expands the working set and adds I/O; use it only when page splits are evidenced and the write pattern is understood. `sys.dm_db_index_physical_stats` reports fragmentation and density information, but fragmentation alone does not prove a query is slow.

## Production notes

- Use `sys.dm_db_database_page_allocations` and `DBCC IND` only for targeted storage investigations; page-level inspection is not a routine substitute for query plans.
- The transaction log is not a second copy of the data file. It is sequential recovery history, with log truncation governed by checkpoints, backups, replication and active transactions.
- Autogrowth is a safety net, not a capacity plan. Pre-size files based on measured growth and choose sensible growth increments to avoid repeated tiny growth events.
- A filegroup distributes allocation and can aid administration, but multiple files on the same storage do not automatically make a query faster.

## Common mistakes

- Assuming extent or file order is the same as a query's result order. Only `ORDER BY` guarantees result order.
- Choosing a random, wide clustered key and then overlooking its duplication in nonclustered row locators.
- Treating page density or index fragmentation as a universal health score without workload evidence.
- Raising `max server memory` until the operating system is starved, then blaming SQL Server's buffer pool for paging.


## Worked example: following a lookup to storage

Suppose an application requests one order by its key and then displays a handful of attributes. A useful design question is not simply whether the table is “in memory,” but how many pages the access path must touch. A clustered seek navigates non-leaf B-tree pages to a leaf page containing the row. A nonclustered seek may locate a key and then perform a key lookup into the clustered index for each matching row. If the predicate returns thousands of rows, repeated lookups can touch many pages even when each individual seek is cheap. Compare actual execution plan row counts and logical reads before covering the query with an index.

The buffer pool keeps pages by database and file identifiers. `sys.dm_os_buffer_descriptors` can estimate which database pages are resident at the moment, but it is not an eviction history or a cache hit ratio for one statement. `sys.dm_io_virtual_file_stats(NULL,NULL)` exposes cumulative per-file reads, bytes and stall time. Capture two timestamped samples and subtract counters; average read latency is the increase in `io_stall_read_ms` divided by the increase in reads, with zero-read intervals excluded. Averages can conceal queueing bursts, so compare the samples with host storage telemetry and query-level physical reads.

```sql
SELECT DB_NAME(vfs.database_id) AS database_name,
       mf.name AS logical_file_name,
       vfs.num_of_reads, vfs.io_stall_read_ms,
       vfs.num_of_writes, vfs.io_stall_write_ms
FROM sys.dm_io_virtual_file_stats(NULL, NULL) AS vfs
JOIN sys.master_files AS mf
  ON mf.database_id = vfs.database_id AND mf.file_id = vfs.file_id
WHERE vfs.database_id = DB_ID(N'Sales');
```

This returns totals since the relevant counters began; it does not calculate an interval or establish causality. File growth, restart and failover can reset or change the measurement context. Pair it with a plan, `SET STATISTICS IO ON`, and workload timestamps. Physical reads are also affected by cache state and read-ahead, while logical reads count buffer-pool page accesses whether those pages came from disk or were already cached.

## Row width, allocation and the log

A wide row reduces rows per page and increases the number of pages needed for scans and cache residency. Variable-length columns, row-overflow and LOB storage complicate the simple “one row, one page” picture. A schema review should check actual row lengths and access patterns before moving large values or changing types. Allocation maps answer where free or owned pages are, not which rows satisfy a predicate; only an access structure such as a B-tree or columnstore metadata can help the optimizer locate qualifying data efficiently.

The log and data files serve different roles. Log records are written ahead of dirty data pages to support redo and undo after failure. A commit waits for the relevant log flush, not for every changed data page to be written. This is why a workload can show `WRITELOG` latency while data-file reads appear healthy, and why frequent tiny transactions can produce many flushes. Delayed durability, batching, and log-device changes have correctness and latency trade-offs; investigate transaction boundaries and `sys.dm_io_virtual_file_stats` before proposing them. Never treat file order or page allocation order as a result-order contract: only a query's `ORDER BY` guarantees output ordering.
