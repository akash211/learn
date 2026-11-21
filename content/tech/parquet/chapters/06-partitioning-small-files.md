# Partitioning Layouts and Small Files

Partitioning describes how a dataset is split into files and directories, and the word is overloaded. A good layout helps readers avoid irrelevant data; a poor layout multiplies metadata, requests and tasks. Parquet itself describes row groups inside files, but common dataset conventions place many Parquet files under partition directories such as `event_date=2026-11-21/`.

## Partition pruning at the directory level

A dataset writer can encode values of selected columns in directory names and omit those columns from each file's data schema, or readers may encounter them in both places depending on the convention. For example:

```text
sales/
  region=west/event_date=2026-11-20/part-....parquet
  region=east/event_date=2026-11-20/part-....parquet
```

A query filtering `event_date` may let the engine identify matching paths before opening file footers. This is partition pruning. It can reduce file opens and bytes substantially, but only when the query engine understands the layout and can map the predicate to partition values. A transform such as casting or applying a function may prevent that mapping, depending on optimizer and type semantics.

Partition columns should have a measured balance of usefulness and cardinality. Dates are common because workloads frequently select periods; geography or tenant may be reasonable if queries filter on them and values are not excessively numerous. Partitioning by unique event ID creates a directory per row and is disastrous. Even a moderately cardinal column can create many nearly empty partitions when combined with date and region.

Partitioning is not the same as sorting. Partitioning creates coarse separate path groups; sorting orders rows inside output files. A useful layout may partition by a low-cardinality date and sort within each date by a frequent range-filter key. Do not create one directory per value merely to obtain ordering.

## The small-file problem

Every file imposes work beyond its data bytes: object-store listing or catalogue discovery, a footer request, metadata parsing, scheduler/task overhead and an entry in table metadata. At scale, thousands of tiny objects can make planning slower than scanning. High request latency makes this worse. Compression does not remove per-object cost.

The right file-size target is contextual rather than a magic constant. Workload, engine, row-group sizing, storage, parallelism and expected query concurrency all matter. Many analytical systems choose files in the hundreds of megabytes, sometimes larger, but a low-latency or partitioned workload may prefer smaller outputs. The important failure is uncontrolled proliferation of files too small to amortize metadata and request costs, not missing an exact target.

Small files arise from too many writer tasks, repeated incremental appends, highly granular partitions, skewed input, or writing each micro-batch as its own files. A compaction operation rewrites many small files into fewer larger ones while preserving logical rows. Compaction needs resource budgets and safe table semantics; on raw paths, overwriting files while readers run can expose inconsistent state.

## Data partitioning and parallelism

Parallelism is constrained by how much independent work exists. A single giant Parquet file can contain many row groups and still allow parallel scans, depending on the reader; one giant row group may limit that. Conversely, many tiny files create too many tasks and footer requests. The file count and row-group structure both matter.

On distributed writers, output file count is often related to partitions or tasks, but not a strict one-to-one rule: partitioned writes can emit multiple files per task or no file for empty partitions. Skew means a task may write much more than its peers, creating oversized files. Repartitioning can redistribute work but adds a shuffle; coalescing reduces tasks without rebalancing and can preserve skew. Tune with actual output file sizes and task metrics.

## Choosing a layout

Start from query predicates and distribution. Use partition directories for a small set of common, coarse filters that sharply reduce data. Use row-group statistics and physical ordering for finer filtering within those files. Avoid partition columns that create many empty or low-volume path combinations. Keep frequently filtered high-cardinality keys in data columns and consider clustering or sorting instead.

| Layout choice | Useful for | Main risk |
|---|---|---|
| Partition by day | Date-range queries with enough volume per day | Many tiny daily files for sparse data |
| Partition by tenant | Isolated tenant scans with manageable tenant count | Hot tenants or thousands of tiny tenant paths |
| Sort within files | Narrow row-group min/max for range filters | Shuffle/sort cost on writer; not a directory-level index |
| No partitioning | Broad full scans or highly irregular filters | More files may need footer evaluation |

Hierarchical partitioning multiplies cardinalities. A table partitioned by year, month, day, region, country and source can have a huge path space even if each column seems reasonable alone. A good design usually chooses only the dimensions used for coarse pruning and leaves the rest to data columns.

## Common mistakes

- Partitioning by a near-unique key and creating directories with almost no rows.
- Treating `partitionBy` as a way to sort data or guarantee one file per value.
- Fixing file count with a blind `coalesce(1)`, which removes parallel write capacity and can produce a huge single task.
- Assuming a target file size can be reached evenly when partitions are skewed.
- Compaction on raw directories without considering concurrent readers and writers.

## Production notes

Track file count, size distribution, files per partition, median and tail file size, and planning time. Watch both tiny and huge outliers. Compact incrementally when justified rather than rewriting the whole lake on a schedule without evidence. If a table format is in use, use its supported rewrite/optimize operation so the transaction log and concurrent readers see a consistent snapshot. For raw datasets, publish complete immutable partitions and make the pointer or catalogue update explicit.

## Partitioning is a workload contract

A partition layout is a contract between writers and readers. Writers decide directory keys and types; readers must discover the paths and map query predicates to those values. Inconsistent formatting can defeat pruning: `month=7` and `month=07`, mixed timezone boundaries, or a string date beside a timestamp field may all force extra discovery or produce wrong assumptions. Keep partition values canonical, and test how each engine infers types from paths. The partition key's representation should be part of the dataset contract rather than an incidental string.

Partitioning also affects data governance and operations. A partition may be the unit of backfill, retention or access control, but those practices should be explicit. A date path is not a transaction boundary by itself. If a job rewrites one date while a reader is listing, the reader may observe a partial set unless a table protocol or publication scheme prevents it. Immutable versioned outputs plus a manifest can work for batch datasets, but the manifest update must be the visible commit point.

Evaluate the design using representative query logs. Ask what fraction of queries filter each proposed key, how much data those filters exclude, and how much volume each resulting partition receives. A highly selective but rarely used key may not justify permanent directory fan-out. A less selective daily key may be worthwhile because it enables routine retention and backfills. Keep partitioning, sorting, and transaction semantics as separate design decisions.
