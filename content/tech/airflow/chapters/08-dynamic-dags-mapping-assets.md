# Dynamic DAGs, Task Mapping and Asset Schedules

Three different things get called "dynamic" in Airflow, and they solve different problems:

| Mechanism | What varies | Decided when |
|---|---|---|
| DAG factory | How many DAGs exist and what each contains | Parse time |
| Dynamic task mapping | How many task instances a task has | Run time |
| Asset (dataset) schedules | When a DAG runs | On an upstream event |

Picking the wrong one is the usual cause of a deployment with 3,000 DAGs where one would do, or a
DAG that queries the database at import time and takes four minutes to parse.

## Generated DAGs

When the *graph* differs per tenant, region or source, generate one DAG per entry:

```python
# dags/generate_sources.py
import yaml
from airflow.sdk import DAG
from airflow.providers.standard.operators.bash import BashOperator

def build(source: dict) -> DAG:
    with DAG(
        dag_id=f"ingest_{source['name']}",
        schedule=source.get("schedule", "0 3 * * *"),
        start_date=datetime(2025, 1, 1),
        catchup=False,
        max_active_runs=1,
        tags=["ingest", source["tier"]],
    ) as dag:
        extract = BashOperator(
            task_id="extract",
            bash_command=f"python extract.py --source {source['name']} --date {{{{ ds }}}}",
        )
        load = BashOperator(task_id="load", bash_command="...")
        extract >> load
    return dag

for source in yaml.safe_load(open("dags/sources.yaml")):
    try:
        globals()[f"ingest_{source['name']}"] = build(source)
    except Exception:
        log.exception("failed to build DAG for %s", source.get("name"))
```

Two details in that snippet matter more than the pattern:

- **The `try/except` per DAG.** An uncaught exception during the loop aborts module import, and
  *every* DAG in that file disappears from the UI behind a single import error. One bad tenant
  should cost one DAG.
- **Stable `dag_id` and `task_id`s.** `ingest_acme` is an identity; renaming it to
  `acme_orders_ingest` creates a new DAG with no history and orphans the old runs.

The failure mode of factories is combinatorial growth: 40 sources × 25 tasks is 1,000 tasks in
`serialized_dag`, parsed on every file change, all with nearly identical structure. If the graph is
the same for every entry, you do not have 40 DAGs — you have one DAG with a list of 40 inputs. That
is the case dynamic task mapping was built for.

### Parse-time discipline

DAG files are imported repeatedly, by the scheduler and by the DAG processor. Anything at module
level runs every time:

- No database queries, HTTP calls or cloud API calls to build the graph. A 200 ms query per file ×
  300 files × every `min_file_process_interval` is a self-inflicted outage.
- No `Variable.get()` at import (it is a database query); use `{{ var.value.x }}` inside a task.
- Keep imports light. Importing pandas, torch and a cloud SDK in a DAG file costs seconds per parse
  and pushes you toward `dagbag_import_timeout`.
- Cache expensive *static* computation in a generated file committed by CI, not at parse time.

The parse budget is real: `dag_processing.total_parse_time` above a few seconds per file, or a
growing `dag_processing.import_errors`, is how this shows up before users notice.

## Dynamic task mapping

Mapping creates one task instance per element of a list that is only known at run time:

```python
@task
def list_partitions(ds=None) -> list[str]:
    return discover_partitions(ds)          # e.g. 37 partition paths

@task
def compact(path: str, mode: str = "full") -> str:
    return rewrite(path, mode)

@task
def summarise(results: list[str]) -> int:
    return len(results)

paths = list_partitions()
results = compact.expand(path=paths)        # 37 instances, one per path
summarise(results)                          # receives the list of returns
```

Variants:

- `compact.partial(mode="fast").expand(path=paths)` sets static arguments once and maps the rest.
- `.expand_kwargs([{"path": p, "mode": "fast"}, ...])` maps over whole argument dictionaries.
- `XComArg` composition works: the list can come from an upstream `@task`, which means the number
  of instances is decided after that task succeeds.

Semantics worth knowing:

- **One `task_id`, many `map_index` values.** The UI shows a mapped task you can expand; state is
  per index, and `{{ ti.map_index }}` is available in templates and logs.
