# Caching, Persistence and Memory

Caching is the most over-used and least understood feature in PySpark. Used well, it turns two
passes over an expensive intermediate into one. Used badly, it fills executor memory with data
nobody reads and makes the job slower than the uncached version. This chapter is about knowing
which case you are in, and about where the memory actually goes.

## What cache does

`df.cache()` marks the DataFrame's plan so that the first time an action materialises it, the
resulting partitions are stored on the executors. Every later action over the same plan reads the
stored partitions instead of recomputing the lineage.

```python
enriched = (orders
            .join(customers, "customer_id")
            .join(products, "product_id")
            .withColumn("margin", F.col("price") - F.col("cost")))

enriched.cache()          # lazy: marks the plan
enriched.count()          # materialises: the expensive part is now in memory/disk
enriched.groupBy("region").agg(F.sum("margin")).show()   # reads the cache
enriched.groupBy("category").count().show()              # reads the cache
```

Three properties matter:

- **Lazy.** `cache()` alone does nothing. The first action pays for the computation *and* the
  storage.
- **Partition-level.** If one cached partition is lost (executor died), only that partition is
  recomputed from lineage. The cache is not a checkpoint; the plan is still there.
- **Plan-keyed.** The cache is attached to a specific analysed plan. `enriched.filter(...)` will
  use it; a DataFrame built independently from the same source will not, even if it looks
  identical.

## Storage levels

| Level | Behaviour | Use when |
|---|---|---|
| `MEMORY_ONLY` | deserialised objects in memory | RDDs you will scan repeatedly and fit |
| `MEMORY_AND_DISK` | memory, spill partitions to disk | the default for DataFrames; safe |
| `MEMORY_ONLY_SER` | serialised bytes in memory | RDDs, when object overhead is the problem |
| `MEMORY_AND_DISK_SER` | serialised, spill to disk | large RDDs |
| `DISK_ONLY` | disk only | very large intermediates, slow but stable |
| `OFF_HEAP` | outside the JVM heap | large heaps, GC pressure |
| any `_2` | replicate to two nodes | rare; costs double memory |

`DataFrame.cache()` is shorthand for `persist(StorageLevel.MEMORY_AND_DISK)`. `RDD.cache()` is
`MEMORY_ONLY`. That difference is not cosmetic: a cached DataFrame stores rows in Spark's
columnar in-memory format, which is compact and fast to scan; a cached RDD stores one Java object
per row, typically several times larger, and puts real pressure on the garbage collector.

For DataFrames, `MEMORY_AND_DISK` is almost always right. For RDDs, `MEMORY_ONLY_SER` is usually
a better default than `MEMORY_ONLY` because the serialised form is much smaller — at the cost of
CPU on every read.

## Where the memory goes

An executor's JVM heap is divided like this (Spark 3.x, default settings):

```
┌─────────────────────────────────────────────────────┐
│ Reserved memory                      300 MB         │
├─────────────────────────────────────────────────────┤
│ Unified region = (heap − 300 MB) × 0.6              │
│   ┌──────────────────┬──────────────────────────┐   │
│   │ Storage (cache)  │ Execution (shuffle, join,│   │
│   │ 50% by default   │ sort, aggregate)         │   │
│   └──────────────────┴──────────────────────────┘   │
├─────────────────────────────────────────────────────┤
│ User memory = (heap − 300 MB) × 0.4                 │
│   your data structures, UDF state, metadata        │
└─────────────────────────────────────────────────────┘
```

The split inside the unified region is not a hard wall. Execution memory can borrow from storage,
evicting cached blocks (least-recently-used first) when it needs room; storage cannot borrow from
execution, it can only wait for execution to release. When a cached block is evicted, the next
read recomputes that partition — so an over-large cache quietly becomes an inefficient
recomputation engine.

Outside the heap sits `spark.executor.memoryOverhead`, default `max(384 MB, 10% of
spark.executor.memory)`. Python worker processes, Arrow buffers, native libraries and JVM
internals live there. A PySpark job that OOMs with `Container killed by YARN for exceeding memory
limits` while the heap looks fine is usually an overhead problem — pandas UDFs holding large
Arrow batches are the classic cause.

