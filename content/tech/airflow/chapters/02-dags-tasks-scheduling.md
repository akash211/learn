# DAGs, Tasks and Scheduling Semantics

A DAG is a Python file that builds a graph at import time. Everything else — the schedule, the
retry policy, the dependencies — is data attached to that graph, and the scheduler acts on the
serialized copy, not on your code. That distinction explains most of the surprising behaviour in
this chapter: what you write is a *template for runs*, and the run is what has a state.

## The shape of a DAG

```python
from datetime import datetime, timedelta

from airflow.sdk import DAG
from airflow.providers.standard.operators.bash import BashOperator

with DAG(
    dag_id="orders_daily",
    start_date=datetime(2025, 1, 1),
    schedule="0 2 * * *",          # 02:00 UTC every day
    catchup=False,
    max_active_runs=1,
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
    tags=["orders", "tier-1"],
) as dag:
    extract = BashOperator(task_id="extract_orders", bash_command="...")
    transform = BashOperator(task_id="transform_orders", bash_command="...")
    load = BashOperator(task_id="load_revenue", bash_command="...")

    extract >> transform >> load
```

`task_id` is the identity of the task for the life of the DAG. Renaming it does not rename
history — it creates a new task and orphans the old one's TaskInstances, which is why renaming
is a migration, not a refactor. The same is true of `dag_id`: it is the primary key for
everything the scheduler knows.

## Scheduling: intervals, not instants

The single most misunderstood concept in Airflow is that a run *covers a period*. With
`schedule="0 2 * * *"`, the run for the interval `2025-03-01T02:00 → 2025-03-02T02:00` becomes
eligible at the **end** of that interval, i.e. at 02:00 on 2 March. Airflow calls the start of
the interval the **logical date** (formerly `execution_date`) and exposes the whole period as
`data_interval_start` / `data_interval_end`.

```python
@task
def extract(data_interval_start=None, data_interval_end=None):
    # 2025-03-01T02:00 .. 2025-03-02T02:00 on the run for 2 March
    return pull_orders(data_interval_start, data_interval_end)
```

This is the "why is my daily job a day behind" question, and the answer is that it is not
behind — it is processing the window that has closed. Templated SQL should filter on
`{{ data_interval_start }}` and `{{ data_interval_end }}` (or `{{ ds }}` for a date), never on
`now()`. A pipeline that reads `current_date` inside its SQL cannot be backfilled, because
re-running yesterday's interval would read today's data.

Airflow 3 changed this default: a cron string now uses `CronTriggerTimetable` unless
`[scheduler] create_cron_data_intervals = True`, so `logical_date` equals `run_after`, a 02:00
daily run is dated the day it runs, and `data_interval_start == data_interval_end`. The interval
model and `data_interval_*` templating still exist; "the run for the 1st starts on the 2nd" is
2.x behaviour, not a universal law.

`schedule` accepts a cron string, a `timedelta`, one of the presets (`@daily`, `@hourly`,
`@once`), `None` for "only when triggered", a `Timetable` subclass, or a list of assets. In
2.x it was `schedule_interval`; that parameter was deprecated in 2.4 and removed in 3.0.

| Value | Meaning |
|---|---|
| `"0 2 * * *"` | Cron, evaluated in the DAG's `timezone` (default UTC) |
| `timedelta(hours=6)` | Fixed interval anchored on `start_date` |
| `None` | Manual, API or asset-triggered only |
| `"@once"` | A single run for the whole history |
| `Timetable` | Custom logic (business days, month-end, market calendar) |

## catchup and backfill

`catchup=True` (the default in 2.x; `[scheduler] catchup_by_default` flips it to `False` in 3.x)
tells the scheduler to create runs for *every* interval between `start_date` and now when a DAG is
first enabled. A daily DAG started in 2020 creates ~2,000 runs in the first scheduler loop, all
competing for slots — a lesson teams learn by setting `start_date` to the company's founding date.

`catchup=False` creates runs only for the most recent closed interval, plus any interval that
closes while the DAG is enabled. It is the right default for anything whose output is a
snapshot rather than a history: dashboards, caches, "current state" tables.

