# File Formats, Parquet and Predicate Pushdown

Most Spark jobs are I/O bound before they are CPU bound, and the I/O is decided long before the
job runs — by how the table was written. A query that reads 40 GB instead of 4 TB is not a
tuning win, it is a schema and layout decision. This chapter covers what Parquet stores, which
of those things Spark can exploit, and how to lay out files so it can.

## Why columnar

A row-oriented file stores all fields of a row together. Reading two columns out of forty means
reading all forty and throwing thirty-eight away. A columnar file stores each column's values
contiguously, so:

- **Column pruning** reads only the requested columns from disk: a 3-column query on a 40-column
  table reads roughly 3/40 of the bytes. **Compression works better**, because values in a column
  share a type and a distribution. **Statistics are per column per block**, which is what makes
  data skipping possible.

## What a Parquet file contains

```
file
├── row group 0        (~128 MB by default)
│   ├── column chunk: customer_id   [min=1, max=999999, nulls=0]
│   │   ├── page 0   (~1 MB, dictionary + encoded values)
│   │   └── page 1
│   ├── column chunk: amount        [min=0.01, max=8400.00, nulls=12]
│   └── column chunk: event_date    [min=2026-01-01, max=2026-01-31]
├── row group 1
└── footer: schema, row-group offsets, per-column statistics, key-value metadata
```

The footer is why `spark.read.parquet(path)` is not free even before an action: Spark reads
footers to infer the schema. It is also why a table with 200,000 files takes minutes just to
plan — 200,000 footer reads.

Three encoding tricks do most of the work: dictionary encoding for low-cardinality columns, run-length
encoding for repeated values, and bit-packing for integers and timestamps. Compression matters too:
snappy (the default) and zstd are splittable, gzip is not — one `.gz` file is one task, forever.

## Two layers of pruning

Spark can avoid reading data at two levels, and it is worth knowing which one your filter is
using:

| Layer | Mechanism | Needs |
|---|---|---|
| Partition pruning | directory layout (`dt=2026-01-01/`) | filter on a partition column |
| Row-group skipping | per-column min/max/null statistics in the footer | filter on a column with stats, correlated with physical order |

Partition pruning is the strongest and cheapest. If the table is partitioned by `event_date` and
the query filters `event_date = '2026-01-01'`, Spark lists only that directory. No files outside
it are opened.

Row-group skipping is what people mean by "predicate pushdown" in the Parquet sense. Spark reads
the footer statistics and discards row groups whose min/max range cannot contain the predicate
value. Two conditions make it effective:

1. **The data is clustered.** If `country` is scattered randomly across row groups, every row
   group has `min=AR, max=ZW` and nothing can be skipped. Sorting or `ZORDER`-clustering by the
   filter column makes the ranges tight.
2. **The column has usable statistics.** Strings with a long common prefix (`session_8f3a...`)
   have wide ranges and skip poorly. Numeric and date columns skip well.

Null counts also matter: `IS NULL` can be answered from statistics.

`spark.sql.parquet.filterPushdown` is true by default — turn it off only to work around a reader
bug. Row-group filtering itself is not separately configurable in Spark 3.5; it is part of the
vectorised reader.

## Column pruning, including nested fields

```python
# reads 2 columns out of 40
df.select("customer_id", "amount")

# nested pruning: reads only address.city inside the struct
df.select("customer.address.city")

# array element pruning
df.selectExpr("explode(items.price)")
```

Nested pruning is controlled by `spark.sql.optimizer.nestedSchemaPruning.enabled` (default true)
and is one of the largest wins on event data with wide structs — a `select` of three nested fields
from a JSON-derived schema can read a small fraction of the bytes.

The optimizer can only prune what the plan does not need. `df.select("*")` followed by Python
processing in `collect()` reads everything; `toPandas()` on a wide table pulls every column into
the driver.

## Dynamic partition pruning

Static pruning needs a literal. A join needs pruning based on the *other* table's values, and
that is what DPP does:

```python
fact = spark.read.table("events")            # partitioned by dt
dim = spark.read.table("campaigns").filter("status = 'active'")   # small

fact.join(F.broadcast(dim), "campaign_id").groupBy("dt").count().show()
```

