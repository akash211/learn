# Architecture: Scheduler, Executor, Metadata Database

Airflow does not move data. It moves *state* — from "this interval has not run" to "this run
succeeded" — and everything in its architecture follows from doing that reliably for tens of
thousands of runs a day while the actual work happens in other systems.

The consequences are worth internalising early: Airflow's database is the most important piece of
infrastructure in the deployment — if it is slow, everything is slow. The scheduler decides *what*
should run, the executor decides *where* it runs, and the workers do nothing but execute a command
and report back.

## The components

| Component | Job | What breaks when it dies |
|---|---|---|
| **Scheduler** | Parses DAG files, creates DagRuns, moves TaskInstances to `scheduled`, queues them when dependencies, pools and concurrency allow | Nothing new is scheduled; running tasks finish but nothing follows |
| **Executor** | Decides where a queued task runs (same process, subprocess, Celery worker, Kubernetes pod) and tracks its slots | Tasks sit in `queued` forever |
| **Metadata database** | System of record for DAG structure, run history, task state, XComs, connections, variables | Whole deployment fails; scheduler and UI both stop |
| **API server / webserver** | Serves the UI and REST API, reads state from the DB | No visibility and no way to retrigger, but scheduling continues |
| **DAG processor** | Parses Python files into serialized DAGs (its own process since 2.7, mandatory in 3.x) | New DAGs never appear; existing runs continue |
| **Triggerer** | An asyncio loop that runs `async` triggers for deferrable operators | Deferred tasks never resume |

In Airflow 2.x the webserver parses nothing — serialization moved parsing out of the web tier years
ago — but the scheduler parses unless you enable the separate `airflow dag-processor`. Airflow 3
makes the split unconditional: `airflow api-server`, `scheduler`, `dag-processor`, `triggerer`, and
workers that talk to the API server over HTTP rather than opening a database connection.

## What the scheduler actually does

The scheduler is a loop, and every iteration repeats the same five jobs.

1. **Parse.** Find files under `dags_folder`, import them, and write a serialized JSON
   representation into `serialized_dag` (a *DAG bundle* in 3.x, which adds versioning). Parsing
   is rate-limited: `min_file_process_interval` (30 s default) stops it re-importing unchanged
   files, `dag_dir_list_interval` (300 s) controls how often the directory is rescanned, and
   `parsing_processes` sets the pool of parser subprocesses. A file that takes longer than
   `dagbag_import_timeout` is abandoned and its DAGs vanish from the UI.
2. **Create runs.** For every DAG whose schedule says an interval has closed, insert a row in
   `dag_run` with its data interval — unless `catchup=False` and the interval is old, or
   `max_active_runs` is already saturated.
3. **Evaluate dependencies.** For each unfinished TaskInstance, check upstream states against
   the task's `trigger_rule`, then check `depends_on_past`, pool slots and per-DAG concurrency.
4. **Queue.** Set the state to `queued` and hand the command to the executor. `queued` is not
   `running`: a task can sit there for minutes if no worker is free, and that gap is the first
   thing to measure when things feel slow.
5. **Reap.** Detect tasks that stopped heartbeating (`scheduler_zombie_task_threshold`, 300 s
   default), fail them as zombies, and fail runs past `dagrun_timeout` or tasks past
   `execution_timeout`.

Scheduler throughput is measured in *task instances per loop*, and the loop is serialised
around database writes. One scheduler process is enough for most installations; multiple
schedulers are supported on PostgreSQL or MySQL (they coordinate through row locks), and the
usual reason to add a second is HA rather than throughput.

## The metadata database

The schema tells you what Airflow considers important: `dag`, `serialized_dag`, `dag_run`,
`task_instance`, `xcom`, `rendered_task_instance_fields`, `log`, `job`, `slot_pool`, `variable`,
`connection`, `trigger`. Three grow without bound and are the usual cause of a slow deployment:

- **`task_instance`** — one row per task per run. 200 DAGs × 20 tasks × 24 runs a day is about
  100k rows a day.
- **`dag_run`** — one row per run, plus a `conf` blob.
- **`log`** — the event log the UI's "Audit Log" and task history read from.

