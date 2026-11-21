# Transformations, Actions and the DAG

Lazy evaluation is only useful if you know what the optimizer can do with the plan you built.
That depends on one property: whether an operation requires data to move between machines.
Everything else in this chapter follows from it.

## Narrow and wide

A **narrow** transformation computes each output partition from at most one input partition. A
**wide** transformation needs rows from many input partitions in the same output partition,
which means a shuffle.

| Narrow | Wide |
|---|---|
| `select`, `withColumn`, `drop` | `groupBy(...).agg(...)` |
| `filter`, `where` | `join` (unless broadcast) |
| `union`, `unionByName` | `distinct`, `dropDuplicates` |
| `map`, `flatMap`, `mapPartitions` (RDD) | `repartition`, `repartitionByRange` |
| `coalesce` (fewer partitions) | `orderBy` |
| `explode`, `withColumn` with scalar UDF | `cube`, `rollup`, window functions with `partitionBy` |

Narrow steps are fused into a stage. Wide steps break the stage: Spark writes the shuffle output,
then reads it back in the next stage. This is why `join` and `groupBy` dominate cluster time and
why a `filter` placed before or after a join matters far more than the same filter in a
single-node pandas job.

One exception on the left: `coalesce` is narrow because it only merges existing partitions — it
cannot increase parallelism. And `sortWithinPartitions` is a local sort inside each partition,
while `orderBy` is a global sort that needs a range shuffle.

## From plan to stages

When an action arrives, the DAG scheduler walks the logical plan and inserts a stage boundary at
every exchange. Each stage becomes a `TaskSet` with one task per partition.

```
Job: write net_total
├── Stage 1  (200 tasks)  scan parquet -> filter -> project -> partial_sum
│      Exchange: hashpartitioning(customer_id, 200)
└── Stage 2  (200 tasks)  final sum -> write
```

Two numbers describe a stage: how many tasks it has, and how much data each task moves. A stage
with 200 tasks and 400 GB of shuffle output is a different problem from a stage with 2 tasks and
400 GB, even though the byte count is identical.

## The DAG is not the plan

Three different objects get called "the plan":

- **Logical plan** — what you asked for, as a tree of expressions. Rewritten by Catalyst rules.
- **Physical plan** — which operators and which join strategies will run. Chosen by cost and
  strategy rules.
- **Stage DAG** — the physical plan split at exchanges, with dependencies, submitted to the
  scheduler.

With AQE enabled (the default since 3.2), the physical plan is *provisional*. Spark executes the
shuffle stages, reads the real partition sizes from the map output statistics, and then re-plans
the downstream stage — coalescing partitions, switching a sort-merge join to a broadcast, or
splitting a skewed partition. This is why `explain()` before an action can differ from what ran:
`AdaptiveSparkPlan isFinalPlan=false` is a warning that you are reading an estimate.

## A worked example

```python
orders = spark.read.parquet("s3://lake/orders")          # 2 TB, 8,000 files
customers = spark.read.parquet("s3://lake/customers")    # 40 MB

result = (orders
          .filter(F.col("order_date") >= "2026-01-01")
          .join(customers, "customer_id")
          .groupBy("region")
          .agg(F.sum("amount").alias("revenue")))
result.write.mode("overwrite").parquet("s3://lake/out/region_revenue")
```

What actually runs:

1. **Scan stage.** 8,000 files are grouped into ~128 MB partitions
   (`spark.sql.files.maxPartitionBytes`), the filter and the column pruning happen inside the
   Parquet reader, so only `customer_id`, `amount` and the partition column are decoded.
2. **Broadcast.** `customers` is 40 MB, above the 10 MB default broadcast threshold, so Spark
   plans a sort-merge join and shuffles both sides. Adding `F.broadcast(customers)` (or raising
   `spark.sql.autoBroadcastJoinThreshold`) turns it into a map-side join and removes one
   exchange — a good trade at 40 MB, a bad one at 40 GB.
3. **Aggregation.** Two-stage: partial sums per partition, exchange on `region`, final sums.
   Since `region` has a handful of values, the shuffle moves almost nothing.
