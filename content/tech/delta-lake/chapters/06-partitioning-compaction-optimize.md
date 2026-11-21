# Partitioning, Compaction and OPTIMIZE

A Delta table's physical layout affects scan cost, write cost and conflict probability. Layout is not part of its logical row semantics: two layouts can represent the same table version. The goal is to reduce unnecessary file reads while keeping file counts and write amplification manageable. Three terms are often confused: **partitioning** organizes files into directory-style groups, **compaction** combines small active files, and **`OPTIMIZE`** is an operation that can compact and, in supported environments, reorganize data for skipping or clustering.

## Partitioning: use a few useful coarse keys

A partitioned Delta table writes files under directory paths associated with partition-column values, for example `event_date=2026-06-10/`. A query filtering on that column can avoid unrelated directories. Partitioning can also make a bounded overwrite or merge cheaper when data ownership aligns with the same key.

Partition columns should have a limited number of values and should match common selective filters. Dates, regions or tenant tiers may be sensible at scale. A unique user id usually is not: it creates too many directories and small files, metadata overhead, and costly listing. Partitioning does not sort rows inside a file, and a partition predicate is not automatically applied unless the query has a compatible filter.

Partitioning is a commitment. Changing the partition scheme generally requires rewriting or creating a new table, and users may accidentally rely on filesystem paths. Do not partition a small table because it feels “more organized.” For many modern workloads, unpartitioned tables with file statistics and clustering are simpler.

## Small files and compaction

Streaming micro-batches, high-frequency appends and overly fine-grained writers can produce many tiny files. Query planning and object-store request overhead grow with file count; each file also has metadata and footer work. A common remedy is compaction: rewrite many small active files into fewer larger files while preserving logical rows.

An approximate target size around hundreds of megabytes to about a gigabyte is a starting point, not a universal rule. Optimal sizing depends on row width, query parallelism, cloud/object-store behavior, concurrency and engine. Extremely large files can reduce parallelism and increase the amount scanned for a selective query. Extremely small files create overhead and poor amortization.

Spark Delta supports `OPTIMIZE` for compaction in compatible versions. Databricks may add platform optimizations such as auto compaction and predictive optimization for managed tables. OSS clients have their own supported operations and APIs; do not assume that a Databricks SQL command is available from every engine or a delta-rs version.

## Data skipping and Z-order

Delta writers can record per-file statistics, commonly minimum/maximum values and null counts for selected columns. A reader can skip a file when its statistics prove that no row can match a predicate. Randomly distributed values have broad overlapping min/max ranges, so data skipping is weak. Reorganizing data to put similar values together narrows ranges and can improve skipping.

Databricks `OPTIMIZE ... ZORDER BY (col1, col2)` co-locates values using a multi-dimensional ordering approach. It is most useful for selective filters on a small set of columns where ordinary partitioning would create too many partitions. Z-ordering rewrites files and consumes compute; it is not an index and doesn't guarantee that every query reads fewer bytes. Choosing too many columns spreads the locality benefit, and frequently rewriting an unchanged table wastes resources.

## Choosing between layout strategies

| Technique | Helps when | Cost or limitation |
|---|---|---|
| Hive-style partitioning | Queries often filter by a few coarse, low-cardinality columns; writes align by partition. | High-cardinality partition explosion, small files, rigid layout. |
| Compaction | There are many small active files. | Rewrite I/O and temporary storage; no inherent locality for predicates. |
| Z-order | Selective filters repeatedly use a few columns with useful statistics. | Platform/version availability; rewrite cost; benefit depends on data and predicate shape. |
| Liquid clustering | Access patterns evolve or partitioning/Z-order maintenance is cumbersome, with a compatible Delta client. | Protocol/features and client support required; not combined with partitioning or Z-order. |

Liquid clustering is covered separately because support, compatibility and implementation continue to evolve. The important point here is to avoid stacking incompatible layout techniques without a migration plan.

## Example workflow

First inspect the query profile and table details: file count, file sizes, partition skew, bytes scanned, files pruned and the most common filters. If the issue is thousands of tiny files, compact first and compare. If scan volume remains high because files overlap broadly on common filter columns, test an organization strategy such as Z-order on a representative workload. Use a copy or an isolated subset for experiments; compare both read latency and maintenance compute.

In Databricks SQL, a typical operation is:

```sql
OPTIMIZE sales ZORDER BY (customer_id, product_id);
```

This syntax is not portable to every OSS client. A plain `OPTIMIZE` without Z-order may perform compaction. Re-run the same representative queries after the rewrite and inspect file skipping, not just total file count.

## Common mistakes

- **Partitioning on a high-cardinality key.** This often exchanges scan work for directory and file explosion.
- **Optimizing on a schedule without a metric.** A rewrite can cost more than it saves, especially for append-only cold data.
- **Equating compaction with ordering.** Fewer files do not mean data is clustered for predicates.
- **Z-ordering too many columns.** The locality benefit is diluted and maintenance grows.
- **Expecting `OPTIMIZE` to change query semantics.** It should preserve rows; validate counts and table version when investigating anomalies.

## Production notes

Set operational targets using observed query patterns, not a universal “ideal file size.” Compact hot partitions more often than cold history. Coordinate maintenance with writers to avoid unnecessary conflicts and peak load. Record before/after metrics—files, bytes scanned, pruning ratio, task count, and wall time—and stop optimizations that do not pay for their rewrite cost.

## Avoiding layout churn

A table's most popular filter can change, and layout changes have inertia: old files remain in the prior organization until rewritten. If two workloads need different columns, avoid repeatedly optimizing the entire table for whichever query ran last. Consider a stable common key, selective partition maintenance, separate derived tables for incompatible access patterns, or a clustering strategy that can adapt. Evaluate the combined workload, not one dashboard query.

When compaction follows streaming ingestion, tune it to the append rate and file-size distribution. If micro-batches generate thousands of files per day, fixing batch sizing or writer parallelism may be more effective than rewriting them continuously. Run a representative query before and after maintenance with caches controlled, and include concurrent write cost in the comparison. Keep a backout plan for layout migrations: changing physical organization should preserve logical rows, but a client-version or protocol change performed at the same time makes failures harder to isolate.