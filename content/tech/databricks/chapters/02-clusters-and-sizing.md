# Cluster Types, Access Modes and Sizing

Databricks sells compute in four shapes, and choosing the wrong one is the most common source of
avoidable spend. They differ in who can attach to them, how long they live, what they can run and
what you pay per hour — not in the Spark version underneath.

## The four shapes

| Shape | Lifetime | Who attaches | Runs | Relative cost |
|---|---|---|---|---|
| All-purpose cluster | Hours to days, auto-stop | People, notebooks, ad-hoc jobs | Python, SQL, Scala, R | Highest DBU rate |
| Job cluster | One run, then gone | Nobody; owned by the job | Any task type | Lower DBU rate |
| SQL warehouse | Auto-stop, shared | BI tools, SQL editor, JDBC/ODBC | SQL only | Per-size DBU rate |
| Serverless | Per request | Notebooks, jobs, pipelines | Supported subset | Per-workload SKU |

The cost difference between an all-purpose and a job cluster is not a rounding error: the
all-purpose SKU carries a premium for interactivity. A nightly job that runs on an all-purpose
cluster because "it was already there" is paying that premium for a UI nobody is looking at. The
converse is also true — keeping a job cluster alive between runs is not possible, so an
interactive exploration loop belongs on an all-purpose cluster with an aggressive auto-stop.

**Auto-termination** is the single most effective setting on an all-purpose cluster. The default
is a couple of hours of inactivity, and teams that raise it to "until someone remembers" fund a
fleet of idle drivers. Set it to something short, and let job clusters cover scheduled work.

## Access modes and Unity Catalog

Since Unity Catalog became the default catalog, cluster creation asks for an **access mode**
rather than the older "standard / high concurrency" split:

- **Single user** — one principal, full language support, the right choice for job clusters and
  personal work.
- **Shared** — multiple users, isolation between them, but a restricted feature set: Scala is not
  supported, and some library and RDD patterns are unavailable.
- **Custom** — for specific workloads that need capabilities shared mode does not expose, with
  the isolation guarantees you configure.

Access mode is not cosmetic. A shared cluster cannot run the Scala notebook that a team wrote on
a single-user cluster, and a cluster without Unity Catalog configured cannot read governed tables
by three-part name at all. When a table "does not exist" on one cluster and exists on another,
check the access mode and the catalog binding before checking the path.

## Sizing, properly

A cluster has one driver and N workers. The driver holds the Spark context, the query plans, the
DAG scheduler and any result you collect; workers run tasks. Sizing mistakes split into two
families: too little parallelism, and too much cluster for a job that cannot use it.

Rough starting points that survive contact with real workloads:

- **Workers**: start with 4–8, each with 4–8 cores. A 40-core cluster is a reasonable default for
  a mid-size batch job; 400 cores is a decision that needs a measurement behind it.
- **Driver**: same instance type as workers is fine for most jobs. Bump it when you broadcast large
  tables, run many concurrent queries or collect results — not to fix executor OOM.
- **Memory per core**: 4–8 GB per core is a sane ratio for shuffle-heavy work; memory-optimised
  families help caching and large joins, compute-optimised families help scan-heavy SQL.
- **Autoscaling**: set a minimum that covers steady-state load and a maximum you can afford at
  peak. Autoscaling reacts in minutes, so a job whose demand spikes in seconds will finish before
  the cluster grows; and it cannot fix skew, because the hot partition still lands on one task.

Autoscaling also does not reduce the cost of a job that is already running — it changes how many
workers exist during the run. For scheduled batch, a fixed cluster sized from the previous run's
metrics is often cheaper and more predictable than a wide autoscaling range.

## Spot, on-demand and pools

Spot or preemptible VMs cost a fraction of on-demand and can be reclaimed with little warning.
The practical pattern is:

- Workers on **spot with fallback** to on-demand, so a capacity crunch slows the job rather than
  killing it.
- Driver on **on-demand**. A reclaimed driver ends the run; the saving is not worth the restart.
- Streaming jobs on on-demand, or on spot only if the source is replayable and the restart cost
  is acceptable. A reclaimed executor in a stateful streaming query costs a batch reprocess, not
  just a retried task.

**Instance pools** keep idle VMs warm so clusters start in seconds instead of minutes. They are
worth it for interactive clusters with a predictable morning start and for pipelines with many
short jobs. They are a trap when the pool idles all night: you pay for the idle instances, which
is precisely the cost the pool was meant to avoid. Size pools to observed concurrent demand, not
to the maximum you have ever needed.

## Cluster policies as the real control

A cluster policy is a JSON template that constrains what users can create: allowed node types,
maximum workers, spot percentage, auto-termination ceiling, required tags, whether Photon is on.
Policies are how a platform team makes the cheap choice the easy one.

```json
{
  "name": "team-analytics-batch",
  "definition": {
    "node_type_id": { "type": "allowlist", "values": ["m5.2xlarge", "m5.4xlarge"] },
    "autoscale.max_workers": { "type": "range", "maxValue": 20, "defaultValue": 8 },
    "autotermination_minutes": { "type": "fixed", "value": 30 },
    "aws_attributes.availability": { "type": "fixed", "value": "SPOT_WITH_FALLBACK" },
    "custom_tags.team": { "type": "fixed", "value": "analytics" }
  }
}
```

The tags matter as much as the limits. Without a `team` or `cost_center` tag, the billing system
tables can tell you a cluster cost money but not who to ask about it.

## Libraries, init scripts and images

Three mechanisms install code on a cluster, and they fail differently:

- **Notebook-scoped libraries** (`%pip install`) apply to one notebook session and need a Python
  restart. Good for experiments, wrong for production.
- **Cluster libraries** apply to the whole cluster and are installed at start; a bad version breaks
  every notebook on it.
- **Init scripts** run as root at startup. They are powerful and a common cause of "cluster failed
  to start", because a failing script terminates the cluster before Spark ever launches.

For production, pin versions and prefer a container image or a cluster library list checked into
the repository over a `%pip install` buried in cell three.

## Common mistakes

- **One giant all-purpose cluster for the whole team.** Noisy neighbours, no cost attribution, and one bad library upgrade breaks everyone.
- **Job clusters for interactive work.** You cannot attach a notebook, so people work around it by editing the job.
- **Autoscaling as a cure for skew.** The hot partition remains a single task on a single core.
- **Spot drivers to save money.** The run restarts from the beginning.
- **No auto-termination on interactive clusters.** The most common line item in a Databricks bill.
- **A 40-worker cluster for a 2 GB file.** Startup and shuffle overhead dominate; one node would be faster.
- **Sizing the driver like an afterthought.** Broadcasts, `collect()` and hundreds of concurrent queries all live there.

## Production notes

Measure before resizing: the Spark UI's stage table gives shuffle read/write, spill and task
duration distributions, which tell you whether the cluster is CPU-bound, memory-bound or waiting
on a shuffle. If tasks are uniform and each takes 30 seconds, add workers or reduce partition
count; if a handful take ten minutes, the problem is skew and more workers will not help.

Keep a small set of policies (interactive, batch, streaming, ML) instead of per-team snowflakes,
and make the default policy the safe one so a new user gets a sane cluster without reading docs.
Finally, separate the question "is this cluster the right size?" from "is this job written well?"
Most "we need a bigger cluster" requests are a join order, a missing filter or a partition layout
problem wearing a costume.