Worked example: a 16 GB executor has 15.7 GB usable, 9.4 GB unified, of which roughly 4.7 GB is
available for cache by default. Caching an 8 GB DataFrame does not fail; it evicts, and you get
the worst of both worlds — memory spent, recomputation still happening. Either shrink what you
cache (select the columns you need first) or raise `spark.memory.storageFraction`, accepting less
room for shuffles.

## When caching is the right move

- **The same expensive intermediate feeds several actions.** Multiple aggregations, a write plus
  a validation query, an interactive exploration after a big join.
- **Iterative algorithms.** Machine learning loops that reuse the same feature table.
- **Point lookups in a loop.** A small dimension table cached once and probed many times.
- **After an expensive shuffle you will re-read.** Cache the post-join result, not both inputs.

## When caching hurts

- **One action only.** You paid storage and eviction for nothing.
- **The data does not fit.** You get eviction thrash, which is worse than recomputation because
  it also consumes memory bandwidth and GC time.
- **You cache before filtering.** Cache the reduced DataFrame: `df.filter(...).select(...)` then
  `cache()`, not the 4 TB source.
- **You cache a DataFrame that downstream code rebuilds.** A new `spark.read` produces a new
  plan; it will not see the cache.
- **You never unpersist.** A long-lived cluster accumulates caches until executors are full of
  blocks belonging to jobs that finished hours ago.

## Checkpoint is not cache

| | `cache()` / `persist()` | `checkpoint()` |
|---|---|---|
| Where | executor memory/disk | reliable store (HDFS, S3, DBFS) |
| Lineage | kept | truncated |
| Eager | no | yes |
| Survives executor loss | recomputes partition | reads from store |
| Cost | memory | write + read I/O |
| Use for | reuse within a job | breaking long lineage, iterative jobs |

`localCheckpoint()` sits in between: executor-local storage, lineage truncated, not reliable.
Use it to stop a plan from growing in a loop where recomputation is cheap.

## Cache invalidation

Spark does not watch your storage. If you overwrite the Parquet files under a cached DataFrame,
the cache keeps serving the old rows:

```python
df.cache()
df.count()

spark.read.parquet(path).write.mode("overwrite").parquet(path)   # another job rewrites the data

df.count()          # still the OLD rows — cache is untouched
df.unpersist()      # now the next read sees the new files
```

For catalog tables, `spark.catalog.refreshTable("db.table")` (or `REFRESH TABLE`) invalidates
metadata and cached plans; Delta and Iceberg add their own transaction-log handling, but an
in-memory cache still needs `unpersist()`. This is the most common "stale dashboard" bug in
long-running notebooks and shared clusters.

## Broadcast variables and accumulators

Two smaller memory tools that come up in the same conversations:

```python
lookup = spark.sparkContext.broadcast({...})     # shipped once per executor, not per task
def f(x):
    return lookup.value.get(x)
```

Without `broadcast`, a captured dict in a closure is pickled into every task — thousands of
copies of the same object. Broadcast ships it once per executor and shares it across tasks.

Accumulators (`spark.sparkContext.accumulator(0)`) count across tasks, but they are only
guaranteed correct inside actions, and task retries or speculative execution can double-count.
Never use them for control flow.

## Common mistakes

- Caching a DataFrame and then using a different DataFrame derived from the original source.
- Assuming `cache()` is eager and timing the wrong thing.
- Caching a 500 GB table because "it is used twice"; `MEMORY_AND_DISK` will thrash the disks.
- Forgetting `unpersist()` in a notebook and blaming the cluster for slow later jobs.
- Setting `spark.executor.memory=64g` with a 5-core executor and no overhead budget, then hitting
  container kills from Python workers.

## Production notes

Cache deliberately and sparsely. A good rule: cache only what you would otherwise write to a
temporary table, and prefer writing the temporary table when the intermediate is larger than a
few hundred gigabytes.

Track `spark.sql.inMemoryColumnarStorage.batchSize` (default 10000 rows) only if you are fighting
GC in the columnar cache; it is rarely worth changing. Track `spark.memory.storageFraction`
upward (0.6–0.7) only when the UI shows cached blocks being evicted during the job.

Finally, look at the **Storage** tab of the Spark UI after the job. It shows bytes cached per
DataFrame, fraction in memory versus disk, and evictions. If a cached DataFrame is mostly on
disk, the cache is a slow disk read with extra steps — reduce its size or drop it.
