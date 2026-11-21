# Joins, Broadcasts and Skew

Joins decide the cost of most Spark jobs. A pipeline that reads two terabytes and joins them
badly will spend an hour moving data; the same pipeline with the right strategy finishes in
minutes. The three things to know are which strategy Spark chose, why, and what to do when one
key ruins the plan.

## The strategies

| Strategy | Plan node | Shuffle | Works when |
|---|---|---|---|
| Broadcast hash join | `BroadcastHashJoin` | none | one side fits comfortably in executor memory |
| Shuffled hash join | `ShuffledHashJoin` | both sides | one side is much smaller after the shuffle, no sort needed |
| Sort-merge join | `SortMergeJoin` | both sides | both sides large; the general-purpose default |
| Broadcast nested loop | `BroadcastNestedLoopJoin` | none | non-equi condition, one side small |
| Cartesian product | `CartesianProduct` | both sides | no condition at all; almost never what you want |

Spark picks a strategy during physical planning, using table statistics, the broadcast
threshold, and any hints. With AQE on, it can change its mind after the shuffle when the real
partition sizes are known — usually turning a sort-merge join into a broadcast or shuffled hash
join.

## Broadcast hash join

If one side is under `spark.sql.autoBroadcastJoinThreshold` (default **10 MB**), Spark collects
it to the driver, builds a hash table, and ships it to every executor as a broadcast variable.
Each task then probes that hash table with its own partition of the big side. No shuffle, no
sort, one pass.

```python
from pyspark.sql import functions as F

# explicit, when statistics are missing or stale
result = orders.join(F.broadcast(customers), "customer_id")

# or in SQL
spark.sql("SELECT /*+ BROADCAST(c) */ * FROM orders o JOIN customers c USING (customer_id)")
```

The threshold is deliberately conservative because broadcasting is not free:

- The small side is materialised **on the driver** first. A 2 GB "small" table can OOM the driver
  before a single task runs.
- Each executor holds a full copy, and each concurrent task may build its own hash map from it.
  With 8 cores per executor, an 800 MB broadcast can mean 6.4 GB of hash tables.
- Collection is subject to `spark.sql.broadcastTimeout` (default 300 s). A slow driver or a
  congested shuffle service produces `TimeoutException: Could not execute broadcast`.

Raising the threshold to 100 MB is a reasonable, common tuning step when you know the table's
real size and the cluster has memory. Raising it to 1 GB is how jobs die. The hard ceiling in
Spark is 8 GB; below that, the failure is memory, not the config.

## Sort-merge join

The default for two large inputs:

1. Shuffle both sides by the join keys, so matching keys land in the same partition.
2. Sort each partition by those keys.
3. Merge the two sorted streams, emitting matches.

It is robust — no size assumption, bounded memory per partition, spills when needed — and it is
the slowest of the three because it pays for two shuffles and two sorts. Its cost scales with
`shuffle write + shuffle read + sort`, which is why the same query can be ten times cheaper when
the small side is broadcast.

If both sides are already partitioned identically — same hash function, same partition count —
Spark skips the exchange. That is what bucketing exploits: `bucketBy(200, "customer_id")` on both
tables, saved as managed Hive tables, plans a shuffle-free sort-merge join. It requires identical
bucket counts and keys, and Delta/Iceberg do not support it, so in practice AQE plus good file
layout has replaced it.

## Shuffled hash join

Here each side is shuffled by key, then the smaller side's partition is loaded into a hash map
that the larger side probes. No sort, but the build side must fit in memory per partition.

