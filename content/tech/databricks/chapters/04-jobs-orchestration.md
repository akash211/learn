# Jobs, Multi-Task DAGs and Orchestration

A Databricks **job** is a saved definition: a graph of tasks, a trigger, a compute choice and a
notification policy. A **run** is one execution of that definition, with its own state, parameters
and task-level results. The distinction sounds pedantic until an incident: "the job failed" almost
always means one task in one run failed, and repairing the run is not the same as rerunning the job.

Jobs are good enough to replace a scheduler for pipelines that live entirely inside the platform.
They are not a general orchestrator, and knowing where the boundary sits saves a migration later.

## Anatomy of a multi-task job

| Element | What it controls |
|---|---|
| Task | One unit of work: notebook, Python script/wheel, JAR, SQL, dbt, pipeline, or another job |
| `depends_on` | Which tasks must finish first; this is the DAG edge |
| `run_if` | Whether a task runs given upstream outcomes (`ALL_SUCCESS`, `AT_LEAST_ONE_SUCCESS`, `ALL_DONE`, `NONE_FAILED`) |
| Job cluster | One cluster shared by all tasks; started once, used by many |
| Task cluster | A dedicated cluster for one task, for heterogeneous needs |
| `max_concurrent_runs` | How many runs of the job may overlap |
| `timeout_seconds` | Hard ceiling on a run |
| Retry policy | Task-level attempts and interval between them |

A typical pipeline has a bronze task, several silver tasks that depend on it, and gold tasks that
depend on the silver set. Tasks without a dependency between them run in parallel automatically —
the graph, not a list, decides concurrency.

```json
{
  "name": "orders-daily",
  "max_concurrent_runs": 1,
  "timeout_seconds": 10800,
  "schedule": { "quartz_cron_expression": "0 15 2 * * ?", "timezone_id": "Europe/London" },
  "job_clusters": [{
    "job_cluster_key": "main",
    "new_cluster": {
      "spark_version": "15.4.x-scala2.12",
      "node_type_id": "m5.2xlarge",
      "autoscale": { "min_workers": 2, "max_workers": 8 }
    }
  }],
  "tasks": [
    { "task_key": "bronze", "job_cluster_key": "main",
      "notebook_task": { "notebook_path": "/Repos/prod/orders/src/bronze" },
      "retry_on_timeout": true, "max_retries": 2, "min_retry_interval_millis": 60000 },
    { "task_key": "silver", "job_cluster_key": "main", "depends_on": [{ "task_key": "bronze" }],
      "run_if": "ALL_SUCCESS",
      "notebook_task": { "notebook_path": "/Repos/prod/orders/src/silver" } },
    { "task_key": "quality_gate", "depends_on": [{ "task_key": "silver" }],
      "condition_task": { "op": "GREATER_THAN",
        "left": "{{tasks.silver.values.row_count}}", "right": "0" } },
    { "task_key": "gold", "depends_on": [{ "task_key": "quality_gate", "outcome": "true" }],
      "job_cluster_key": "main",
      "notebook_task": { "notebook_path": "/Repos/prod/orders/src/gold" } }
  ],
  "email_notifications": { "on_failure": ["data-oncall@example.com"] }
}
```

Two details in that snippet carry most of the operational value. The `condition_task` turns a row
count into a branch, so an empty source does not overwrite a good gold table. The `run_if` on gold
names the outcome it needs, rather than relying on the default success semantics.

## Triggers

- **Scheduled** — Quartz cron with an explicit timezone. Set the timezone deliberately; a job
  authored in UTC and scheduled in local time shifts by an hour twice a year.
- **File arrival** — watches a storage path and fires when new files appear, with a configurable
  wait after the last change so a multi-file drop is processed as one batch.
- **Table update** — fires when specified Unity Catalog tables receive a commit. Useful for
  chains of jobs, but it can also create a trigger storm if an upstream job writes in small
  increments.
