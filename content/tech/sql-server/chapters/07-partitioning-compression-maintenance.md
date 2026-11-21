# Partitioning, Compression and Maintenance

Partitioning divides a table or index into independently managed ranges while preserving one logical object name for queries. In SQL Server, partitioning is primarily a manageability and data lifecycle feature; it does not automatically make queries faster. Compression reduces storage and I/O at the cost of CPU. Maintenance should be selected from observed fragmentation, density, statistics and workload impact—not from a weekly script that rebuilds every index.

## Range partitioning and elimination

A partition function maps values to partition numbers, and a partition scheme maps those partitions to filegroups. A common design partitions a fact table by date. Range boundaries can be `RANGE RIGHT` or `RANGE LEFT`; choose deliberately so the boundary belongs to the intended month/day. Partition elimination occurs when a query predicate allows SQL Server to exclude partitions. Use predicates compatible with the partition key and data type, and inspect the actual plan to confirm elimination.

Partitioning does not provide local uniqueness for free. A unique partitioned index generally needs the partitioning column as part of its key so uniqueness can be enforced across aligned partitions. That can change application key design. All indexes need appropriate alignment for partition switching. `ALTER TABLE ... SWITCH` can move data quickly between compatible tables or partitions, but source and target schemas, indexes, constraints and check constraints must satisfy strict requirements. It is metadata movement, not a generic shortcut for arbitrary tables.

Partitioning is valuable for rolling windows: load into a staging table, validate, switch into the main table, and switch or truncate an old partition for retention. The staging table must match the target structure, and boundary management should create the next range before data arrives. Test the switch in advance; a mismatch may block an operational window.

## Partition maintenance details

A partitioned table can place ranges on separate filegroups, but that only helps when storage placement, backup policy or lifecycle operations justify the complexity. Partition numbers are not permanent business identifiers: changing a function or merging/splitting boundaries can move data and generate substantial log and I/O. Monitor `sys.dm_db_partition_stats` and `sys.partitions` to see row counts by partition, and keep boundary values aligned with the actual date/time precision. A predicate that wraps the partition column in a function may prevent effective elimination; use half-open ranges such as `event_time >= @start AND event_time < @end` with matching types.

## Compression options

Row compression changes storage representation to use less space for many numeric and fixed-length values. Page compression adds prefix and dictionary compression within a page. Both may reduce I/O and buffer-pool footprint, while consuming CPU on reads and writes. Columnstore uses its own encoding and compression mechanisms, not row/page compression in the same way. Estimate compression with `sp_estimate_data_compression_savings` on representative data, then benchmark the actual workload.

Compression can help a read-heavy table with substantial redundant values, but it is not universally beneficial. Write-heavy rows can cost more CPU, and compression may interact with page splits and row size. Evaluate both space saved and CPU added. Backup compression is a separate operation at backup time and is not the same as data-page compression.

## Rebuild, reorganize and statistics

A rebuild recreates an index and can change fill factor and compression; it can update index statistics as part of the operation. A reorganize incrementally defragments leaf pages and is online, but cannot change fill factor or perform all rebuild effects. Rebuilds can consume log, CPU, I/O and temporary space, and availability depends on version, edition and index type. Online does not mean lock-free; short schema locks can still occur.

Fragmentation matters most when the index is large enough for physical order to affect read-ahead and the workload performs range scans. Page density can be as important as fragmentation because denser pages reduce reads and cache usage. Check `sys.dm_db_index_physical_stats` in a limited mode first on large databases. A static percentage threshold is not a universal rebuild rule. Rebuilding tiny indexes repeatedly may consume more resources than it saves.

Statistics maintenance is related but distinct. Rebuilds update index statistics, not necessarily every column statistic. Auto-update statistics can be insufficient or delayed for a particular workload, but indiscriminate full scans are expensive. Use `sys.dm_db_stats_properties` and plan estimates to identify stale or low-sample statistics that matter. Query Store can validate whether maintenance changes improved the targeted workload.

## Common mistakes

- Expecting partitioning to improve any query without partition elimination or a lifecycle-management need.
- Creating monthly partitions but forgetting boundary maintenance and aligned index requirements.
- Assuming a partition switch will work despite mismatched indexes or check constraints.
- Rebuilding every index on a calendar regardless of size, scan pattern or write impact.
- Confusing index reorganize with statistics refresh or assuming a rebuild updates all statistics.
- Enabling compression without testing CPU and latency on representative reads and writes.


## Worked partition lifecycle and boundary checks

A monthly fact table may use a `RANGE RIGHT` function with each first-of-month boundary assigned to the partition on its right. With boundaries at 2026-01-01 and 2026-02-01, February timestamps belong to the range beginning at the second boundary. Confirm boundary interpretation with `sys.partition_range_values`, `sys.partition_functions` and a small test table; date/time precision can create subtle off-by-one errors. Query with half-open ranges and parameters of the same type as the partition column so the optimizer can eliminate unrelated partitions:

```sql
WHERE event_time >= @month_start
  AND event_time <  @next_month_start;
```

Wrapping `event_time` in `CONVERT(date, event_time)` or comparing against an implicitly converted literal can obstruct a seek or elimination. Verify the partition access in the actual plan; a table being partitioned does not mean a query touches fewer partitions. `sys.dm_db_partition_stats` provides row and page counts by partition, useful for detecting uneven loads and confirming retention operations.

For a fast rolling load, build a staging table with compatible columns, indexes, constraints and a trusted check constraint limiting rows to the target range. Validate row counts and business rules, then perform `ALTER TABLE ... SWITCH` in a controlled maintenance transaction. Switching is metadata-oriented only when source and target structures meet exact requirements; it is not a substitute for validation. Keep an empty receiving partition or staging target ready, and create future boundaries before the load window. Splitting a populated range can move substantial data and generate log, so partition management itself needs capacity planning.

## Maintenance decisions with actual evidence

A rebuild can improve page density, change compression or fill factor and refresh the index's statistics, but also uses log, CPU, I/O, memory and temporary space. Online rebuild still has brief schema-lock phases and is not supported for every index, version or edition. Reorganize incrementally processes leaf pages, is less disruptive in many cases, and does not update statistics as a rebuild does. Use `sys.dm_db_index_physical_stats` in a limited mode to inspect representative objects; its scans can themselves create I/O. Fragmentation is most relevant to large range scans, while low density can increase pages read and cache footprint. Neither a 5% nor 30% threshold is a universal policy.

Statistics are separate objects. Rebuilding one index does not refresh all column statistics. `sys.dm_db_stats_properties` exposes last update, row counts and modification counts; compare with actual estimates and data volatility. Fullscan updates can be expensive, and a fresh single-column histogram may still fail to capture correlation across columns. Query Store before/after data can show whether targeted maintenance affected the workload.

Compression should be tested using representative partitions and writes. `sp_estimate_data_compression_savings` estimates space effects, not application latency. Row/page compression can reduce I/O but add CPU; backup compression is independent. Document the tested object, sample, expected write rate, maintenance window and rollback path. Maintain only when a measurable workload or lifecycle objective justifies the cost.
