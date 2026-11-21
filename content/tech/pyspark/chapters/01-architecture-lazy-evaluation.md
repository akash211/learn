# Architecture and Lazy Evaluation

PySpark does not process data in Python. It builds a plan in Python, hands that plan to a JVM,
and the JVM reads, shuffles and computes. Almost every surprising PySpark behaviour — why
nothing happens when you call `filter`, why a stack trace appears minutes after the line that
caused it, why a UDF costs so much more than the built-in function that does the same thing —
follows from that split.

## Three processes, one plan

| Process | Runs | Holds |
|---|---|---|
| Driver JVM | `SparkContext`, DAG scheduler, task scheduler, Catalyst | the query plan, the stage graph, task state |
| Driver Python | your `main()` / notebook | DataFrame handles, closures, the Py4J bridge |
| Executors | JVM + Python worker processes | task execution, shuffle output, cached blocks |

`spark-submit` starts the JVM driver; your Python program attaches to it through a Py4J gateway
that translates `spark.read.parquet(...)` into JVM calls. In client mode that Python process sits
on the machine you launched from — a laptop, an edge node, a notebook server. In cluster mode it
runs on a cluster node. Either way, it is not where data is processed: it holds the plan and
coordinates. `collect()` and `toPandas()` pull rows *into* it, which is why collecting a billion
rows kills the driver while the executors are perfectly healthy.

Executors are JVM processes with a fixed number of cores. Each core is a slot, and a slot runs
exactly one task at a time. A four-core executor runs four tasks concurrently regardless of how
many partitions the DataFrame has; a hundred-partition job on three such executors runs in
roughly nine waves. Python work happens in separate worker processes — one per core, reused
across tasks — that exchange serialised rows with the JVM over a local socket.

## Slots, tasks, partitions

A **partition** is a slice of data. A **task** is one partition processed by one stage on one
core. A **stage** is a group of tasks that can run without moving data between machines. A
**job** is one action's worth of stages.

That gives the sizing rule people usually learn the hard way: parallelism is bounded by
partitions and by slots, whichever is smaller. Ten thousand partitions on a cluster with forty
cores gives forty tasks running at a time; one partition gives one task, and the rest of the
cluster idles. Chapter 3 covers how partitions get their size.

## What laziness actually means

A DataFrame is a description, not a result. It carries a logical plan, a schema and a reference
to the session. Transformations return a *new* DataFrame and record a node in the plan; they do
not touch data.

```python
from pyspark.sql import SparkSession, functions as F

spark = SparkSession.builder.appName("orders").getOrCreate()

events = spark.read.parquet("s3://lake/events/")   # schema inference reads footers here
net = (events
       .filter(F.col("event_date") >= "2026-01-01")
       .withColumn("net", F.col("amount") - F.col("refund"))
       .groupBy("customer_id")
       .agg(F.sum("net").alias("net_total")))

net.explain()     # analysis and optimisation run; still no job
net.count()       # a job starts here, and only here
```

Two things are worth noticing. First, `filter` and `withColumn` never see a row; they append to
a tree. Second, `spark.read.parquet` *did* touch storage — schema inference lists files and reads
footers before any action, which is why a bad path fails on the `read` line. CSV with
`inferSchema=True` is worse: it reads a sample of rows. Laziness applies to execution, not to
metadata discovery.

Laziness buys two concrete things:

- **Whole-plan optimisation.** The optimizer sees the filter, the projection, the aggregation and
  the write together, so it can push the filter below the join, prune columns the query never
  reads, and skip the shuffle entirely when a join can be broadcast.
- **No intermediate materialisation.** Within a stage, operators are fused into one pass over the
  data. A chain of five `select`/`filter` steps does not write five temporary tables; it writes
  none.

The costs are deferred failures and deferred work. Both are worth the trade, but they change how
you debug: the exception location is the action, not the transformation, and the Spark UI shows
work for jobs you did not consciously start (schema inference on a wide directory can trigger
thousands of file listings).

