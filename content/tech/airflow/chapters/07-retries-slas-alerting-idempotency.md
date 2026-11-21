# Retries, SLAs, Alerting and Idempotency

Airflow will run your task again. It will run it again after a worker dies, after a pod is
evicted, after a backfill, after an operator clears it manually, and after a retry. The only
question is whether the second run is harmless. Everything in this chapter follows from that.

## Retry semantics

```python
default_args = {
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=60),
    "execution_timeout": timedelta(hours=2),
}
```

- **`retries`** applies per task instance; `default_args` is the usual place, `@task(retries=5)` or
  `operator.override(...)` for exceptions.
- **`retry_delay`** is measured from the moment of failure. With exponential backoff the wait
  doubles each attempt, capped by `max_retry_delay`. There is no jitter, so a hundred tasks that
  fail together retry together — stagger them or reduce the herd.
- **`execution_timeout`** kills a task that runs too long and *counts as a failure*, so it burns a
  retry. It is the only defence against a hung HTTP call that never times out at the socket level.
- **`dagrun_timeout`** fails the whole run; useful to stop a wedged pipeline from holding
  `max_active_runs=1` forever.

Not every failure should be retried. Airflow's default is to retry any exception, which is wrong
for the most common production failure: bad data. Distinguish explicitly:

```python
from airflow.exceptions import AirflowFailException, AirflowSkipException

def validate(rows):
    if rows == 0:
        raise AirflowSkipException("no orders today")     # skip, no retry
    if schema_mismatch(rows):
        raise AirflowFailException("upstream schema changed")  # fail now, no retry
    if http_503_from_api():
        raise                                      # ordinary retry, backoff applies
```

`AirflowFailException` bypasses the remaining retries and fails immediately — the correct response
to a deterministic error, because three retries of a broken assumption only delay the alert.
`AirflowSkipException` marks the task skipped, which downstream `all_success` will treat as a
non-success; use `none_failed_min_one_success` if a skip is legitimate.

## SLAs, and what replaced them

For years the pattern was `sla=timedelta(hours=2)` on a task plus `sla_miss_callback` on the DAG:
the scheduler checked open runs against the deadline and fired the callback, recording a row in
`sla_miss`. It was checked only when the scheduler loop reached it (`[scheduler] check_slas`), it
fired per task, and it was easy to configure an alert that never fired because the DAG had already
failed.

Airflow 3 removed SLA as a feature. Its replacement is **deadline alerts** (3.1+), evaluated
independently of the scheduler's SLA sweep, with a callback that receives the missed deadline
rather than a bare `SlaMiss` row. If you are on 2.x, SLAs still work but should not be the only
alerting mechanism; on 3.x, use deadlines or, more simply, alert on the run.

What actually matters for alerting is the **run**, not the task. A DAG with 40 tasks that all fail
produces 40 failure callbacks and one cause, so put the run identity in the message and thread by
DAG:

```python
def notify_failure(context):
    ti = context["task_instance"]
    send_slack(
        channel="#data-alerts",
        text=f"{ti.dag_id} failed at {ti.task_id} for {context['logical_date']}",
        thread=ti.dag_id,          # one thread per DAG, not one channel per task
    )

with DAG(..., default_args={"on_failure_callback": notify_failure}):
    ...
```

The alternative is a single notifier task with `trigger_rule="one_failed"`: exactly one message per
run, at the cost of it firing only after the other branches settle.

Callback discipline: wrap the callback body in `try/except` (a raised exception in a callback is
logged and can mask the original failure), keep it fast (it runs in the scheduler or worker
process, depending on version), and never put retry logic in it. Provider **notifiers**
(`BaseNotifier` subclasses, 2.6+) are the supported way to do this without custom callbacks —
`on_failure_callback=SlackNotifier(...)` composes with the same retry semantics as a task.

