# Executors and Worker Scaling

The executor is the component's answer to "where does this task actually run". Choosing one is a
decision about isolation, cold-start latency and operational surface — and every choice is
bounded by the same three counters.

## Slots, and the three limits

Every running task instance occupies a **slot**. Slots are finite and are counted in three
places, all of which must allow the task before it runs:

| Limit | Config | Scope |
|---|---|---|
| Global parallelism | `[core] parallelism` | Whole deployment |
| Per-DAG tasks | `max_active_tasks` | One DAG's concurrent task instances |
| Pool capacity | `slot_pool` rows | Arbitrary group, e.g. `warehouse` |

Tasks created by `.expand()` count individually, so a mapped task with 200 instances and
`max_active_tasks=16` runs in waves of 16. Worker processes add a fourth, physical limit:
`worker_concurrency` on a Celery worker caps how many tasks that worker takes.

A task that is `queued` while every counter has room is an executor or worker problem. A task that
is `scheduled` is waiting on a counter, a dependency, or `max_active_runs`. Knowing which state
you are stuck in halves the debugging time.

## The executors

| Executor | Where tasks run | Good for | Cost |
|---|---|---|---|
| `SequentialExecutor` | In the scheduler process, one at a time | Debugging, `airflow tasks test` | No concurrency, SQLite only |
| `LocalExecutor` | Subprocesses on the scheduler host | Single box, up to a few hundred tasks/hour | No isolation, no horizontal scale |
| `CeleryExecutor` | Celery workers, any number of hosts | General production, long-running tasks | Broker to run, heterogeneous workers, no per-task isolation |
| `KubernetesExecutor` | One pod per task instance | Isolation, per-task resources, no idle workers | 20–60 s cold start per task |
| `CeleryKubernetesExecutor` | Both, routed by queue | Big fleet for the bulk, pods for heavy or isolated tasks | Two systems to operate |
| `LocalKubernetesExecutor` | Local queue plus a Kubernetes queue | Small deployments that need occasional pods | Same as above, single host otherwise |
| `EdgeExecutor` (3.x) | Worker on a remote machine, outbound connection only | On-prem/edge networks with no inbound access | Newer, thinner ecosystem |

**LocalExecutor** is underrated. `parallelism = 64` on a 16-core box runs a surprising amount of
pipeline, and it removes the broker, the worker fleet and the queue-latency class of incident
entirely. The ceiling is the machine and the fact that a leaked file descriptor or a forked
process takes the scheduler with it.

**CeleryExecutor** is the default production shape: the scheduler publishes a message with the
task's command, a worker consumes it, executes it and reports state. Structure matters:

```ini
[celery]
broker_url = redis://redis:6379/0
result_backend = db+postgresql://airflow:airflow@postgres/airflow
worker_concurrency = 16
```

- **Broker** carries task messages; losing it loses queued tasks (not running ones). Redis is fine
  for most teams; RabbitMQ gives stronger delivery guarantees.
- **Result backend** stores task return values for the executor; pointing it at the metadata
  database avoids a second store.
- **Queues** partition the fleet: `queue="gpu"` on an operator, then `airflow celery worker -q gpu`
  on GPU hosts. Route by resource profile (CPU-heavy, memory-heavy, network-heavy), not by team —
  team queues fragment capacity and create idle islands.
- **Concurrency** should match the work: `worker_concurrency` ≈ cores for CPU-bound Python,
  2–4× cores for IO-bound HTTP/SQL tasks. Set `worker_prefetch_multiplier = 1` and
  `task_acks_late = True` so a killed worker's task is redelivered rather than lost; Airflow
  relies on redelivery for at-least-once semantics.

**KubernetesExecutor** creates a pod per task instance from a template
(`pod_template_file`, or `worker_container_repository` + `worker_container_tag`). You get
per-task CPU/memory via `container_resources`, a clean filesystem, no cross-task interference, and
zero idle cost — at the price of scheduling latency. For a fleet of 30-second tasks it is a bad
deal: 40 seconds of pod startup per 30 seconds of work. It shines for tasks of several minutes
that need specific resources, or where isolation is a compliance requirement.