- **Continuous** — keeps a run alive and processes work as it arrives; for streaming pipelines,
  not for batch.
- **Manual** — the default, and the right choice while a DAG is being tested.

A paused trigger is not the same as a deleted one: pausing keeps the definition and history, which
is what you want during an incident freeze.

## Retries, repairs and idempotency

Task retries are cheap to enable and dangerous without idempotent writes. A retried task re-runs
the same code against a table that may already contain the first attempt's output. If the write is
`INSERT INTO`, the retry duplicates rows; if it is `MERGE` on a natural key or an overwrite scoped
to the run's partition (`replaceWhere`), the retry converges.

**Repair run** re-executes only the failed and downstream tasks of a finished run, reusing the
successful upstream results. It is the correct response to a transient failure in task four of
ten, and it is much cheaper than a full rerun. It is not a fix for a logic error: repairing with
the same broken code reproduces the failure.

Set `max_concurrent_runs` deliberately. A high value lets a slow run overlap the next schedule,
which is sometimes what you want for independent partitions and usually what you do not want for a
job that overwrites the same table. The second run will either queue, conflict, or silently
produce a last-writer-wins result depending on the table and operation.

## Alerting that people trust

Three layers, in increasing order of usefulness:

1. **Notifications** on start, success, failure and duration threshold, by email or webhook to
   Slack, Teams or PagerDuty.
2. **Health rules** on the run: duration, streaming backlog, rows processed. A rule that fires
   when a run exceeds twice its usual duration catches the slow degradation that a failure alert
   never sees.
3. **System tables** for history: job run timelines and task durations, queryable with SQL. This
   is where you compute "which jobs failed most this month" or "which job is getting slower",
   rather than scrolling the UI.

Alert on symptoms that require action. A channel that receives every successful run is a channel
nobody reads, and the one real failure scrolls past.

## Jobs versus an external orchestrator

| Need | Databricks Jobs | Airflow / Dagster |
|---|---|---|
| Spark and SQL tasks inside Databricks | Native, no extra infrastructure | Via operator, more moving parts |
| Cross-system dependencies (API, dbt, on-prem) | Limited | Core strength |
| Backfills and parameterised reruns | Repair runs, run-now with params | Mature backfill semantics |
| Versioned DAG as code | Bundles, Terraform | Python DAG files |
| Alerting and SLAs | Basic, improving | Rich plugins and SLA misses |

The common architecture is a hybrid: Airflow triggers the Databricks job and owns cross-system
ordering, while the job owns the internal DAG. What you should avoid is splitting one logical
pipeline across both — half the dependencies in Airflow and half in the job graph makes failures
hard to trace and backfills ambiguous.

## Common mistakes

- **A single notebook task containing the whole pipeline.** No parallelism, no per-step retries, no visibility.
- **`INSERT INTO` in a retried task.** Duplicates on the second attempt.
- **No timeout.** A hung task holds the cluster and the run slot indefinitely.
- **Overlapping runs writing the same table.** Delta conflicts at best, last-writer-wins at worst.
- **File-arrival trigger with no wait window.** Ten files produce ten runs.
- **Alerts only on failure.** Duration regressions and zero-row loads pass silently.
- **Parameters in the notebook instead of the job.** Backfills become manual edits.

## Production notes

Deploy jobs from a bundle or Terraform, not by hand, and give production runs a service principal
identity so a departing employee does not take the schedule with them. Keep task granularity at
the level you would want to retry: one task per table or per external call, not one per SQL
statement.

Make every write idempotent before enabling retries, and prefer `replaceWhere` or `MERGE` over a
blind overwrite. Record the run id and start time as columns in the target table — when two runs
disagree about yesterday's numbers, those columns answer the question in seconds.

Finally, test the failure path. Force a task to fail in staging and confirm that the notification
arrives, the downstream tasks skip rather than run on bad data, and the repair run does what you
expect. A DAG that has only ever succeeded is a DAG whose error handling is unverified.