AQE chooses it when the post-shuffle size of one side is small relative to the other
(`spark.sql.adaptive.maxShuffledHashJoinLocalMapThreshold`, default 0, means "decide by relative
size"). Setting `spark.sql.join.preferSortMergeJoin=false` allows it statically. It is much faster
than sort-merge for medium dimension tables and much more likely to OOM if the estimate is wrong.

## Non-equi joins

`t1.join(t2, t1.start < t2.end)` cannot be hash-partitioned. Spark either broadcasts one side and
runs a nested loop (`BroadcastNestedLoopJoin`, cost = rows × broadcast rows) or, with no
broadcast, produces a cartesian product and filters. For interval joins, exploding a date range
into rows and joining on equality is usually faster than any nested loop.

## Skew: the failure mode that looks like a hang

Skew is when a few keys hold a large share of the rows — a null `customer_id`, a default tenant,
a bot that generated 30% of the events. Hash partitioning sends every row of a key to one
partition, so one task reads and sorts gigabytes while the rest finish in seconds.

Symptoms:

- Stage progress stuck at 199/200 for an hour.
- `Shuffle Read Size` max ≫ median in the stage summary.
- One executor's disk fills with spill while others are idle.

### Null keys first

Rows with a null join key never match anything, but they all hash to the same partition. One
line often fixes an hour:

```python
orders = orders.filter(F.col("customer_id").isNotNull())
```

If you need to keep them, join them separately and `union` the result.

### Salting

Spread a hot key over N sub-partitions by adding a random salt to the large side and replicating
the small side N times:

```python
SALT = 16

big = big.withColumn("salt", (F.rand() * SALT).cast("int"))
small = small.select("*", F.explode(F.array([F.lit(i) for i in range(SALT)])).alias("salt"))

joined = big.join(small, ["customer_id", "salt"]).drop("salt")
```

This turns one 40 GB partition into sixteen 2.5 GB partitions. The cost is real: the small side is
duplicated 16×, and the salt must be applied consistently to every join in the pipeline, or you
reintroduce the shuffle you were avoiding.

### Splitting the hot keys out

When only a handful of keys are pathological, handle them separately:

```python
hot_keys = ["", "UNKNOWN", "bot-42"]
small_hot = small.filter(F.col("key").isin(hot_keys))

hot = big.filter(F.col("key").isin(hot_keys)).join(F.broadcast(small_hot), "key")
cold = big.filter(~F.col("key").isin(hot_keys)).join(small, "key")
result = hot.unionByName(cold)
```

The hot branch broadcasts a tiny slice of the dimension table; the cold branch shuffles normally
and is now balanced. This is more code than salting, but it duplicates nothing.

### Let AQE do it

`spark.sql.adaptive.skewJoin.enabled` (default true) detects partitions above both
`spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` (default 256 MB) and
`skewedPartitionFactor` (default 5× the median) and splits them into sub-partitions for
sort-merge joins. It handles the common case with no code change.

It does not handle everything. AQE skew handling applies to sort-merge joins, not to
aggregations, window functions, or a single skewed *input* partition. If your bottleneck is
`groupBy(key)` with one giant key, or a source file that is one partition, salting or splitting
the key is still your job.

## Join keys, types and semantics

- **Type mismatches force casts.** Joining `string` to `bigint` casts one side, which can disable
  partition pruning and bucketing, and in non-ANSI mode silently turns unparseable values into
  nulls. Match types at the source.
- **Null never equals null.** `a = b` drops null keys on both sides. `a <=> b` (`eqNullSafe`)
  matches nulls to each other, but it is not a hash-joinable predicate in every case and often
  falls back to a broadcast nested loop.
- **Duplicate keys multiply rows.** A dimension table with two rows per key doubles the fact
  table. Check uniqueness of the small side — `df.groupBy(key).count().filter("count > 1")` —
  before trusting a join count.

## Common mistakes

- Raising `autoBroadcastJoinThreshold` to "make it faster" without checking the driver's memory.
- Joining on a column that was just cast, then wondering why the partition pruning disappeared.
- Salting one side of a join and not the other, which changes the key and produces nulls.
- Assuming AQE will fix aggregation skew. It will not.

## Production notes

Run `ANALYZE TABLE ... COMPUTE STATISTICS FOR ALL COLUMNS` on tables you join repeatedly, and
enable `spark.sql.cbo.enabled` when join order matters (star schemas with many dimensions). The
cost is a stats job; the benefit is a plan chosen from real cardinalities rather than file sizes.

In the Spark UI, the SQL tab shows the join strategy per node and the actual rows and bytes per
exchange. That is the ground truth: `explain()` tells you the plan, the SQL tab tells you what it
cost.