`KubernetesPodOperator` is a *different* thing: it runs a container as a task regardless of the
executor. Use it to run an image; use `KubernetesExecutor` to change where all tasks run.

## Sizing, with arithmetic

Take 12,000 task instances a day at 4 minutes each: 48,000 task-minutes, or 800 task-hours. Spread
over 24 hours that is ~34 concurrent tasks on average; peak is usually 2–2.5× the average. So
**~80 slots** with headroom, plus retries. If those tasks average 4 minutes, a
`KubernetesExecutor` adds ~15% overhead; a Celery fleet of 5 workers × 16 concurrency covers it.

The same arithmetic exposes the real problem in most "Airflow is slow" tickets: not slot count but
**task granularity**. 12,000 tasks of 4 minutes is healthy; 400,000 tasks of 8 seconds is a
scheduler and database problem no executor fixes.

Rules of thumb:

- Below ~50 slots, `LocalExecutor` on a decent VM.
- 50–2,000 slots, `CeleryExecutor` with a handful of workers and 3–4 queues.
- Above that, or with strong isolation needs, `KubernetesExecutor` with a tuned pod template and a
  warm image.
- Sensors: move to deferrable before adding workers (chapter 3). A sensor fleet is the cheapest
  capacity you will ever recover.

## Protecting downstream systems

The most valuable scaling control is not worker count, it is **pools**. A warehouse that accepts 8
concurrent loads should have a pool of 8 slots, with every loading task in it:

```bash
airflow pools set warehouse_load 8 "Redshift concurrent load limit"
```

```python
SQLExecuteQueryOperator(task_id="merge", conn_id="warehouse", pool="warehouse_load", pool_slots=1, ...)
```

Without this, adding workers moves the bottleneck to the database and turns a slow pipeline into a
slow database plus a slow pipeline. Pools are also how you stop a backfill from consuming capacity
production needs: give backfills their own pool, or in 3.x their own backfill scheduler.

## Autoscaling and cost

- **Celery on Kubernetes**: scale workers on broker queue depth (`executor.queued_tasks` metric),
  not CPU — the queue is what predicts demand. Scale-to-zero is tempting and wrong for a scheduler
  that expects a worker to exist; keep a floor of one.
- **KubernetesExecutor**: the cluster autoscaler sees pod demand directly, so scale-to-zero works.
  Budget for image pull time, `imagePullPolicy: IfNotPresent` on a warm node, and a pod template
  that requests realistic CPU/memory — requests too low cause throttling that looks like a slow
  query.
- **Managed services** (MWAA, Composer, Astronomer) abstract the fleet but not the limits: worker
  size, minimum/maximum worker counts and queue behaviour are still yours to configure, and their
  ceilings are documented and firm. Do not assume "managed" means "scales".

## Common mistakes

- Raising `parallelism` without raising `max_active_tasks`, pool sizes or worker concurrency, then
  concluding nothing changed.
- Setting `worker_concurrency` above the CPU count for CPU-bound work and blaming the DAG.
- One queue per team, leaving half the fleet idle while another queue backs up.
- Running `KubernetesExecutor` with a 40-second pod start for sub-minute tasks.
- Forgetting that the metadata database connections are also per worker process — 300 workers ×
  pool size 5 will exhaust `max_connections`.
- Scaling workers to fix sensors that hold slots while polling.

## Production notes

Measure queue latency (`queued` → `running`) per queue, not just end-to-end runtime; it is the
signal that separates "the task is slow" from "the fleet is full". Set a floor and a ceiling on
worker count, alert when the ceiling is sustained for an hour, and treat a growing
`executor.queued_tasks` with an idle worker fleet as a routing bug, not a capacity problem.
