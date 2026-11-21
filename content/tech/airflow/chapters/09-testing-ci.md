# Testing DAGs Locally and in CI

Airflow gives you no test framework and no opinion, which is why most teams end up with either
zero tests or a slow integration suite that runs against staging. The useful middle ground is four
layers, cheapest first, and each catches a different class of bug.

| Layer | Catches | Cost |
|---|---|---|
| Import and structure tests | DAGs that fail to parse, missing tasks, wrong retries or schedule | Milliseconds |
| Unit tests of task logic | Business logic, SQL construction, error handling | Milliseconds |
| Task and DAG runs (`dag.test()`, `airflow tasks test`) | Broken connections, templating, arguments, serialization | Seconds to minutes |
| Integration against real services | Dialect errors, permissions, schema drift | Minutes, in staging |

## Layer 1: import and structure

```python
# tests/test_dag_structure.py
import pytest
from airflow.models import DagBag

@pytest.fixture(scope="session")
def dagbag():
    return DagBag(dag_folder="dags", include_examples=False)

def test_no_import_errors(dagbag):
    assert dagbag.import_errors == {}, dagbag.import_errors

def test_orders_daily_shape(dagbag):
    dag = dagbag.get_dag("orders_daily")
    assert dag is not None
    assert dag.catchup is False
    assert dag.max_active_runs == 1
    assert set(dag.task_ids) == {"extract_orders", "transform_orders", "load_revenue"}
    assert dag.get_task("load_revenue").upstream_task_ids == {"transform_orders"}
    assert dag.get_task("extract_orders").retries == 2
    dag.validate()
```

This is the highest-value test per line in the file. `import_errors` catches the failure that
otherwise produces "my DAG disappeared" in production, and the structural assertions are how you
encode team conventions — every DAG has an owner, a tag, a `max_active_runs`, and no task without
a retry policy. `dag.validate()` catches cycles and dangling references that a smoke test would
miss.

Do not stop at one DAG: parametrize over `dagbag.dags.values()` so a newly added DAG is checked the
moment it is committed.

## Layer 2: unit-test the logic, not the framework

The most testable code in a DAG is the code that does not know it is in a DAG:

```python
# dags/lib/orders.py
def build_merge_sql(ds: str, columns: list[str]) -> str:
    cols = ", ".join(columns)
    return f"MERGE INTO fct_daily_revenue t USING stg_orders s ON ... AND s.order_date = '{ds}'"

# tests/test_orders_sql.py
def test_merge_sql_is_partition_scoped():
    sql = build_merge_sql("2025-03-01", ["country", "revenue"])
    assert "2025-03-01" in sql
    assert "country, revenue" in sql
```

Push logic into modules under `dags/lib/` (or a separate package installed into the image), keep
operators and `@task` functions thin, and most of your test suite needs no Airflow at all. This is
also how you avoid the anti-pattern of a test that asserts Airflow's templating works.

## Layer 3: run tasks and DAGs

Three tools, in increasing fidelity:

```bash
# one task, no DagRun record, no dependency checks — smoke test the callable
airflow tasks test orders_daily extract_orders 2025-03-01

# whole DAG, in-process, sequential, with a real DagRun row
airflow dags test orders_daily 2025-03-01

# from a test: same as above, and it returns the DagRun
def test_dag_runs_end_to_end(dagbag):
    dag = dagbag.get_dag("orders_daily")
    run = dag.test(logical_date=datetime(2025, 3, 1, tzinfo=timezone.utc))
    assert run.state == DagRunState.SUCCESS
```

`dag.test()` (2.5+) executes the graph in the test process with a debug/local executor: no
scheduler, no workers, sequential execution. It is the right place to catch a broken template, a
missing connection, a signature mismatch in `@task` or a TypeError in a hook call. It needs a real
metadata database (`airflow db migrate`) and real connections, so use a container with Postgres in
CI, not SQLite.

Be clear about what it does not test: concurrency, retries under a real executor, deferral,
scheduling, and anything that depends on a cluster. Those belong to staging.

## Mocking the edges

```python
def test_extract_handles_empty(monkeypatch):
    monkeypatch.setenv("AIRFLOW_CONN_WAREHOUSE", "postgresql://u:p@localhost:5432/test")
    monkeypatch.setattr("dags.lib.orders.fetch_rows", lambda ds: [])
    with pytest.raises(AirflowSkipException):
        extract.function(ds="2025-03-01")
```

Two rules keep mocks from rotting:

1. **Mock at your own boundary** (`dags.lib.orders.fetch_rows`), not at
   `PostgresHook.get_pandas_df`. Mocking the framework couples the test to a version.
2. **Override connections with `AIRFLOW_CONN_*` environment variables** rather than patching
   `BaseHook`. It exercises the same lookup path production uses, and it fails loudly if a hook
   reads a field you did not provide.

For SQL, the honest options are a container with the real engine (`testcontainers`, or the
docker-compose file you already have) or a dialect-compatible local engine — DuckDB for logic that
does not use vendor-specific syntax, SQLite for nothing. A query that passes on DuckDB and fails on
Snowflake is a normal Tuesday; run the load-bearing SQL against the real dialect in staging at
minimum.

## The CI pipeline

```yaml
# .github/workflows/airflow.yml (shape, not a vendor endorsement)
jobs:
  test:
    container: apache/airflow:2.10.4-python3.11
    steps:
      - run: pip install -r requirements-dev.txt --constraint https://raw.githubusercontent.com/apache/airflow/constraints-2.10.4/constraints-3.11.txt
      - run: ruff check dags tests && mypy dags/lib
      - run: airflow db migrate
      - run: pytest tests -q
```

Order matters: lint and type checks in seconds, structure tests in milliseconds, `dag.test()` in
seconds, integration tests last and only on the main branch or a label. Pin the Airflow version and
use the official constraints file — provider resolution without constraints is the number one cause
of "it works locally".

Two gates worth adding:

- **`airflow dags reserialize --check`-style validation.** If your DAGs must serialize, catch a
  serialization failure in CI rather than in the scheduler's parse loop.
- **A dry-run of the deployment diff.** Rendering the Kubernetes manifests or Terraform plan in CI
  catches the config change that points workers at the wrong queue.

## What not to test

- That `BashOperator` runs bash. Framework tests belong upstream.
- Log output strings and exact Jinja rendering of every field.
- Full data-quality assertions in CI with a stub that disagrees with production; assert them in
  the pipeline with a real check task instead (chapter 7).

## Common mistakes

- A test suite that imports DAGs with `AIRFLOW_HOME` pointing at the developer's home directory, so
  results depend on local variables and connections.
- `dag.test()` against a SQLite database, then a surprise when the `PostgresHook` test passes
  locally and fails in CI.
- Structure tests for one DAG only, so the new DAG is the one that breaks the scheduler.
- Mocking `BaseHook.get_connection` everywhere, which hides a typo in `conn_id` forever.
- Running the full integration suite on every commit and disabling it a month later because it
  takes 40 minutes.

## Production notes

Treat the import test as a required check — it is the cheapest way to stop the "DAG vanished from
the UI" incident before merge. Keep a fixture DAG in `tests/` that exercises the team's conventions
(owner, tags, retries, `max_active_runs`) and assert every DAG matches it. And run the same
container image and constraints in CI as in production; a green build on a different Airflow
version is a false negative with good manners.
