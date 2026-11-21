# Spark Notebooks and Notebook Orchestration

Spark is the workhorse of Fabric data engineering, and notebooks are how most people drive it.
The mechanics that separate a fast, cheap pipeline from an expensive one are unglamorous:
session start-up, file sizing, partition strategy, and whether your orchestration shares a
session or spawns a new one for every step.

## Sessions, pools and runtimes

A Fabric notebook runs against a **Spark session** on a **pool**. Three pool behaviours matter:

- **Starter pools** are pre-warmed, so a session starts in seconds rather than minutes. They use
  a default node size you do not control.
- **Custom pools** let you pin node size and autoscaling bounds for a workspace, which is how
  you get predictable performance for heavy jobs.
- **High concurrency mode** lets several notebooks share one session, which is efficient for
  interactive work but a poor fit for isolation-sensitive production jobs.

Runtime version is part of your contract. Runtime 1.3 is the long-standing default; newer 2.x
runtimes change library versions and, importantly, change write defaults — V-Order and Optimize
Write were enabled by default in workspaces created before April 2025 and are disabled by
default for newer ones. A pipeline that relied on implicit file compaction can therefore get
slower after a workspace is recreated. Pin the runtime, and set what you depend on explicitly.

```python
spark.conf.set("spark.sql.parquet.vorder.default", "true")
spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")
```

## Writing Delta properly

Fabric defaults `spark.sql.sources.default` to `delta`, so `saveAsTable` gives you a
transactional table without ceremony. Prefer explicit, idempotent writes over appends that
assume a single run:

```python
from delta.tables import DeltaTable

target = DeltaTable.forName(spark, "silver.orders")
(target.alias("t")
  .merge(new_rows.alias("s"), "t.order_id = s.order_id")
  .whenMatchedUpdateAll()
  .whenNotMatchedInsertAll()
  .execute())
```

Then deal with the files. Every merge rewrites Parquet files; micro-batches produce many small
ones. Compaction is not optional at scale:

```sql
OPTIMIZE silver.orders ZORDER BY (customer_id);
VACUUM silver.orders RETAIN 168 HOURS;
```

`OPTIMIZE` rewrites files into healthier sizes and can cluster by columns you filter on.
`VACUUM` removes unreferenced files — but it also destroys time-travel beyond the retention you
set, and it refuses to go below the Delta retention interval without disabling the safety check.
Run both on a schedule, not never, and not after every single write.

Partitioning is the other half. Partition by date on a fact table that is always filtered by
date; do not partition by a high-cardinality ID, which produces a directory per value and
punishes every reader. Target files in the tens-to-low-hundreds of MB range, and let
`OPTIMIZE` fix the rest.

## Orchestration: notebook calls notebook

There are two ways to run a notebook from another notebook, and they behave differently.

```python
# Same session, sequential, returns the value passed to notebookutils.notebook.exit()
rows = notebookutils.notebook.run(
    "nb_silver_orders",
    timeout_seconds=3600,
    arguments={"load_date": "2026-01-15"},
)
print(rows)
```

`notebookutils.notebook.run` executes in the **same** Spark session, so it is cheap to start
and shares cached data — good for a handful of steps, bad for isolation. A failure propagates;
the parent can catch it in Python if you want custom handling.

The pipeline **Notebook activity** is the production alternative: each notebook gets its own
run, visible in the Monitoring hub, with parameters, retries and dependencies. Use it when you
need per-step observability, parallel branches, or different compute per step. Use
`notebookutils.notebook.run` for tight, chatty sub-steps that would be wasteful as separate
sessions.

For fan-out, do not loop in Python on the driver. Either use a pipeline `ForEach` (which
parallelises activities) or a Spark-native construct — a single DataFrame job over all
partitions is almost always better than 200 sequential `notebook.run` calls.

## Medallion in notebooks

A shape that works:

| Layer | Notebook | Write mode | Notes |
|---|---|---|---|
| Bronze | `nb_bronze_<source>` | Append, schema evolution | Keep raw columns, add ingestion timestamp and source file |
| Silver | `nb_silver_<domain>` | Merge on business key | Deduplicate, type, conform, compact |
| Gold | `nb_gold_<mart>` (or T-SQL) | Overwrite partition / merge | Star schema, business measures, ready for Direct Lake |

Pass the load date as a parameter and derive every path from it, so a rerun is a parameter
change rather than a code edit. Write to a staging table and swap, or merge on a key — never
`overwrite` a table that a report is querying at 09:00.

## Common mistakes

- `collect()` on a large DataFrame, which drags every row to the driver and often kills the session.
- Python `for` loops over rows instead of column expressions; the JIT cannot save a driver loop.
- Over-partitioning a small table, producing thousands of tiny files under a directory tree.
- Caching a DataFrame and never unpersisting it, so the cache competes with everything else.
- Assuming a notebook that "ran fine" in interactive mode will behave the same under a pipeline
  with different parameters and concurrency.
- Relying on default V-Order/Optimize Write behaviour that differs between workspace ages.

## Production notes

Parameterise, pin the runtime, and manage libraries through an **Environment** item rather than
`%pip install` in a notebook — installs at runtime are slow and non-reproducible. Keep notebooks
small and single-purpose, put them in Git, and promote them through deployment pipelines.
Finally, check the Spark UI or the run's stage metrics before optimising by intuition: skew,
shuffle and tiny-file reads explain most slow jobs, and each has a different fix.
