# Partitioning and Shuffle Mechanics

Partitioning is the only lever that changes how much data moves. Everything else — caching,
codegen, file formats — changes how fast a fixed amount of data is processed. This chapter is
about the movement.

## Three meanings of "partition"

The word is used for three different things, and conflating them causes most partitioning bugs:

1. **Read partitions** — how Spark splits the input files into tasks.
2. **Shuffle partitions** — how many buckets the exchange writes and the next stage reads.
3. **Write partitions** — how many files (and directories) land in storage.

A job can have 4,000 read partitions, 200 shuffle partitions, and 4,000 output files. Each
number is set by a different mechanism.

## Read partitioning

Spark groups files into partitions of roughly `spark.sql.files.maxPartitionBytes` (default
128 MB), with `spark.sql.files.openCostInBytes` (default 4 MB) charged per file to account for
the cost of opening it. Small files are packed together into one partition; large splittable
files are cut at block boundaries.

That packing is why 8,000 files averaging 3 MB produce roughly 440 partitions rather than 8,000
tasks — and why each task still pays the per-file open cost, which is the real reason small files
hurt.

Splittability depends on the codec. Parquet with snappy, zstd or no compression splits at block
boundaries; gzip does not. A single 40 GB `.csv.gz` is *one* partition, and no amount of
`repartition` before the read helps — you must decompress and rewrite it once, then work from the
splittable copy.

`spark.sql.files.minPartitionNum` (defaults to `spark.default.parallelism`) sets a floor so a
directory of ten huge files does not produce ten tasks on a hundred-core cluster.

## repartition vs coalesce

```python
df.rdd.getNumPartitions()          # current count

df.repartition(400)                # full shuffle, round-robin
df.repartition(400, "customer_id") # full shuffle, hash on the key
df.repartitionByRange(400, "ts")   # full shuffle, sampled range boundaries
df.coalesce(40)                    # narrow: merge adjacent partitions, no shuffle
```

| | `repartition` | `coalesce` |
|---|---|---|
| Shuffle | yes | no |
| Can increase partitions | yes | no |
| Distribution | even (hash or round-robin) | keeps existing skew |
| Cost | full data movement | near zero |
| Use for | fixing skew, pre-shuffle layout, write parallelism | reducing files after a filter |

`coalesce` merges partitions by having each task read several parent partitions, so it can only
shrink. `coalesce(1)` funnels the entire dataset through a single task: correct for a 5 MB
summary, catastrophic for a 500 GB table.

## Hash partitioning, precisely

For `repartition(n, "key")` and for any shuffle with a hash partitioning, Spark computes
`pmod(murmur3_hash(key), n)`. `pmod` returns a non-negative result, so negative hashes do not
land in a negative bucket. All rows with the same key land in the same partition — which is what
makes `groupBy(key)` correct and `join` on the key possible.

The number of buckets is decided at plan time:

- SQL and DataFrame shuffles: `spark.sql.shuffle.partitions` (default **200**).
- RDD shuffles: the `numPartitions` argument, else the largest parent partition count.

Two hundred is a default from the 1.x era, sized for clusters of a few dozen cores. On a 200-core
cluster it gives less than one task per core; on a 4-core development machine it gives fifty waves
of tiny tasks.

## What a shuffle actually does

Spark's default shuffle is **sort-based**. For each map task:

1. Rows are partitioned by reducer and appended to an in-memory buffer.
2. When the buffer fills, it is sorted by `(partition_id, key)` and spilled to disk.
3. Spills are merged into a single data file plus an index file per map task.

The reducer then fetches its blocks from every map task, using up to
`spark.reducer.maxSizeInFlight` (default 48 MB) of in-flight requests at a time, decompresses
them, and merges the sorted runs.

The numbers that matter:

| Setting | Default | Effect |
|---|---|---|
| `spark.shuffle.compress` | true | lz4 by default; network is usually the bottleneck |
| `spark.shuffle.file.buffer` | 32 KB | write buffer per shuffle file; raise for many small spills |
| `spark.reducer.maxSizeInFlight` | 48 MB | memory used by fetches; lower it if reducers OOM |
| `spark.shuffle.io.maxRetries` | 3 | retries on fetch failure, with 5 s backoff |
| `spark.shuffle.spill.compress` | true | compresses spilled runs |