- **`[core] max_map_length` (default 1024)** refuses a larger expansion rather than silently
  creating a hundred thousand rows.
- **An empty list produces zero instances.** The task is `skipped`, and downstream tasks see a
  skipped upstream — pair with `none_failed_min_one_success` if you want the run to continue with
  an empty result.
- **Concurrency still applies.** 37 instances of a task in a DAG with `max_active_tasks=16` run in
  three waves; pool slots gate them too.
- **Retries are per instance.** One bad partition retries alone, which is the point.

Mapping is not a substitute for a loop inside one task when the work is seconds long: 500 mapped
instances at 2 seconds each spend more time in scheduler bookkeeping than in work.

## Asset-driven schedules

A DAG can be scheduled by *data arriving* rather than by the clock. The producer declares what it
writes; the consumer declares what it waits for:

```python
# producer
from airflow.sdk import Asset
orders_asset = Asset("s3://lake/orders")

ingest = BashOperator(
    task_id="ingest_orders",
    bash_command="python ingest.py",
    outlets=[orders_asset],          # publishes an asset event on success
)

# consumer
with DAG(
    dag_id="orders_daily_rollup",
    schedule=[orders_asset],         # runs when the asset is updated
    start_date=datetime(2025, 1, 1),
    catchup=False,
) as rollup:
    ...
```

Properties:

- The consumer's run is created **after** the producing task succeeds, not when the cron says so.
  That removes the "is the data there yet?" sensor and most of the timing guesswork.
- `schedule=[a, b]` means **any** of them; `AssetAll(a, b)` (2.9+ as `DatasetAll`) waits for all;
  `AssetAny` restores the OR when you have a list for another reason.
- **Aliases** (`AssetAlias`) let a producer publish to a name it computes at run time, which is how
  you express "any partition of this dataset" without enumerating them.
- `inlet_events` / `triggering_asset_events` expose what triggered the run, so the task can read
  the exact URI instead of re-deriving it.
- `catchup` is meaningless for asset schedules — there are no missed clock intervals to fill, only
  events that did or did not happen. Backfilling means backfilling the *producer*.

Airflow 2.4–2.10 called these **datasets** (`Dataset`, `schedule=[ds]`, `outlets=[ds]`); Airflow 3
renamed them to **assets** and added asset partitioning, so an asset has identifiable partitions
rather than being a single opaque URI. The mental model is unchanged; the imports are not
(`airflow.datasets` → `airflow.sdk.Asset`).

**When not to use asset schedules.** If the producer is outside Airflow and you cannot make it
publish an event, you need a sensor (deferrable) or an external event mechanism. And do not replace
`TriggerDagRunOperator` with assets purely for tidiness: `TriggerDagRunOperator` is a task in the
graph with visible lineage and passable `conf`, while an asset trigger is a decoupled signal with no
ordering guarantee beyond "after the producer succeeded". For data dependencies, decoupling is the
point; for "run this specific DAG next with this payload", a trigger operator is honest.

## Choosing

| Situation | Choice |
|---|---|
| Same graph, N inputs | One DAG + `expand()` |
| N graphs that differ structurally | DAG factory with per-DAG guards |
| Consumer must wait for upstream data | Asset schedule (or deferrable sensor for external) |
| Explicit "then run that DAG with this conf" | `TriggerDagRunOperator` |
| Hundreds of near-identical partitions | One DAG, mapping, and a bigger pool |

## Common mistakes

- Querying the metadata database in a DAG file to decide the graph, then blaming the scheduler.
- One unguarded config error taking out every generated DAG in the file.
- Mapping over a 50,000-element XCom list instead of batching or querying.
- Using `schedule=[asset]` and expecting catchup to fill history.
- Assuming mapped instances are ordered; they are not, and `map_index` is the only identity.
- Publishing an asset from a task that writes only *some* of the partitions it claims.

## Production notes

Cap generated DAGs: beyond a few hundred, the parse loop and UI become the constraint, and a single
DAG with mapping plus pools is usually faster to operate. Emit the number of mapped instances as a
metric — a jump from 40 to 4,000 is a data problem that will exhaust every pool you own. And keep
asset names in a shared module imported by both producer and consumer, so a typo is an import
error rather than a consumer that silently never runs.
