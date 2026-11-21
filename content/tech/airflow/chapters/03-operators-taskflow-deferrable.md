# Operators, TaskFlow and Deferrable Operators

An operator is a class with one meaningful method. Everything Airflow gives you — retries,
templating, logging, state tracking — is machinery around `execute()`. Understanding that keeps
you from treating operators as magic and from writing a custom class when a function would do.

## What an operator is

```python
class BaseOperator:
    template_fields: Sequence[str] = ()      # attributes rendered as Jinja
    template_ext: Sequence[str] = ()         # file extensions rendered as templates
    ui_color = "#fff"

    def execute(self, context): ...          # the work
```

`execute()` receives the **context**: a dictionary of everything the run knows — `ds`,
`data_interval_start`, `dag_run`, `task_instance`, `params`, `var`, `conn`, `ti`. That context is
also what Jinja templating draws from, which is why `{{ ds }}` works inside a `bash_command` and
`{{ ti.xcom_pull(task_ids='extract') }}` works inside a SQL string. Only attributes listed in
`template_fields` are rendered; a custom operator that forgets to declare them will silently pass
`{{ ds }}` through as literal text.

The library is deliberately thin: `BashOperator`, `PythonOperator`, `EmptyOperator` in core; SQL,
cloud, and transfer operators in providers (`apache-airflow-providers-*`). A provider operator
is almost always a thin shell over a **hook**, which owns the connection and the client. That
split — operator = task semantics, hook = system access — is the reason you can test a hook
without Airflow running at all.

## TaskFlow: tasks as functions

```python
from airflow.sdk import dag, task

@dag(schedule="0 2 * * *", start_date=datetime(2025, 1, 1), catchup=False)
def orders_daily():
    @task
    def extract(data_interval_start=None) -> dict:
        return {"path": f"s3://orders/{data_interval_start:%Y-%m-%d}/", "rows": 120_000}

    @task(multiple_outputs=True)
    def validate(manifest: dict) -> dict:
        return {"ok": manifest["rows"] > 0, "path": manifest["path"]}

    @task.branch
    def route(ok: bool) -> str:
        return "load_revenue" if ok else "notify_empty"

    manifest = extract()
    checked = validate(manifest)          # passing the output creates the dependency
    route(checked["ok"])

orders_daily()
```

Three things happen implicitly: the return value is pushed as an XCom, passing an `XComArg` into
another task creates the edge, and the function signature becomes the argument list. `@task`
also accepts `.override(task_id=..., retries=..., pool=...)` for per-task configuration, and
`@task.branch`, `@task.short_circuit`, `@task.sensor`, `@task.kubernetes` cover the common
control-flow and placement shapes.

| | Classic operator | TaskFlow `@task` |
|---|---|---|
| Unit of work | Class with `execute()` | Plain Python function |
| Data passing | Explicit `xcom_pull` | Implicit `XComArg`, still XCom underneath |
| Templating | `template_fields` on the class | Jinja works in strings *inside* the function only if you render them |
| Configurability | Everything is a constructor argument | `.override(...)`, `@task(...)` |
| Best for | Anything with a provider (SQL, S3, Kubernetes) | Python logic, glue, small transforms |

They compose: `load(transform_output)` where `load` is a classic operator works, because
`Operator.output` is an `XComArg`. Do not rewrite a provider operator as a `@task` that
instantiates the hook by hand — you lose retries on connection errors, templating, and the
provider's own deferrable mode.

## Templating in practice

```python
BashOperator(
    task_id="load_revenue",
    bash_command="python load.py --date {{ ds }} --end {{ data_interval_end | ts }}",
)
SQLExecuteQueryOperator(
    task_id="merge_revenue",
    conn_id="warehouse",
    sql="sql/merge_revenue.sql",       # template_ext renders the file
)
```

