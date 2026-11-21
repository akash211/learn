# Indexing: Rowstore, Filtered and Columnstore

An index is an access structure the optimiser may choose, not an instruction to use a particular plan. SQL Server's rowstore indexes are B-trees. Their design must balance lookup selectivity, ordering, coverage, write cost and storage. Columnstore indexes solve a different problem: compressing and scanning wide analytical data efficiently.

## Clustered and nonclustered rowstore

A clustered index's leaf level contains the table rows, ordered by the clustered key within the B-tree. A table without a clustered index is a heap. The clustered key is not necessarily unique; SQL Server adds an internal uniqueifier when needed to distinguish duplicate key values. A unique, stable, narrow key is often a sensible choice, but insert pattern and query workload matter more than a slogan about sequential identities.

A nonclustered index has its own B-tree. Its leaf stores key columns, optional included columns, and a row locator. For a clustered table the locator is the clustered key; for a heap it is a RID. Thus changing a clustered key can enlarge every nonclustered index. Key columns support seeking and ordering; included columns exist at the leaf to cover output without increasing the tree's navigation key.

```sql
CREATE INDEX IX_orders_customer_time
ON dbo.orders (customer_id, order_ts DESC)
INCLUDE (status, total_amount);
```

The leading-key rule remains useful: equality predicates on leading columns followed by a range column often align with a seek. But the optimiser may use an index for ordering, a partial range or a key lookup. Covering every query by adding columns is not free; it increases disk, cache footprint and write amplification. Look at the actual plan's lookup count and query frequency before adding payload.

## Filtered indexes

A filtered index stores only rows satisfying a predicate, reducing size and maintenance for stable subsets such as active rows or non-null values:

```sql
CREATE INDEX IX_orders_open
ON dbo.orders (customer_id, order_ts)
INCLUDE (total_amount)
WHERE status = 'open';
```

The query predicate must be compatible with the filter, and parameterisation can affect whether the optimiser can prove that at compile time. A reusable plan for `status = @status` cannot always assume the value is `'open'`. Test the real parameterised form rather than just an ad hoc literal. Filtered indexes also have restrictions on expressions and data types, so confirm the DDL is supported for the intended predicate.

## Columnstore

A columnstore index stores values by column in compressed **rowgroups**. A columnstore segment keeps metadata such as minimum and maximum values that can eliminate segments when predicates exclude their range. This enables batch-mode processing, where operators process vectors of rows rather than one row at a time. It is especially effective for large fact tables with scans, aggregation and compression-friendly types.

A clustered columnstore index is a table's primary storage. A nonclustered columnstore index can provide an analytical projection over a rowstore table. Delta stores receive rows that are not yet in compressed rowgroups; the tuple mover or a rebuild can compress them. Small rowgroups reduce scan efficiency and compression. Highly selective point lookups or frequent single-row updates may fit rowstore better, although current SQL Server supports operational patterns beyond the old "columnstore is read-only" rule. Validate feature and edition support for the deployed version.

## Measure index use and cost

`sys.dm_db_index_usage_stats` reports seeks, scans, lookups and updates since startup or certain lifecycle events. It is evidence, not a drop list: a low-use index may protect a rare but critical report, and counters reset. `sys.dm_db_index_operational_stats` offers lower-level lock and I/O activity. `sys.dm_db_index_physical_stats` reports fragmentation and page density. Correlate those signals with actual plans and workload telemetry.

Missing-index suggestions from execution plans and DMVs are hypotheses. They commonly propose overlapping indexes, ignore write cost and may overstate benefit because the estimated query is viewed in isolation. Consolidate overlapping key prefixes, keep uniqueness and constraint semantics, and measure the effect. Query Store helps compare query plans and runtime before and after changes.

## Production notes

Online index operations and resumable operations vary by SQL Server version, edition, index type and service. Check support before relying on them. Rebuilding an index updates its structure and can refresh statistics for that index; reorganize is an online, incremental leaf-level operation and does not offer every rebuild effect. Neither is a substitute for diagnosing a poor key design.

## Common mistakes

- Adding an index because a plan says "missing index" without checking overlap, write rate or the whole workload.
- Using a very wide clustered key and paying for it in each nonclustered index's row locator.
- Treating `INCLUDE` columns as free; they still consume leaf pages and must be maintained.
- Assuming a filtered index is usable for every parameter value of a parameterised predicate.
- Using columnstore for a tiny lookup table or expecting rowgroup elimination when segment ranges overlap heavily.
- Dropping an index based on counters without accounting for server restarts and infrequent critical queries.


## Choosing rowstore versus columnstore with workload evidence

A useful design starts from the shape of the data access. A transactional request may seek one customer and fetch a few current rows; a reporting query may scan millions of fact rows, group by dimensions and calculate sums. A rowstore B-tree is naturally suited to selective navigation and ordered retrieval. Columnstore stores values by column in compressed segments, reducing I/O when only some columns are read and enabling vectorized batch-mode operators. It is not “always faster”: an analytical query returning nearly every row can still be dominated by data volume, while a point lookup against a large compressed table may need a different path.

A rowgroup can contain up to roughly one million rows when compressed, but actual size and quality depend on load pattern, memory, concurrency and version. Rows may first land in a delta rowgroup, which is rowstore-backed and later compressed by the tuple mover. Small or closed rowgroups reduce compression and scan efficiency. Segment elimination uses min/max metadata per column segment; a timestamp clustered into orderly load ranges can exclude segments for date predicates, while random interleaving makes segment ranges overlap and weakens elimination. Inspect `sys.dm_db_column_store_row_group_physical_stats` for state, row counts and deleted rows, and compare the actual plan's batch-mode operators and reads.

```sql
SELECT object_name(object_id) AS table_name, index_id,
       row_group_id, state_desc, total_rows, deleted_rows,
       size_in_bytes
FROM sys.dm_db_column_store_row_group_physical_stats
WHERE object_id = OBJECT_ID(N'dbo.FactSales');
```

This DMV is an operational snapshot, not a universal quality score. Deleted-row percentage, rowgroup count and segment overlap must be interpreted with table size and ingestion cadence. Reorganizing or rebuilding a columnstore can merge rowgroups and remove deleted rows but consumes resources and may affect availability; schedule and test the operation for the actual platform.

## A reviewable index-change workflow

Before adding an index, capture the query's current plan, logical reads, duration and execution frequency. Map equality, range, join and ordering predicates to a candidate key sequence; decide whether includes remove meaningful lookup work. Check existing indexes, constraints, filtered-index eligibility and write overhead. After a controlled change, compare Query Store runtime and plan history across a representative interval, including insert/update cost and storage. `sys.dm_db_index_usage_stats` can inform the discussion, but it resets and does not capture business criticality. A rare compliance query may still justify an index.

For columnstore on operational tables, also account for concurrent writes, rowgroup maintenance, delete bitmap effects, archival partitioning and small lookup workloads. Some versions support updateable clustered columnstore with additional rowstore structures, but exact capabilities differ. A hybrid design—clustered columnstore plus a nonclustered rowstore index—may suit a mixed workload, yet each index increases maintenance and storage. State the version and benchmark before recommending it. An index is a hypothesis about a workload, not a command to the optimizer.