4. **Write.** One file per output partition; `region` cardinality of 20 means twenty tiny files
   unless you coalesce or use a table format that compacts.

Sketch these four stages before running anything: if you cannot say where the exchanges are, you
cannot predict the cost.

## Transformations that are deceptively expensive

- **`orderBy`** is a full range shuffle plus a local sort. It is never free, and it is usually
  unnecessary — `sortWithinPartitions` before a write gives you sorted files for the same
  downstream benefit at a fraction of the cost.
- **`distinct()`** is `groupBy(all columns)`. On a wide DataFrame with array or map columns it
  fails outright, and on any DataFrame it shuffles everything.
- **`dropDuplicates(["id"])`** keeps an arbitrary row per key unless you order first; the
  non-determinism is a correctness bug, not a performance one.
- **Window functions** shuffle once per distinct window specification. Three `Window.partitionBy`
  clauses with different keys mean three shuffles.
- **`withColumn` in a loop** creates one projection per iteration. The optimizer can collapse
  simple ones, but the plan grows linearly and the driver pays for it.
- **`explode`** multiplies rows. An array of 1,000 elements turns one row into a thousand, and
  the downstream shuffle moves all of them. `crossJoin` is quadratic and never finishes at scale.

## Actions and their costs

| Action | What runs | Cost profile |
|---|---|---|
| `show(n)` | one job, `limit` pushed down | cheap; stops early |
| `count()` | full scan of every partition | proportional to data size, not result size |
| `take(n)` | one partition first, then more | cheap unless the first partition is empty |
| `collect()` | everything to the driver | driver memory bound |
| `write` | full plan, one file per task | the number of output files is a design decision |
| `foreach` | full plan, side effects | retried on failure; not idempotent by default |

`count()` is the most common accidental full scan: for Parquet there is usually no metadata-only
count, so the job at least reads every file footer and often every row group. Use `take(1)` when
you only need to know whether there is data.

## Reuse across actions

Each action re-executes the lineage from the source. Two actions on an uncached DataFrame read
the input twice and shuffle twice. The fixes, in order of preference:

1. **One action.** Compute everything in a single job — several aggregations in one `agg`, several
   outputs from one pass.
2. **Cache** the expensive intermediate if two actions genuinely need it (chapter 6).
3. **Write an intermediate table** when it is large, reused across jobs, or must outlive the cluster.

## Lineage and its limits

Lineage is what makes Spark fault-tolerant: a lost partition is recomputed from its parents. It
is also what makes long jobs fragile. A chain of 200 transformations means a failed task replays
200 steps, and an iterative algorithm that unions its output each round grows the plan until the
driver gives up.

- `df.checkpoint()` writes to a reliable store (`spark.sparkContext.setCheckpointDir(...)`),
  truncates lineage, and is eager — it runs a job.
- `df.localCheckpoint()` writes to executor local disk or off-heap memory, truncates lineage, and
  is *not* reliable: if an executor dies, the checkpoint is lost and Spark recomputes from the
  original source, which it can only do if the lineage is still there in the RDD.

Use `checkpoint()` at iteration boundaries in loops and before a long fan-out of downstream jobs.
Use `localCheckpoint()` only when the lineage is cheap to recompute and you just want to stop the
plan from growing.

## Common mistakes

- Assuming `filter` after `join` is as cheap as `filter` before it. Push filters down by hand
  when the optimizer cannot (UDFs, non-deterministic expressions).
- Calling `count()` for logging in the middle of a pipeline, then wondering why the job runs
  twice.
- Building a 300-column DataFrame with 300 `withColumn` calls.
- Treating `coalesce(1)` as a way to get one output file — it collapses all parallelism into one
  task on one core.
- Expecting `df.explain()` to show the plan that actually ran when AQE is on.

## Production notes

Keep an eye on the ratio between input bytes and shuffle bytes in the Spark UI. A job that reads
2 TB and shuffles 2 TB has a partitioning or join-strategy problem; one that reads 2 TB and
shuffles 20 GB is slow for a different reason — small files, skew, or a single-threaded UDF.
