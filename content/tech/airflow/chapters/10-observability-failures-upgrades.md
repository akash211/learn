# Observability, Production Failures and Upgrades

Airflow fails in a small number of recognisable ways, and almost all of them are visible in four
signals: scheduler heartbeat age, queued-task count, parse time, and metadata database size. Learn
those four and most incidents stop being mysteries.

## What to instrument

| Signal | Where | Why it matters |
|---|---|---|
| Scheduler heartbeat | `airflow jobs check --job-type SchedulerJob`, `scheduler_heartbeat` metric | A dead scheduler schedules nothing and raises no task-level alert |
| Queued tasks / open slots | `executor.queued_tasks`, `executor.open_slots`, `pool.queued_slots` | Distinguishes "fleet full" from "routing broken" |
| Parse time and import errors | `dag_processing.total_parse_time`, `dag_processing.import_errors` | The leading indicator of everything degrading |
| Database size and growth | `pg_database_size`, row counts of `task_instance`, `dag_run`, `xcom`, `log` | The slowest and most common cause of scheduler latency |
| Run-level success | "no successful run for N intervals" per DAG | Catches failures callbacks miss, including not-scheduled |
| Triggerer capacity | deferred task count, triggerer heartbeat | Deferred tasks fail silently, by waiting |

Health endpoints: `/health` on the API server or webserver, plus liveness/readiness probes built on
`airflow jobs check` for the scheduler and triggerer. A pod that is running but not heartbeating is
the failure mode Kubernetes will not notice for you — `[scheduler] scheduler_health_check_threshold`
(30 s default) is what turns a stuck scheduler into a failed health check.

Task-level observability: keep logs where you can query them. Remote logging
(`[logging] remote_logging = True` with `remote_base_log_folder` on S3/GCS) is not optional on
Kubernetes, where pods are deleted after the task finishes and the local log goes with them. In 3.x,
OpenTelemetry tracing (`[traces] otel_on`, an OTLP endpoint) gives per-task spans, which is the
first real answer to "which task spent 20 minutes in the connection pool".

Useful commands when you are in it:

```bash
airflow dags list-runs -d orders_daily --state failed
airflow tasks states-for-dag-run orders_daily manual__2025-03-01T02:00:00+00:00
airflow tasks logs orders_daily extract_orders 2025-03-01 --map-index 3
airflow dags report                  # import errors, paused DAGs, warnings
airflow db clean --clean-before-timestamp 2024-09-01 --tables task_instance,dag_run,log,xcom --dry-run
```

`--dry-run` first. Deleting history is the one operation with no undo, and `db clean` on a large
table takes locks worth scheduling deliberately.

## The failure catalogue

| Symptom | Usual cause | First check |
|---|---|---|
| DAG missing from the UI | Import error, file outside `dags_folder`, not mounted in the DAG processor, duplicate `dag_id` | `airflow dags list-import-errors`, `airflow dags report` |
| Everything `queued`, nothing running | No worker on that queue, pool exhausted, `parallelism` reached, broker down | `pool.queued_slots`, worker logs, executor slots |
| Tasks stuck `running` forever | Worker died without heartbeat, task hung in a socket, zombie detection threshold raised too high | `scheduler_zombie_task_threshold`, worker pod events |
| Scheduler slow, UI slow | Metadata database bloat, too many DAG files, expensive parse-time code | Row counts, `total_parse_time`, slow query log |
| Duplicate data for one day | A clear plus a retry plus a backfill, on a non-idempotent task | `dag_run` list for the interval, task audit log |
| `Scheduler heartbeat got stuck` | Long DB transaction, lock contention, undersized database | `pg_stat_activity`, `scheduler.critical_section_duration` |
| `WorkerLostError` / `Killed externally` | OOM kill in a Celery worker or pod | Container memory limits, task memory profile |
| Celery tasks never picked up | Message on a queue no worker consumes, result backend misconfigured | `celery -A airflow.executors.celery_executor inspect active_queues` |
| Deferred tasks never resume | Triggerer down, trigger raised in `serialize()`, capacity exhausted | Triggerer logs, deferred count |
| Backfill starves production | Shared pools and `max_active_runs` | Backfill pool, or 3.x backfill scheduler |
| Kubernetes pods stuck `Pending` | Unschedulable resource requests, image pull failure, quota | `kubectl describe pod` |

The single most valuable habit: when a task fails, read the *state history* before the log. A task
that went `queued → running → up_for_retry → running → failed` is a different incident from one
that went `scheduled → upstream_failed`. The UI's task instance details, or `airflow tasks
states-for-dag-run`, gives you that in one screen.

## Upgrading

Airflow's minor versions (2.9 → 2.10) are routine; major versions are migrations. The 2.x → 3.x
path, realistically:

1. **Get to 2.10.x first.** 2.10 is the last 2.x feature line and the supported bridge. Fix
   deprecation warnings there, where the blast radius is small.
2. **Inventory what 3.0 removes.** `schedule_interval` (use `schedule`), `execution_date` (use
   `logical_date`), SubDAGs (use `TaskGroup`s or mapping), core operators moved to
   `apache-airflow-providers-standard`, `airflow.datasets` renamed to assets, and a long tail of
   config keys — `airflow config lint` finds the ones in your `airflow.cfg`.
3. **Pin everything.** Airflow version plus a constraints file plus provider versions. Providers
   release weekly; an unpinned provider is an unplanned upgrade.
4. **Migrate the database on a copy first.** `airflow db migrate` (2.x: `airflow db upgrade`)
   rewrites large tables — on millions of `task_instance` rows this is minutes to hours, and it is
   not reversible. Time it on a restore, then schedule the window.
5. **Upgrade all components together.** Schedulers, workers, API server and triggerer must run the
   same version. There is no rolling upgrade across majors: run old and new in parallel against
   separate databases, or accept a short outage.
6. **Re-run the test suite and `dag.test()` in staging**, with the production image and the
   production `airflow.cfg`. Most 3.0 breakage is import-time, so the structure tests from chapter 9
   catch a surprising amount.

Managed services change the mechanics, not the work: MWAA and Composer upgrade by environment
version, so you either upgrade in place within a window or build a new environment and repoint the
DAG bucket; Astronomer lets you pin the runtime image per deployment. In all three, the DAG-level
migration is yours, and the vendor's "supported version" is a ceiling, not a promise that your
plugins still import.

Downgrades are not supported. The only rollback is restoring the database backup you took, which is
also why the backup is step zero rather than an afterthought.

## Common mistakes

- Alerting only on task failures, so a paused DAG or a dead scheduler is invisible.
- Letting `task_instance` grow for years, then treating the resulting scheduler latency as a
  capacity problem and adding workers.
- Running `airflow db clean` without `--dry-run` on a Friday.
- Assuming Kubernetes log retention: the pod is gone, and so is the traceback.
- Upgrading the scheduler before the workers and spending an afternoon on serialization errors.
- Treating a managed service as "someone else's problem" — the DAG code, providers and config are
  still yours.

## Production notes

Build one dashboard with the six signals above and one alert — "production DAG with no successful
run in N intervals" — before adding anything more sophisticated. Retention is a design decision:
keep 30–90 days of task history, archive the rest if compliance needs it, and never let the
metadata database become the data warehouse's shadow. When you upgrade, write the rollback plan
first; "restore last night's snapshot and redeploy the previous image" is a sentence you want to
have written before the window opens.