`render_template_as_native_obj=True` (DAG-level) makes Jinja return Python objects rather than
strings, so `{{ params.columns }}` can be a list. `params` is the safe way to pass per-DAG
configuration that operators and templates both see; `dag_run.conf` is the equivalent for a
single manual or API-triggered run, and `{{ dag_run.conf.get('date', ds) }}` is the standard
"reprocess one day" idiom.

## Deferrable operators

A normal sensor occupies a worker slot while it waits. A deferrable operator suspends itself:
it raises a `TaskDeferred`, the scheduler marks the task `deferred`, the slot is released, and a
coroutine in the **triggerer** process polls until it fires an event, at which point the task is
rescheduled and resumes in `execute_complete()`.

```python
class WaitForPartition(BaseTrigger):
    def __init__(self, table: str, partition: str):
        super().__init__()
        self.table, self.partition = table, partition

    def serialize(self):
        return ("my_dags.triggers.WaitForPartition", {"table": self.table, "partition": self.partition})

    async def run(self):
        while True:
            if await partition_exists(self.table, self.partition):
                yield TriggerEvent({"partition": self.partition})
                return
            await asyncio.sleep(30)


class PartitionSensor(BaseOperator):
    def execute(self, context):
        self.defer(
            trigger=WaitForPartition(self.table, context["ds"]),
            method_name="execute_complete",
            timeout=timedelta(hours=6),
        )

    def execute_complete(self, context, event):
        return event["partition"]
```

`serialize()` must be importable and side-effect free — the triggerer reconstructs the object in
a different process, often a different pod.

The migration ladder for an existing sensor is: `mode="poke"` (holds a slot, default) →
`mode="reschedule"` (releases the slot between pokes but still wakes on the scheduler's
schedule) → deferrable (releases the task entirely, resumes within seconds). Most provider
sensors in 2.x accept `deferrable=True`; in 3.x many are deferrable by default.

When deferring does **not** help:

- **The wait is CPU or IO you control.** Deferral only parks the task; the actual work still
  needs a worker.
- **The triggerer is undersized or dead.** Deferred tasks wait indefinitely, and unlike a
  sensor timeout there is no slot pressure to make anyone notice. Alert on
  `[triggerer] default_capacity` and on the count of tasks in `deferred` older than an hour.
- **The check is cheap and the wait is short.** A 20-second poll on a `LocalExecutor` is not
  worth a new process to maintain.

Deferrable operators are the single biggest capacity win for sensor-heavy DAGs: fifty sensors
holding slots for six hours each consume fifty slots on a Celery cluster and roughly nothing on a
triggerer. That is the whole argument, and it is why "replace the sensor fleet" is usually the
first optimisation in a mature deployment.

## Choosing a shape

| Need | Use |
|---|---|
| Talk to an external system | Provider operator or hook |
| Glue between systems, small transforms | `@task` |
| Branch on data | `@task.branch` + `none_failed_min_one_success` join |
| Wait for a condition | Deferrable sensor, else `mode="reschedule"` |
| Reusable logic with templated fields | Custom `BaseOperator` subclass |
| Container image or arbitrary runtime | `KubernetesPodOperator`, `DockerOperator` |

## Common mistakes

- Treating `execute()` as the only place errors can happen: templating, `pre_execute` and
  `post_execute` also fail, and they fail *before* your retry logic sees a clean task.
- Building a custom operator that opens a connection per call without closing it.
- Using `@task` for a provider capability and hand-rolling auth, pagination and retries.
- Returning a DataFrame from a `@task` and discovering it in the XCom table (chapter 4).
- Assuming a deferrable sensor has a default timeout. Pass `timeout=` explicitly.

## Production notes

Pin provider versions independently of core — they release far more often — and read the
provider changelog before a minor bump. Keep custom operators in a small internal package with
tests, not in the DAG folder, so parsing stays cheap. And prefer many small tasks over one
monolithic `@task` that "does the pipeline": Airflow's retry, visibility and parallelism all
operate at task granularity, and a 40-minute function gives you none of them.