Alert routing worth copying: page on **production DAGs that produce nothing** (run failed, or no
successful run by 06:00), ticket on retried-and-recovered, and log everything. The single most
useful alert is not "task failed" but "this DAG has no successful run in the last N intervals" —
it catches the failure modes that callbacks miss, including a DAG that stopped being scheduled
altogether.

## Idempotency

A task is idempotent if running it twice for the same interval leaves the same state as running it
once. Airflow's at-least-once guarantee makes this a requirement, not a nicety.

The mechanisms, in order of preference:

| Pattern | How | Works when |
|---|---|---|
| Partition overwrite | Delete the interval's rows and insert, in one transaction; or `INSERT OVERWRITE` | Table is partitioned by the run's interval |
| MERGE on a deterministic key | `MERGE`/`ON CONFLICT` on `(id)` after deduplicating the source | Key is stable and the source is complete |
| Atomic swap | Build `tbl_tmp`, then rename/replace | Warehouse supports atomic DDL (Snowflake, BigQuery) |
| Control table | Record `(dag_id, interval, status)` and skip if done | The side effect cannot be made idempotent |
| Deduplicating read | Downstream queries use `QUALIFY ROW_NUMBER()` over the key | You cannot control the writer |

```sql
-- the shape that survives retries, backfills and double-triggers
DELETE FROM fct_daily_revenue WHERE revenue_date = '{{ ds }}';

INSERT INTO fct_daily_revenue
SELECT '{{ ds }}'::date, country, SUM(total_amount)
FROM stg_orders
WHERE order_date = '{{ ds }}'
GROUP BY country;
```

Run those two statements in one transaction, or load to a staging partition and swap. A pipeline
that appends without a delete is a pipeline that double-counts on the first retry, and doubles
again on the backfill someone runs to fix it.

The invariants that make idempotency practical:

1. **Derive everything from the interval.** No `now()`, no `current_date`, no "latest file in the
   bucket". Given `data_interval_start`, the task's output must be fully determined.
2. **Write to a partition keyed by the interval**, so the retry overwrites rather than accumulates.
3. **Make side effects addressable.** Emails, webhooks and API calls are the hard case: give each
   one an idempotency key (`dag_id:task_id:interval`) and let the receiver deduplicate, or gate
   with a control table.
4. **Commit at the end.** A task that updates five tables and fails on the fifth must leave none of
   them half-written; one transaction where possible, a staging table plus swap where not.

## Partial failure and task granularity

A task is the unit of retry, so a 40-minute task that fails in its last step repeats all 40
minutes. Split at natural boundaries — extract, validate, load — so a retry re-runs the cheap part.
The flip side is overhead: once a task drops below a few seconds, scheduler and database cost per
task dominates. The sweet spot in most warehouses is one task per 1–10 minutes of work.

## Retry storms

Three hundred tasks with `retries=5` against a rate-limited API is 1,800 requests queued in the
retry window, which extends the outage. Contain it with pools (chapter 6), `max_retry_delay`, and a
`retries=0` policy for tasks that call an endpoint already known to be degraded — better to fail
the run, alert, and re-run once the dependency is healthy than to hammer it.

## Common mistakes

- `retries=3` on a data-quality check that will fail identically three times.
- `execution_timeout` missing, so a hung socket occupies a slot for 24 hours.
- An `on_failure_callback` that raises, so the only trace of the failure is the callback's
  traceback.
- Alerting per task instead of per run, and drowning the channel.
- Idempotency "solved" with `INSERT ... ON CONFLICT DO NOTHING` against a source that legitimately
  updates rows — the update silently never lands.
- Using `{{ ds }}` in the SQL but `datetime.utcnow()` in the Python idempotency key, so retry and
  backfill disagree.

## Production notes

Write the idempotency key first, then the query. Test it by running the task twice for the same
interval in staging and diffing the table — the only test that proves the property. Keep retries
for transient infrastructure errors, `AirflowFailException` for deterministic ones, and one alert
per failed run with a link to the log. If a DAG needs more than two retries to succeed, the task is
probably wrong, not unlucky.