Shuffle output is `M × R` blocks — 2,000 map tasks and 200 reducers means 400,000 blocks, plus
two files per map task. At that scale, file handles and random I/O become the cost, and the
external shuffle service (`spark.shuffle.service.enabled`) becomes mandatory for dynamic
allocation: it holds shuffle files after an executor is released, so reducers do not have to
recompute the map side.

Map-side pre-aggregation is the quiet hero. For `groupBy(k).sum(v)`, Spark runs a partial
aggregate in the map task before the shuffle, so the network moves one row per key rather than
one row per input record. If your aggregation is a Python UDF, that pre-aggregation cannot
happen and the shuffle grows by orders of magnitude.

## Choosing a partition count

The working rule: **aim for 100–200 MB of shuffle data per partition**, and never fewer tasks
than 2× the cores available.

```python
# 1.2 TB of shuffle data on a 40-core cluster
# 40 cores x 3 = ~120 tasks, 1.2 TB / 120 = 10 GB per task -> far too big
spark.conf.set("spark.sql.shuffle.partitions", 6000)   # ~200 MB each
```

Too few partitions: each task holds too much in memory and spills, the cluster is underused, and
one straggler determines the stage duration. Too many: several milliseconds of scheduling
overhead per task, a scheduler event queue that becomes the bottleneck, and thousands of tiny
output files.

With AQE on, a good pattern is to set the shuffle partition count high enough for the worst
case and let `spark.sql.adaptive.coalescePartitions` merge the small ones after the map stage
(chapter 8). Note that with `parallelismFirst=true` — the default — AQE optimises for
parallelism over the 64 MB target, so it will not coalesce as aggressively as you might expect.

## Reading skew from partition sizes

`spark_partition_id()` exposes the shuffle partition of the current row, which turns skew into a
query:

```python
from pyspark.sql import functions as F

(df.groupBy(F.spark_partition_id().alias("pid"))
   .count()
   .select(F.min("count"), F.max("count"), F.avg("count"),
           (F.max("count") / F.avg("count")).alias("skew_ratio"))
   .show())
```

If the max is 20× the average, the next stage has a straggler: 199 tasks finish in two minutes
and one runs for an hour. The Spark UI shows the same thing as `Shuffle Read Size` max versus
median in the stage's summary metrics. Chapter 4 covers what to do about it.

`spark_partition_id()` is only meaningful after an exchange — on a freshly read DataFrame it
reflects the file grouping, which is useful for diagnosing read skew but not shuffle skew.

## Write partitioning

Write partitioning is where the file count is decided: `df.write.partitionBy("dt")` writes one
directory per value of `dt`, and one file per (task, partition value) pair. The column leaves the
files and enters the path, which gives free partition pruning on read. Cardinality is the enemy:
`partitionBy("user_id")` produces a million directories and files measured in kilobytes. Partition
on the low-cardinality columns you filter on, and cap the file count with `repartition(n, "dt")`
before the write.

## Common mistakes

- Setting `spark.sql.shuffle.partitions` to 10 because the cluster is small, then OOMing on a
  5 GB partition.
- `coalesce(1)` to get a single CSV, which serialises the whole write through one core.
- Partitioning a table by a high-cardinality column and calling the resulting file count "a
  storage problem".
- Forgetting that gzip input is unsplittable, then blaming the cluster for a single-task read.

## Production notes

Watch two UI numbers per stage: **shuffle read size per task** (should be in the low hundreds of
MB) and **spill (memory / disk)**. Spill on the map side means the sorter buffer is too small for
the partition size; spill on the reduce side means the partition is too large or the aggregation
state is too big.

Treat the shuffle as a physical artefact with a lifecycle: it is written to executor local disk,
served over the network, and deleted when the stage is done. Anything that kills executors
mid-flight — spot instance reclamation, dynamic allocation shrinking too fast, a misconfigured
shuffle service — turns into `FetchFailedException`. That is almost never a code bug, and chapter
10 covers how to make it survivable.
