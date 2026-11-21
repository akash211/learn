# Notebooks, Repos and the Development Workflow

The notebook is Databricks' defining interface, and it is also where most teams accumulate
technical debt. A notebook is excellent for exploration and terrible as the only home of
production logic: cells run out of order, state hides in globals, and the diff between two
versions is a JSON blob unless you use Repos.

The mature pattern is boring and works: notebooks orchestrate, modules compute, Git holds the
truth, and a bundle deploys.

## What a notebook actually is

A notebook is a document of cells, each with a language and an optional title. The kernel keeps
one session per language, and the session is shared across cells — which is exactly why running
cells out of order produces results that cannot be reproduced.

| Magic | Effect |
|---|---|
| `%python`, `%sql`, `%scala`, `%r` | Switch the language of a cell |
| `%md` | Markdown cell |
| `%sh` | Shell command on the driver node |
| `%run ./path` | Execute another notebook inline, in the same session |
| `%pip install` | Install into the notebook's Python environment; requires a restart |
| `%fs` | Shortcut for `dbutils.fs` operations |

`dbutils` is the platform API surface inside a notebook: `dbutils.fs` for file operations,
`dbutils.secrets` for secret scopes, `dbutils.widgets` for parameters, `dbutils.notebook` for
returning values and calling other notebooks, and `dbutils.jobs.taskValues` for passing state
between tasks in a job.

```python
dbutils.widgets.text("run_date", "", "Run date (YYYY-MM-DD)")
run_date = dbutils.widgets.get("run_date") or "2026-01-01"

token = dbutils.secrets.get(scope="prod-api", key="token")  # prints as [REDACTED]
```

That redaction is a real control, not a convenience: printing the variable does not leak the
secret, but passing it to an HTTP call that logs its headers does.

## Repos make notebooks reviewable

A notebook stored in a Git folder is a text file, not a binary. Databricks writes it in source
format:

```python
# Databricks notebook source
# MAGIC %md
# MAGIC # Daily orders load

# COMMAND ----------

from my_package.transforms import clean_orders

df = clean_orders(spark.table("bronze.orders"), run_date)
df.write.mode("overwrite").saveAsTable("silver.orders_daily")
```

Because it is a `.py` file with comment markers, code review, `grep`, linting and blame all work.
The `# MAGIC` prefix marks notebook-specific lines so the file remains valid Python; `# COMMAND
---------` separates cells.

Repos add a per-user checkout: each user clones the repo into their own workspace folder and
commits back through a branch. Production jobs should not run from a user's checkout — they
should run from a deployed bundle or a tagged release, otherwise a pull request merge is a silent
production deployment.

## Bundles: the deployment unit

Databricks Asset Bundles describe jobs, pipelines, schemas and dashboards as YAML, with targets
for each environment:

```yaml
bundle:
  name: orders-pipeline

variables:
  catalog:
    default: dev

resources:
  jobs:
    orders_daily:
      name: orders-daily-${bundle.target}
      schedule:
        quartz_cron_expression: "0 15 2 * * ?"
        timezone_id: Europe/London
      job_clusters:
        - job_cluster_key: main
          new_cluster:
            spark_version: 15.4.x-scala2.12
            node_type_id: m5.2xlarge
            autoscale: { min_workers: 2, max_workers: 8 }
      tasks:
        - task_key: bronze
          job_cluster_key: main
          notebook_task:
            notebook_path: ./src/bronze_orders.py
        - task_key: silver
          depends_on: [{ task_key: bronze }]
          job_cluster_key: main
          notebook_task:
            notebook_path: ./src/silver_orders.py

targets:
  dev:
    workspace:
      host: https://dev.cloud.databricks.com
    variables: { catalog: dev }
  prod:
    workspace:
      host: https://prod.cloud.databricks.com
    variables: { catalog: prod }
```

`databricks bundle validate` catches schema errors, missing files and unresolved variables;
`databricks bundle deploy -t prod` creates or updates the resources; `bundle run` triggers a run.
The bundle is the artefact, the job definition is generated from it, and nobody edits the job in
the UI.

## The workflow that survives an audit

1. **Branch** in Git; edit the notebook or module in a Repo checkout.
2. **Unit-test** the transformation functions. Keep them in plain Python modules under `src/`
   with no `spark` global and no `dbutils`, so `pytest` can run them locally with a small Spark
   session or Databricks Connect.
3. **Open a pull request.** CI runs lint, tests and `bundle validate`. Reviewers see a normal diff.
4. **Deploy to staging** on merge, run integration tests against a staging catalog with production-
   shaped data.
5. **Promote to production** by deploying the same commit with the `prod` target, under a service
   principal, not a person's account.

The discipline that makes this work is keeping business logic out of notebooks. A notebook that
contains a 200-line `MERGE` is untestable; a notebook that calls `merge_customers(spark, df)` and
writes the result is testable, reviewable and portable.

## Passing values between tasks

A multi-task job needs to hand a run date, a file count or a resolved path from one task to the
next. Two mechanisms cover most cases. **Job parameters** are declared on the job and referenced
with `{{job.parameters.name}}`; **task values** are written by a task and read by its downstream
dependents:

```python
dbutils.jobs.taskValues.set(key="row_count", value=df.count())
rows = dbutils.jobs.taskValues.get(taskKey="bronze", key="row_count", default=0)
```

Task values are small scalars, not DataFrames. They are the correct way to branch a job (skip
silver if bronze loaded zero rows) and the wrong way to move data — that is what tables are for.
Both mechanisms are resolved by the scheduler at run time, so a notebook run manually outside the
job will not have them, which is why defaults matter in development.

## Environments without separate clusters

Development and production usually share a metastore, so separation has to come from names. A
common layout is one catalog per environment, with developer sandboxes as `dev_<username>` schemas
created on demand and dropped by a cleanup job. The important properties are that a dev job cannot
write a production table by accident, and that a production job's identity is a service principal
with grants only on production objects.

## Common mistakes

- **`%run` chains as a module system.** `%run` injects everything into the current namespace; a name collision silently shadows a variable, and the dependency graph is invisible.
- **Editing production notebooks in the UI.** The change exists only in that workspace, has no review, and disappears at the next deploy.
- **Notebook-scoped `%pip install` in production.** The job restarts Python on every run, and the version is not pinned anywhere.
- **Sharing one catalog between dev and prod.** A typo in a table name overwrites yesterday's gold table.
- **`display()` on raw PII.** Results render for whoever opens the run page.
- **Long-lived all-purpose clusters for CI.** Slow, expensive and stateful; use job clusters or serverless.
- **No test data strategy.** Tests that read production tables are either slow, flaky or a compliance problem.

## Production notes

Treat the repository as the source of truth and the workspace as a runtime. Pin the runtime
version in the bundle, pin library versions, and let Renovate-style updates open pull requests
rather than changing a cluster in place.

Keep notebooks thin: parameter parsing, a call into a tested function, a write, a return value via
`dbutils.notebook.exit`. Anything longer belongs in `src/`. For local development, Databricks
Connect gives you the same DataFrame API against a remote cluster from an IDE, which is often a
better editing experience than the notebook UI and makes debugging with a real debugger possible.

Finally, decide where secrets live once. Secret scopes backed by a cloud key vault, referenced by
name in code, with the scope granted to a service principal — not tokens pasted into a notebook,
not credentials in a bundle's plain-text variables.