## What triggers a job

| Call | Job? | Notes |
|---|---|---|
| `df.filter`, `select`, `join`, `withColumn` | no | plan only |
| `df.explain()` | no | analysis + optimisation, no execution |
| `df.schema`, `df.columns` | no | analysis; may hit the catalog or file footers |
| `df.show(n)` | yes | one job, stops after enough partitions |
| `df.count()` | yes | usually scans every row; rarely a metadata shortcut |
| `df.take(n)` / `first()` | yes | tries one partition first, then escalates |
| `df.collect()` / `toPandas()` | yes | brings everything to the driver |
| `df.write.*` | yes | one job, plus one file per task per partition directory |
| `df.cache()` | no | first action populates the cache |

`df.rdd` is a trap door: it converts to RDDs and drops most optimizer information. Each `.rdd`
call also re-evaluates the plan unless the DataFrame is cached.

## Reading a plan

`explain()` prints the physical plan. `explain("formatted")` (3.0+) splits it into sections;
`explain("cost")` (3.2+) adds statistics. Read it bottom-up: scans at the bottom, output at the
top.

```
== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- HashAggregate(keys=[customer_id#12], functions=[sum(net#31)])
   +- Exchange hashpartitioning(customer_id#12, 200), ENSURE_REQUIREMENTS
      +- HashAggregate(keys=[customer_id#12], functions=[partial_sum(net#31)])
         +- Project [customer_id#12, (amount#8 - refund#9) AS net#31]
            +- Filter (event_date#3 >= 2026-01-01)
               +- FileScan parquet [customer_id#12, amount#8, refund#9, event_date#3]
```

`Exchange` is a shuffle. `partial_sum` before it is map-side pre-aggregation, which is why the
shuffle moves one row per customer instead of one row per event. `AdaptiveSparkPlan` means AQE
will re-plan after the shuffle (chapter 8); with `isFinalPlan=false` you are looking at the
pre-execution plan, not what actually ran.

## Where laziness surprises people

- **Exceptions land at the action.** An `AnalysisException: cannot resolve 'cust_id'` appears
  when you run the job, several cells after the typo. Read the plan, not just the traceback.
- **`cache()` does nothing until an action.** Caching after the expensive step and before the
  second action is the pattern; caching and then never reusing is pure overhead.
- **Closures are pickled at task submission.** A Python UDF or `mapPartitions` function captures
  variables by reference at definition time but serialises them when the task is submitted. If
  the driver mutates a captured dict between definition and action, the task may see either
  version depending on scheduling.
- **`foreach` can run more than once.** Task retries and speculative execution re-run side
  effects. Writing to an external system from `foreach` is how duplicate rows appear.
- **Plan depth is real.** A loop of 500 `withColumn` calls builds a 500-node projection tree;
  the driver spends minutes optimising it and can blow the JVM stack. Use one `select` with all
  the expressions, or `localCheckpoint()` to cut lineage.

## Production notes

The driver is a single point of failure and a common bottleneck. Give it memory
(`spark.driver.memory`), keep `spark.driver.maxResultSize` at its 1 GB default unless you have a
reason, and never `collect()` a table you have not first aggregated or limited — the error,
`Total size of serialized results ... is bigger than spark.driver.maxResultSize`, arrives after
the cluster has done all the work.

Python worker startup is not free: importing pandas, numpy or a private wheel on every executor
costs seconds per executor, and a job with thousands of tiny tasks pays that cost repeatedly.
`spark.python.worker.reuse=true` (the default) keeps workers alive across tasks in the same
executor, so the cost is once per executor rather than once per task — another argument for
fewer, larger partitions.

Finally, keep `local[*]` for tests and small development samples, and run production in cluster
mode or through a managed job runner. A job whose driver lives in a notebook dies when the
notebook session does.