Two habits keep this under control: run `airflow db clean` on a schedule to delete history older
than your retention window, and never let a high-frequency DAG write large XComs — a 2 MB payload
per task per run hurts long before row counts do.

SQLite is fine for a laptop and unacceptable for anything with more than one process: it has no
concurrent writers, so the scheduler and a worker contend for a global lock. `SequentialExecutor`
plus SQLite is the only supported single-process combination; anything production uses
PostgreSQL (preferred) or MySQL 8.

```ini
[database]
sql_alchemy_conn = postgresql+psycopg2://airflow:airflow@postgres/airflow
sql_alchemy_pool_size = 10
sql_alchemy_max_overflow = 20
```

Connection-pool exhaustion shows up as `QueuePool limit of size 10 overflow 20 reached` in
scheduler logs, followed by scheduler death. Size the pool against Postgres'
`max_connections` divided by the number of Airflow components, and remember each worker
process holds its own pool.

## The webserver (API server)

The UI is a read path with a few write endpoints (trigger, clear, mark state, edit variables).
Because DAGs are read from `serialized_dag` rather than imported, the web tier never runs your DAG
code — a file with a syntax error shows a broken DAG page instead of taking the UI down.

The tier is stateless: replicas behind a load balancer, all sharing `[webserver] secret_key` and
the auth backend configuration (`[api] auth_backends`), with health checks on `/health`. In 3.x the
API server serves that endpoint and is also what workers and the CLI authenticate against.

## The executor

Every executor implements the same two-sided interface: `queue_command()` to submit a task and a
heartbeat reporting what is running and which slots are free. Subprocess, Celery message or
Kubernetes pod is an implementation detail (chapter 6).

The number that constrains the whole system is `[core] parallelism`: the maximum number of task
instances running at once across the deployment. It is enforced by the executor's slot
accounting, not by the workers, which is why a Celery worker with `--concurrency 32` on a
4-core box creates tasks that time out rather than tasks that run faster.

## The triggerer

Deferrable operators hand a coroutine to the triggerer and release their worker slot. Each
triggerer process runs one asyncio loop holding up to `[triggerer] default_capacity` (1000)
triggers. A dead triggerer only strands *deferred* tasks — they wait rather than fail — so run two.

## One run, end to end

```
scheduler loop
  ├── parse orders_daily.py        → serialized_dag
  ├── interval closed              → dag_run(status=running)
  ├── task extract_orders          → task_instance(scheduled)
  ├── deps ok, pool slot free      → task_instance(queued) → executor
  ├── celery worker picks up       → task_instance(running), heartbeat every 5s
  └── exit code 0                  → task_instance(success) → downstream queued
```

Airflow guarantees *at-least-once* execution, not exactly-once. A worker that dies mid-task
leaves the task to be marked failed (or zombie) and retried, and the external side effect may
already have happened. Every task you write has to tolerate that; chapter 7 covers how.

## Deployment shapes

| Shape | Components | Honest assessment |
|---|---|---|
| Docker Compose | Scheduler, webserver, Postgres, Redis, one Celery worker | Fine for a team, no HA |
| Celery on VMs | Scheduler ×2, N workers, Redis/RabbitMQ, managed Postgres | The classic production shape |
| Kubernetes | Scheduler, API server, triggerer, `KubernetesExecutor` | Best isolation, slowest cold start |
| Managed (MWAA, Composer, Astronomer) | Vendor runs the control plane | Least control, least ops |

## Common mistakes

- Sizing workers before checking `parallelism`, `max_active_tasks` and pool slots — the
  bottleneck is usually a counter in the database, not CPU.
- Putting the metadata database on a shared, undersized instance and blaming the scheduler.
- Treating the web tier as highly available while running one scheduler.
- Assuming a task in `queued` is a worker problem. It usually is a pool, a concurrency limit or
  a queue name that no worker consumes.

## Production notes

Instrument the loop, not just the tasks: scheduler heartbeat age, parse time per file, queued
task count by pool, and metadata database size growth per week. Those four graphs explain most
incidents before you open a single task log. Keep every component on the same Airflow version —
mixed-version schedulers against one database is unsupported and produces silently wrong
scheduling.
