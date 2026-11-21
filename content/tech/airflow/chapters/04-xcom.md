# XCom: Passing Data Between Tasks

XCom ("cross-communication") is how one task hands a value to another. It is also the feature
most often used to turn Airflow into a data pipeline it was never designed to be. Both facts come
from the same implementation: an XCom is a row in the metadata database.

## The mechanics

```python
# push explicitly
context["ti"].xcom_push(key="manifest", value={"path": "s3://...", "rows": 120000})

# pull by task and key
manifest = context["ti"].xcom_pull(task_ids="extract_orders", key="manifest")

# the return value of an operator is pushed under the key "return"
def extract(**context):
    return {"path": "s3://orders/2025-03-01/"}
```

Underneath, `xcom` stores `(dag_id, run_id, task_id, map_index, key, value, timestamp)`. The
`run_id` scoping is the important part: XComs are per DagRun, so yesterday's manifest is not
visible to today's task unless you ask for it with `include_prior_dates=True`. That default is a
feature — it keeps runs independent — but it also means a task that "worked yesterday" cannot
silently read stale state.

Values are serialized to JSON by default (`[core] enable_xcom_pickling = False`). Turning pickling
on lets you pass arbitrary Python objects and creates a deserialization vulnerability plus a
version-coupling problem: a worker on a newer image may not be able to unpickle what an older one
wrote. Custom classes, Decimal, datetime and numpy scalars all need a JSON encoder or coercion.
Airflow 3's task SDK adds typed serialization for `@task` return values, but the storage model is
unchanged.

Two switches worth knowing:

- **`do_xcom_push=False`** on an operator stops it storing its return value — the right setting
  for operators that return huge objects you never use.
- **`xcom_backend`** points at a `BaseXCom` subclass whose `serialize_value`/`deserialize_value`
  and `orm_deserialize_value` offload the payload to object storage. This is the supported way to
  keep large values out of the database, but it does not make large values a good idea.

## What it is actually for

XCom is a **control channel**, not a data channel. The things it is good at are small, structured
and semantically meaningful:

```python
@task
def extract() -> dict:
    path = upload_to_s3(...)
    return {"path": path, "rows": 120_000, "checksum": "9f2c..."}

@task
def validate(manifest: dict) -> dict:
    assert manifest["rows"] > 0
    return {**manifest, "validated": True}
```

That dict is an order of magnitude cheaper than the data it describes, and it makes the run's
history readable: the UI shows you *what* each step produced without a query. The same pattern
scales to thousands of files, because the manifest is a pointer, not the payload.

The line to hold: **if the value is bigger than a few kilobytes, or you would not want to read it
in a UI, it does not belong in XCom.**

| Payload | Correct place |
|---|---|
| Row counts, paths, checksums, status codes | XCom |
| A few hundred file paths for dynamic mapping | XCom (see the caveat below) |
| A DataFrame or Arrow table | Object storage or the warehouse; pass the URI |
| A model artefact | Object storage with a versioned key |
| Configuration shared by every run | `params`, a Variable, or a file in the repo |
| Secrets | Never XCom — it is stored unencrypted unless you encrypt it yourself |

## The cost of getting it wrong

XComs live in the same database the scheduler writes to on every loop. A 5 MB payload per task
per run, on 500 runs a day, is 2.5 GB a day of rows that the scheduler's queries and every backup
have to carry. The failure mode is not a clean error — it is a gradually slower scheduler,
`serialized_dag` and `xcom` tables bloating, and eventually `TaskInstance` queries timing out
while the UI shows "loading".

There is a hard ceiling too: the value column's type limits a single XCom (roughly 1 GB on
PostgreSQL `bytea` and MySQL `LONGBLOB`), and the serialization happens in the worker's memory.
Teams hit memory limits before they hit column limits.

Pulling is equally sharp. `xcom_pull` without `task_ids` scans the run's XComs and can return a
list of every value pushed by every task under that key — a common source of "why is my task
receiving a list of dicts". Be explicit: `ti.xcom_pull(task_ids="extract_orders", key="manifest")`.

## Mapping over an XCom

Dynamic task mapping reads a list from XCom and creates one task instance per element:

```python
files = list_files()                      # returns a list[str] via XCom
process.expand(path=files)                # one mapped instance per path
```

This is the modal legitimate use of a larger XCom — a few hundred short strings. It still goes
through the database, and `[core] max_map_length` (default 1024) caps how many instances a single
`expand()` will create. For tens of thousands of items, map over a *query* the task executes, or
chunk the list into batches first.

## Getting data between tasks without XCom

Three patterns cover almost everything:

1. **Hand off a URI.** Write the payload to S3/GCS/HDFS or a staging table, return the path. The
   downstream task reads it with the same credential and the same partition key. This is how
   Airflow pipelines were designed to work: tasks communicate through the systems they already
   use, and the metadata database stays a control plane.
2. **Use the warehouse as the bus.** `extract` writes `stg_orders` for the interval; `transform`
   reads it. The dependency is still explicit in the graph, and the data is inspectable and
   replayable.
3. **Offload with a custom XCom backend.** Same API, payload in object storage, only a pointer in
   the row. Useful when a library or a vendor DAG already passes objects around and you cannot
   refactor it quickly — but it hides the cost rather than removing it.

The test for whether you need any of this: would a new engineer be able to re-run a single task
six months from now, given the run's metadata? If the answer depends on a 40 MB blob in a database
row, the answer is no.

## Common mistakes

- Passing a DataFrame, a Spark DataFrame's `.collect()`, or a whole file's bytes.
- Pushing in a loop under one key and expecting the last value; the last write wins, silently.
- Pulling without `task_ids` and getting a list.
- Assuming `xcom_pull` returns data from a failed or skipped upstream task — it returns `None`.
- Relying on pickle, then changing a class definition and breaking every in-flight run.
- Using XCom to pass a value that is a *configuration* constant; put it in `params`.

## Production notes

Put the payload size rule in the code review checklist and enforce it with a small helper that
raises above a threshold in non-production. Schedule `airflow db clean` with the XCom table in
scope, and check its row count alongside `task_instance` when the scheduler gets slow. If a
pipeline genuinely needs to hand off megabytes, that is a signal the two tasks should be one task,
or that the intermediate artefact should be a table with a partition key — not a database row
pretending to be a message queue.