With `spark.sql.optimizer.dynamicPartitionPruning.enabled=true` (default) and
`spark.sql.dynamicPartitionPruning.reuseBroadcastOnly=true` (default), Spark broadcasts the
dimension, collects the distinct partition-key values at runtime, and applies them as a filter
on the partitioned side. The fact table scan then touches only the partitions that can match.

DPP is one of the biggest wins in star-schema workloads, and one of the most fragile: it needs the
partition column to survive into the join, statistics on the join key, and a broadcast-able
dimension. A cast on the partition column, or a filter that hides it, silently disables it.

## Aggregate pushdown and metadata-only answers

Since 3.3, `spark.sql.parquet.aggregatePushdown` (default **false**) lets Parquet answer
`count`, `min`, `max` and `sum` from footer statistics for simple scans. It is off by default
because the correctness conditions are subtle, but it can remove a scan entirely for dashboard
queries. Delta goes further: `count(*)` can be answered from the transaction log without opening
any Parquet file at all.

## Writing files that read well

```python
(clean
 .repartition(200)                             # evenly sized output tasks
 .sortWithinPartitions("customer_id")          # tight row-group stats for point lookups
 .write
 .mode("overwrite")
 .option("maxRecordsPerFile", 5_000_000)       # cap file size ~ a few hundred MB
 .partitionBy("dt")
 .parquet("s3://lake/events_clean/"))
```

| Decision | Guidance |
|---|---|
| Target file size | 128 MB–1 GB; below 32 MB is a small-file problem |
| Partition columns | low cardinality, always filtered (`dt`, `region`, `tenant`) |
| Sort order before write | the columns used in point/range filters |
| Compression | snappy for balance, zstd for storage cost, never gzip for large tables |
| `maxRecordsPerFile` | bound runaway files from skewed partitions |

`dynamic` partition overwrite is worth calling out: in the default `static` mode, overwriting a
single day rewrites or deletes the entire table's partitions. In dynamic mode, only partitions
present in the new data are replaced. Getting this wrong in a backfill is how tables lose history.

## The small-file problem

Ten thousand files of 3 MB each is far more expensive than one 30 GB file. Each file carries:

- a footer read (and a `LIST`/`HEAD` request on object storage),
- 4 MB of `openCostInBytes` charged toward partition sizing, so 3 MB files pack badly,
- task setup and scheduling overhead,
- one entry in the metastore or table log.

The practical ceiling is a few thousand files per table for interactive queries. Compaction —
reading many small files and writing fewer large ones — is a scheduled maintenance job. Delta's
`OPTIMIZE`, Iceberg's `rewrite_data_files`, and a plain `repartition` + rewrite all do the same
thing.

## Format comparison

| Format | Layout | Splittable | Schema evolution | Use |
|---|---|---|---|---|
| Parquet | columnar | yes (not gzip) | add columns | default analytical storage |
| ORC | columnar | yes | add columns | Hive-heavy stacks; similar to Parquet |
| Avro | row | yes | yes, with reader schema | streaming/Kafka landing, write-heavy |
| JSON | row, text | yes | implicit | ingestion only; never a serving format |
| CSV | row, text | yes (not gzip) | none | exchange with humans; no types, no stats |
| Delta / Iceberg | Parquet + log | yes | yes, transactional | mutable tables, merges, time travel |

## Common mistakes

- Partitioning by `user_id` or `event_id`, producing millions of tiny directories.
- Filtering on `substr(dt, 1, 7)` or `cast(ts as date)` on a partition column, which disables
  pruning.
- Assuming a filter is pushed down when a Python UDF or a non-deterministic expression sits
  between it and the scan.
- Writing with default `static` partition overwrite in a backfill and deleting history.
- Never compacting, then blaming Spark for a 20-minute planning phase.

## Production notes

Check the scan node in `explain("formatted")`: it lists `PartitionFilters`, `PushedFilters`,
`ReadSchema` and the number of files. If `ReadSchema` has columns you did not ask for, something
upstream is defeating pruning. If `PartitionFilters` is empty on a partitioned table, your
predicate is not being recognised.

Measure bytes read versus bytes in the table: a query reading 80% of a table to answer a one-day
question is a layout bug, not a compute bug.