Neither setting is about correctness (that is idempotency's job, chapter 7) but about how much
work appears at once.

Two different recovery tools:

- **Backfill** (`airflow dags backfill -s 2024-01-01 -e 2024-06-30`) creates *new* DagRuns for
  past intervals and runs them under the DAG's normal rules. It respects `max_active_runs`, so
  it is slow by design and safe to leave running. Airflow 3 moves backfills to a separate
  scheduler (`airflow backfill create --dag-id ... --from-date ... --to-date ...`) with its own
  concurrency, which stops a backfill from starving production runs.
- **Clear** (`airflow tasks clear`, or "Clear" in the UI) re-runs *existing* TaskInstances,
  either for one task or recursively downstream. Clearing a task that already succeeded
  re-executes its side effects — the most common way to duplicate a day of data.

`--reset-dagruns` with backfill deletes and recreates existing runs in the range; without it,
already-successful runs are skipped.

## Concurrency, at four levels

| Setting | Scope | Effect |
|---|---|---|
| `[core] parallelism` | Deployment | Total task instances running at once |
| `max_active_tasks` | DAG | Tasks of one DAG running at once (was `concurrency`) |
| `max_active_runs` | DAG | Simultaneous DagRuns of one DAG |
| `pool` + `pool_slots` | Arbitrary group | Shared capacity across DAGs, e.g. `warehouse_load` |

A task can be dependency-ready and still not run because any one of these is saturated. When
diagnosing "stuck", check them in that order, and remember that a `pool_slots=2` task occupies
two slots from a pool whose size is a separate database row (`airflow pools set warehouse_load 8 "..."`).

`depends_on_past=True` requires the *previous* run's instance of this task to have succeeded: how
you serialise a job that must process days in order, and how one failed day blocks a month of
runs. `wait_for_downstream=True` extends the rule to all downstream tasks of the previous run.
Prefer an idempotent task over `depends_on_past` where you can.

## Trigger rules

By default a task runs when all upstream tasks succeeded. The alternatives matter in real
graphs:

| Rule | Runs when |
|---|---|
| `all_success` | Every upstream succeeded (default) |
| `all_failed` | Every upstream failed — for compensating tasks |
| `all_done` | Every upstream finished, whatever the state — cleanup, notifications |
| `one_success` | Any one upstream succeeded |
| `one_failed` | Any one failed — early alerting |
| `none_failed` | All upstreams succeeded or were skipped |
| `none_failed_min_one_success` | Like above, and at least one actually ran — the usual "join after a branch" rule |
| `none_skipped` | No upstream was skipped |
| `always` | Unconditionally |

A branch (`@task.branch`) skips the paths it does not choose. Those skipped tasks propagate
`skipped` downstream, so the join task must use `none_failed_min_one_success` or it will be
skipped too — the most common bug in branching DAGs.

## Task states you will actually see

`none → scheduled → queued → running → success | failed | upstream_failed | skipped | deferred`.
Two states need interpretation: `upstream_failed` means the task never got a chance, so retrying
it alone is pointless; `deferred` means the task released its slot and is waiting on a trigger.
A run in `running` with all tasks terminal is a scheduler bug or a stuck `dagrun_timeout` — check
the run's `end_date` before assuming the pipeline is alive.

## Scheduling latency

The gap between "interval closed" and "task started" is the sum of the scheduler loop
(`scheduler_idle_sleep_time`, 1 s), the parse cycle for that file (`min_file_process_interval`),
queue time in the executor, and worker pickup. Sub-minute is normal; ten minutes is a
configuration problem.

## Common mistakes

- Using `datetime.now()` or `current_date` inside task logic. The run must be a pure function of
  its interval.
- Setting `start_date` in the future and expecting runs to appear when it arrives — they do, but
  only for the interval that closed, and only if catchup allows it.
- Turning catchup off to "fix" a backlog, then discovering the missing partitions never get
  built. Backfill them explicitly.
- Giving a per-minute DAG `retries=3` and `max_active_runs=16` and calling the resulting
  thundering herd a scheduler problem.
- Renaming `task_id`s in place and losing the run history that proved the pipeline worked.

## Production notes

Keep `max_active_runs=1` for anything that writes to the same partition — it is the cheapest
correctness guarantee Airflow offers. Give backfills their own pool, or in 3.x their own
backfill scheduler run, so a six-month rebuild cannot consume the capacity production needs.
And put the logical date in every log line and every idempotency key: when a run fails at
03:00, the first question is always "which interval".
