# Connections, Hooks, Secrets and Variables

Every non-trivial Airflow deployment touches systems that need credentials. Airflow's answer is a
registry of **connections**, accessed by **hooks**, backed optionally by a **secrets backend** —
plus **variables** for the non-secret configuration that used to be hardcoded in DAGs.

## Connections

A connection is a named record with a type and a set of fields:

```bash
airflow connections add warehouse \
  --conn-type postgres \
  --conn-host pg.internal --conn-port 5432 \
  --conn-schema analytics \
  --conn-login airflow_etl \
  --conn-password '...' \
  --conn-extra '{"sslmode": "require", "connect_timeout": 10}'
```

| Field | Typical use |
|---|---|
| `conn_id` | The name operators reference — stable, environment-specific |
| `conn_type` | Selects the hook and the UI form (`postgres`, `aws`, `http`, `kubernetes`) |
| `host`, `port`, `schema` | Endpoint and default database/catalog |
| `login`, `password` | Credentials, encrypted with Fernet at rest |
| `extra` | JSON for everything the type needs: regions, roles, timeouts, project ids |

`extra` is where provider-specific behaviour lives and where most "it works locally" failures
originate: an AWS connection without `{"region_name": "eu-west-1"}` fails only on the worker whose
environment does not have `AWS_DEFAULT_REGION` set.

The same record can come from an environment variable, which is how you make CI and ephemeral
environments work without a database write:

```bash
export AIRFLOW_CONN_WAREHOUSE='postgresql://airflow_etl:secret@localhost:5432/analytics'
```

`AIRFLOW_CONN_<CONN_ID>` (upper-cased, hyphens to underscores) takes precedence over the database.
Note the asymmetry that bites people: a connection defined by environment variable is invisible in
the UI's connection list in some versions, and editing the UI record for an id shadowed by an env
var looks like it has no effect.

**Fernet.** Connection passwords and the password inside `extra` are encrypted with
`[core] fernet_key`. Without a stable key, every restart loses the ability to decrypt existing
connections. Rotate with `airflow rotate-fernet-key` (which re-encrypts rows), and never generate
the key per container — generate it once, store it in your secret manager, inject it everywhere
(`AIRFLOW__CORE__FERNET_KEY`).

**Who can read them.** Anything with the metadata database and the Fernet key can decrypt every
credential, including every worker. That is an architectural fact, not a misconfiguration. The
mitigation is least-privilege credentials per connection, cloud IAM roles or workload identity
where the provider supports them (so the connection carries no password at all), and RBAC so
non-admin users do not see connection details in the UI.

## Hooks

A hook is the client library wrapper that turns a connection into a live client:

```python
from airflow.providers.postgres.hooks.postgres import PostgresHook

def merge_revenue(**context):
    hook = PostgresHook(postgres_conn_id="warehouse")
    with hook.get_conn() as conn, conn.cursor() as cur:
        cur.execute(open("sql/merge_revenue.sql").read(), {"ds": context["ds"]})
    return hook.get_first("select count(*) from fct_daily_revenue")[0]
```

Three rules make hooks behave:

1. **One hook instance per task.** `get_conn()` caches the client on the hook; constructing a new
   hook per call inside a loop re-authenticates every time.
2. **Use the hook's own helpers** (`get_pandas_df`, `bulk_load`, `run`) instead of hand-rolled
   connection code — they carry provider-specific handling for types, arrays and transactions.
3. **Close what you open.** Hooks do not reliably close cursors for you; a long-running task that
   leaks connections will exhaust the target database's connection limit, not Airflow's.

In tests, most hooks can be pointed at a local service by overriding the connection environment
variable. That keeps DAG code free of connection strings entirely, which is the point.

## Secrets backends

Putting credentials in the metadata database is acceptable but not ideal: it makes the database a
secret store, and rotating a secret means an Airflow write. A secrets backend moves the source of
truth out:

```ini
[secrets]
backend = airflow.providers.amazon.aws.secrets.secrets_manager.SecretsManagerBackend
backend_kwargs = {"connections_prefix": "airflow/connections", "variables_prefix": "airflow/variables", "region_name": "eu-west-1"}
```

Supported targets include AWS Secrets Manager and SSM Parameter Store, GCP Secret Manager, Azure
Key Vault, HashiCorp Vault, and Kubernetes secrets. When several backends are configured
(comma-separated, 2.7+), lookups try each in turn and the **last** one listed takes precedence —
so put the most specific backend last.

Lookup cost is per call. Hooks resolve a connection once per task, which is fine. `Variable.get()`
at DAG-parse time resolves on every parse cycle, which is not (see below). Providers cache where
they can, but a secrets backend that takes 300 ms per read and a secret read per task adds up: an
800-task backfill is 800 secret reads, plus whatever the provider's own API rate limit allows.

## Variables

Variables are key/value configuration in the metadata database:

```bash
airflow variables set orders_lookback_days 30
```

```python
from airflow.sdk import Variable
lookback = Variable.get("orders_lookback_days", deserialize_json=False, default_var="30")
```

Templated access — `{{ var.value.orders_lookback_days }}` — is rendered at task execution, from
the context. That is the safe form. The unsafe form is calling `Variable.get()` in the DAG body:

```python
# Wrong: one database query per DAG file, per parse cycle, forever
LOOKBACK = Variable.get("orders_lookback_days")
```

At 200 DAG files and a 30-second parse interval, that is tens of thousands of queries an hour
against the same database the scheduler needs, and it makes the DAG unparseable when the database
is briefly unavailable. Variables also appear as `AIRFLOW_VAR_<NAME>` environment variables, which
is the clean way to vary them per environment.

**Variables are not encrypted.** They are stored in plaintext; Fernet covers connection passwords,
not variables. If it is a secret, it is a connection (or a secrets-backend value), not a variable.

Variable reads are also not free at scale: values are fetched from the database, and large JSON
variables read on every task contribute to metadata bloat. Keep them small, or keep them in the
repo and redeploy — a `params` default is a version-controlled constant with no runtime cost.

## What goes where

| Need | Mechanism |
|---|---|
| Credentials for an external system | Connection, ideally via secrets backend or IAM role |
| Per-environment endpoint | Connection, plus `AIRFLOW_CONN_*` in CI |
| Tunable knob an operator changes | Variable, read via `{{ var.value.x }}` |
| Fixed configuration tied to the DAG | `params` or a constant in the repo |
| Per-run override | `dag_run.conf` |
| Large reference data (mappings, allowlists) | A table, a file in object storage, or a dbt seed |

## Common mistakes

- Hardcoding a hostname in a DAG "just for now" — it survives three environment migrations.
- Generating a new Fernet key on each deploy and losing every stored password.
- Reading `Variable.get()` at module import, which is both slow and a parse-time database
  dependency.
- Putting a token in a Variable because "it is the same as a connection" — it is not encrypted.
- Sharing one superuser connection across every pipeline, so a bad query can drop a schema.
- Forgetting that workers need network access to the secret manager, not just to the database.

## Production notes

Name connections by system and role (`warehouse_rw`, `warehouse_ro`), not by DAG — the pipeline
should be able to change without renaming credentials. Rotate Fernet keys with the built-in
command during a maintenance window and verify by reading a connection afterwards. Audit
`connection` rows quarterly: a stale credential for a decommissioned system is both clutter and
an unmonitored entry point.
