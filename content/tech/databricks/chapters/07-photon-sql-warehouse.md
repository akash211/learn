# Photon and the SQL Warehouse Reality

Two things make Databricks SQL feel different from Spark: **Photon**, a vectorised C++ engine that
replaces Spark's row-at-a-time operators, and the **SQL warehouse**, a compute shape built for
concurrent short queries rather than one long batch job. Both are always on for SQL workloads, and
neither is a magic wand.

## What Photon is

Photon is a native execution engine inside Databricks Runtime. It implements scans, filters,
projections, joins, aggregations, shuffles and writes over columnar batches, with the same
DataFrame and SQL surface as Spark. You do not rewrite queries to use it; you enable it on a
cluster, or you use a SQL warehouse where it is the engine.

It is not a different compute model. Photon still runs on the same cluster, reads the same Delta
and Parquet files, and obeys the same partitioning and shuffle mechanics. What changes is the
per-row overhead: vectorised batches, better CPU cache behaviour and native code instead of JVM
objects.

```sql
EXPLAIN EXTENDED SELECT region, sum(amount) FROM prod.gold.orders GROUP BY region;
```

In the plan, Photon operators appear with a `Photon` prefix (`PhotonScan`, `PhotonGroupingAgg`,
`PhotonShuffleExchange`). If a `GroupingAggregate` or `Scan` appears without it, that fragment is
running in the JVM — usually because it involves something Photon does not implement.

## What Photon does not accelerate

- **Python UDFs and `mapPartitions`.** The rows still cross into a Python worker; Photon may speed
  up the surrounding plan, but the UDF remains the cost.
- **RDD code.** `df.rdd` drops out of the vectorised path entirely.
- **Third-party libraries and ML training.** Spark ML and arbitrary JVM/Python libraries run as
  they always did.
- **Tiny queries.** Optimisation and startup can dominate when the data is a few thousand rows.
- **Some write patterns and unusual types.** Coverage improves release over release, so check the
  plan rather than assuming.

Photon also costs more per DBU-hour than the same cluster without it. The trade is only good when
the speed-up exceeds the rate premium on the work you actually run; a UDF-heavy job can pay the
Photon rate for a plan that spends most of its time in Python.

## The SQL warehouse as a product

A SQL warehouse is a compute resource dedicated to SQL: the SQL editor, dashboards, alerts,
JDBC/ODBC clients and BI tools. It has no notebooks attached, no Python, no Scala, no RDDs, and
you do not choose a Spark version or an init script. In exchange it is tuned for many concurrent,
short-running queries.

| Choice | What it changes |
|---|---|
| Warehouse type (serverless / pro / classic) | Startup time, isolation, feature set and DBU rate |
| Size (2X-Small … 4X-Large and beyond) | Compute per query, roughly vertical scaling |
| Min/max clusters | Concurrency, roughly horizontal scaling |
| Auto-stop | Idle cost versus cold-start latency |
| Serverless | No infrastructure to size, seconds to start, per-query billing |

The sizing rule that people get wrong: **size scales a single query, clusters scale concurrent
queries.** A dashboard with twenty parallel queries that each take eight seconds needs more
clusters, not a bigger warehouse. One query scanning a billion rows needs a bigger warehouse, not
more clusters.

Serverless warehouses remove most of the infrastructure decisions but keep the size selector,
because size still determines the compute a query gets. A stopped serverless warehouse has a cold
start measured in seconds, not minutes, which is why aggressive auto-stop is less painful there
than on classic warehouses.

## Concurrency, queues and caching

Each cluster runs a limited number of queries concurrently. Beyond that, queries queue, and queue
time — not execution time — becomes the user-visible latency. Classic and pro warehouses expose
queueing behaviour and query history; serverless scales clusters in response to demand, and newer
workload-management features route or queue queries by size and priority.

**Result caching** returns a previously computed result when the same query runs again and the
underlying tables have not changed. It is the single biggest win for dashboards that refresh on a
timer: the second run costs almost nothing. Two caveats: the cache is scoped to the warehouse (a
different warehouse recomputes), and any write to a referenced table invalidates it — including a
streaming job committing every few seconds.

## The query profile is your Spark UI

On a warehouse you do not get the Spark UI's job and stage pages. The equivalent is the **query
profile**: a operator tree with rows, bytes, time spent, spill, files pruned and shuffle size per
node. Reading it is a different skill from reading a stage table, and it is the only way to answer
"why is this dashboard query slow".

The usual findings, in order of frequency:

1. A scan reading far more files than the predicate should allow — missing statistics, a
   non-clustered filter column, or a function wrapped around the column (`WHERE date_format(d, …)`
   defeats pruning).
2. A shuffle far larger than the output, from a join on a high-cardinality key or a `SELECT *`
   carried too far down the plan.
3. Spill to disk, from an aggregation or join whose state exceeds memory — a bigger warehouse or a
   pre-aggregation fixes it.
4. Time in a UDF or a remote call, which no warehouse size will fix.

## Where the warehouse model breaks

- **Python or Scala work.** Use a notebook on a cluster, or a job; a warehouse cannot run it.
- **Long ETL.** A warehouse can run a big `INSERT`, but it is priced and tuned for interactive
  queries; a job cluster is cheaper and more controllable for a nightly rewrite.
- **Very small, very frequent queries.** Each has overhead; batch them into one statement or
  materialise a table.
- **Direct file access outside Unity Catalog.** Volumes and tables, not arbitrary mounts.
- **Row-level procedural logic.** Loops and cursors belong in a job, not a dashboard query.

## Common mistakes

- **Upsizing the warehouse to fix concurrency.** Vertical scaling shortens one query; it does not add parallel capacity.
- **Adding clusters to fix one slow query.** The opposite mistake, with the same root cause.
- **Auto-stop set to hours.** An idle warehouse is the most common avoidable SQL line item.
- **Assuming Photon will rescue a Python UDF.** The UDF is the bottleneck, not the scan.
- **Wrapping filter columns in functions.** `date_format(ts, …) = '2026-01-01'` prevents pruning; compare ranges instead.
- **One warehouse for BI, ad-hoc and ETL.** One workload's burst starves the others.
- **Ignoring the result cache.** Dashboards that recompute identical aggregates every minute.

## Production notes

Run separate warehouses per workload class: dashboards, ad-hoc analysis, and SQL-heavy ETL. Give
the dashboard warehouse a short auto-stop and enough clusters for its p95 concurrency; give the
ad-hoc warehouse a larger size and a longer stop; keep ETL off both.

Size from evidence. Query history and system tables record duration, queue time, bytes read and
warehouse size, so the p95 queue time tells you whether to add clusters, and the p95 execution time
of a single query tells you whether to add size. Review monthly; BI concurrency grows quietly.

Finally, treat the warehouse as a consumer of good table design, not a fix for bad table design.
Clustering keys, file sizes and statistics decide how much a query reads; the warehouse decides
how fast it reads it. Optimising the second while ignoring the first is how a 4X-Large warehouse
ends up scanning four years of data to render a daily total.
