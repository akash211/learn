# Cost Control and Performance Incident Triage

Two questions dominate the operational life of a Databricks deployment: "why did this cost so
much?" and "why is this slow today?" They share a method. Both are answered by looking at the
same three dimensions — compute shape, bytes touched, and time — and both go wrong when someone
reaches for a bigger cluster before reading a metric.

## How the bill is actually constructed

Databricks bills in **DBUs** (Databricks Units) per hour of compute, multiplied by a rate that
depends on the SKU: all-purpose, jobs, SQL warehouse, serverless, Photon-enabled, and so on. On
top of that you pay the cloud provider for the VMs and storage. The rate is not the same across
SKUs, and the DBU consumption per hour depends on the cluster's size and instance types.

That structure produces four levers, in descending order of effect:

1. **Shape** — run scheduled work on job clusters, BI on SQL warehouses, exploration on
   all-purpose. Paying the all-purpose premium for a nightly job is the most common structural
   waste.
2. **Lifetime** — auto-stop, job clusters, serverless. An idle cluster bills exactly like a busy
   one.
3. **Size** — right-size from measured shuffle and CPU, cap autoscaling, and do not buy a
   40-worker cluster for a job that never fills eight.
4. **Efficiency** — read fewer bytes (clustering, pruning, compaction), avoid Python UDFs where a
   built-in exists, and turn Photon on only where it pays for its rate premium.

A fifth lever is commercial: committed-use or discounted SKUs, negotiated with the account team,
reduce the rate rather than the consumption. That is procurement, not engineering, and it should
not be the answer to a design problem.

## Making cost attributable

Cluster policies enforce tags; tags flow into billing. Without a `team`, `cost_center` or
`project` tag, the bill says a cluster cost money but not who to ask about it.

The billing system table is the queryable source: usage rows by date, SKU, workspace and custom
tags, joinable to a price list to turn DBUs into currency. Compute and query system tables give
the other half — which cluster ran what, and which warehouse served which query.

```sql
SELECT usage_date, sku_name, custom_tags['team'] AS team,
       sum(usage_quantity) AS dbus
FROM system.billing.usage
WHERE usage_date >= current_date() - 30
GROUP BY ALL
ORDER BY dbus DESC
LIMIT 20;
```

Review this monthly with three questions: which SKU grew, which team grew, and which specific
workload accounts for the top ten rows. Most surprises are one workload, not a broad drift.

## The waste patterns that repeat

- All-purpose clusters with auto-stop disabled or set to hours.
- A warehouse sized for the busiest day of the quarter, running all month.
- Development clusters that nobody stopped over the weekend.
- Nightly full refreshes of tables that could be incremental.
- Dashboards running `SELECT *` over unclustered tables, scanning years for a daily number.
- Photon enabled on UDF-heavy jobs, paying the rate for a plan that runs in Python anyway.
- Instance pools kept warm around the clock for a job that runs twice a day.
- Cross-region reads because a catalog and its consumers were placed in different regions.

## Incident triage: the first five minutes

Start with scope, not with the Spark UI. Is one task slow, one job, one warehouse, or everything?
Then ask what changed: a deploy, a data volume jump, a cluster policy edit, a cloud capacity
event, a table rewrite. A job that was fine yesterday and is slow today has a cause that is
usually outside the code.

Then go to the run page. For a job, the task list shows which task is the outlier. For a
warehouse, the query profile. For a notebook, the Spark UI of the attached cluster.

## Reading the Spark UI in the right order

| Tab | Look for | Means |
|---|---|---|
| Stages | max vs median task duration | skew, or one bad partition |
| Stages | spill (memory) / spill (disk) | partition or aggregation state exceeds memory |
| Stages | shuffle read/write, input size | bytes moved; compare with rows |
| Stages | failed tasks, retries | spot loss, OOM, fetch failures |
| SQL | physical plan, `Photon` nodes, AQE final plan | which engine ran, what was pruned |
| Executors | GC time, memory used, disk used | heap pressure, cache eviction |
| Environment | Spark config, libraries | a config drift between clusters |

Two ratios answer most performance questions. **Max task duration divided by median** tells you
whether you have skew. **Shuffle bytes divided by output rows** tells you whether a join or
aggregation is moving far more data than the result requires.

## Gang scheduling and the wait that looks like slowness

Databricks job clusters acquire all requested executors before tasks start — gang scheduling. If
the cloud cannot supply them, the run sits in a pending state, and "the job took 40 minutes" may
be 35 minutes of waiting for capacity and five minutes of work.

Symptoms: tasks pending with no active stages, cluster events showing instance acquisition
failures, or a slow start after raising `max_workers`. Fixes: lower the maximum, allow multiple
instance types, use spot with on-demand fallback, or use a pool for latency-sensitive runs. A
bigger autoscaling range can make startup slower, not faster.

## Spill, skew and memory

**Spill** appears in the stage table as `spill (memory)` and `spill (disk)`. It means an operator
needed more memory than its task had and wrote to disk. The usual causes are too few partitions
after a shuffle, a single huge partition, a `collect_list` over a high-cardinality group, or a
window function without a partitioning clause.

Fixes, in order: let AQE coalesce partitions but not below a sane size; raise
`spark.sql.shuffle.partitions` when a stage processes hundreds of megabytes per task; move to a
memory-optimised instance type if the ratio of memory per core is the constraint; rewrite the
operation when the state is intrinsically large.

**Skew** is not fixed by more workers. One partition is one task. AQE's skew join handling can
split some joins; the alternatives are salting the hot key, broadcasting the small side, or
pre-aggregating before the join.

**Out-of-memory** has two locations and two fixes. Driver OOM comes from `collect()`, `toPandas()`,
a broadcast that is too large, or too many concurrent queries; the fix is to reduce what reaches
the driver, not to add executors. Executor OOM usually comes from partition size or Python worker
memory; the fix is smaller partitions, a larger instance, or `spark.sql.execution.arrow.maxRecordsPerBatch`
for wide Arrow batches.

## Errors that are not performance problems

- `FetchFailedException` after an executor disappears: check for spot reclamation and shuffle
  service health before touching the query.
- `FileNotFoundException` on a Delta read: a concurrent `VACUUM` removed files a long-running
  query still needed.
- `ConcurrentAppendException` / `ConcurrentDeleteReadException`: two writers on the same table;
  fix the schedule or make the writes partition-scoped.
- `InstanceLimitExceeded` or subnet IP exhaustion: cloud quota, not Spark.
- Init script failure: the cluster terminates before Spark starts; read the cluster log, not the
  job log.
- A plan with no `Photon` nodes: the workload fell back to the JVM; check the operator, not the
  cluster size.

## Recovery and prevention

For a bad data write, `RESTORE` the table version if the files survive; if they do not, rebuild
from bronze. For a failed run, use a repair run rather than a full rerun. For a slow run, capture
the stage metrics before changing anything — the next comparison needs a baseline.

Then convert the incident into a control: a duration health rule, a data-volume check that fails
early, a clustering key for the predicate that scanned everything, a policy cap on the worker
count, or a tag that makes the cost visible next month. An incident without a follow-up control is
a rehearsal for the same incident.
