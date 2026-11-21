# Connections, Pooling and Limits

PostgreSQL uses one operating-system process per connection. That design is why it is robust and
why it does not scale to thousands of clients: each backend has its own memory, its own catalog
caches and its own page-table entries, and the postmaster has to context-switch between them. A
connection pool is not an optimisation you add later; it is part of the architecture.

## What a connection costs

A backend's baseline resident set is roughly 5–10 MB before it does any work, plus `work_mem` for
every sort and hash node in the query it is currently running. The arithmetic that bites:

```
200 connections × 3 concurrent sort nodes × work_mem 16 MB ≈ 9.6 GB
```

`work_mem` is not a per-connection allocation — it is a per-node limit, and a query with three
sorts and two hash joins can use five times it. Setting `work_mem = 256MB` "to fix the sorts" on a
server with 100 connections is how a machine starts swapping at 02:00.

`max_connections = 100` is the shipped default. Raising it to 1000 is possible and almost always
the wrong move: throughput typically peaks in the low hundreds of active backends and declines
after, because the bottleneck becomes lock contention and context switching rather than work.

| Symptom | Where to look |
| --- | --- |
| `FATAL: sorry, too many clients already` | `max_connections`, pooler `max_client_conn` |
| Latency rising with load but CPU flat | lock waits: `pg_stat_activity.wait_event_type = 'Lock'` |
| Memory growing with connection count | `work_mem` × nodes, per-backend caches |
| New connections slow, existing fast | fork cost, `max_connections` near the limit |

## PgBouncer's three modes

PgBouncer sits between the application and the server and multiplexes many client connections onto
few server connections. The mode decides how long a server connection is lent to a client.

| Mode | Server connection held for | Compatible with |
| --- | --- | --- |
| `session` | the client's whole session | everything; pooling benefit is small |
| `transaction` | one transaction | most OLTP; breaks session state |
| `statement` | one statement | stateless queries only; no multi-statement transactions |

Transaction pooling is the default recommendation: a pool of 20–50 server connections can serve
thousands of idle application clients, because applications are idle most of the time. What it
breaks is anything that assumes a session:

- **Session-level `SET`.** `SET search_path`, `SET TIME ZONE`, `SET statement_timeout` leak into the
  next client that borrows the connection. Use `SET LOCAL` inside a transaction, or configure the
  role/database defaults instead.
- **Named prepared statements.** The server-side statement lives on one backend, but the next
  transaction may land on a different one. PgBouncer 1.21+ supports `max_prepared_statements` to
  track them per client; without it, use protocol-level unnamed statements or disable server-side
  prepare in the driver.
- **`LISTEN`/`NOTIFY`**, session-level advisory locks, `WITH HOLD` cursors, and temporary tables.
- **`pg_backend_pid()`** is not a stable identity for a client.

```ini
[pgbouncer]
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 40
min_pool_size = 10
reserve_pool_size = 5
reserve_pool_timeout = 3
max_db_connections = 80
server_idle_timeout = 60
query_wait_timeout = 10
```

`max_db_connections` caps total server connections across all pools for a database — the setting
that actually protects the server when several services share it. `query_wait_timeout` makes a
saturated pool fail fast with an error instead of queueing forever, which is what you want: a
bounded failure is easier to handle than a 30-second latency cliff.

## Sizing, concretely

1. Measure concurrent active queries at p95, not total connections. On a typical OLTP service, that
   is 10–40.
2. Set the pool to roughly that, plus headroom: `default_pool_size = 40`. A useful starting formula
   is `(cpu_cores × 2) + effective_spindle_count` for I/O-bound work, capped by measurement.
3. Set `max_connections` to pool size × number of pools + 10 for admin and replication. Replication
   and backup connections are not pooled and must be accounted for.
4. Give `superuser_reserved_connections` (default 3) room to breathe so an operator can log in
   during saturation.

## Server-side guardrails

These belong on the role or database, not in application code:

```sql
ALTER ROLE app SET statement_timeout = '30s';
ALTER ROLE app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE app SET idle_session_timeout = '10min';          -- 14+
ALTER ROLE reporting SET statement_timeout = '5min';
ALTER DATABASE analytics SET work_mem = '64MB';
```

`idle_in_transaction_session_timeout` is the one to insist on. An application that opens a
transaction, calls an external HTTP service, and then commits holds locks and the xmin horizon for
the duration of that call — and a pooler makes this worse, because the connection is checked out
until commit.

## Authentication and TLS

`scram-sha-256` is the default password method since 14; `md5` still works but is deprecated.
Terminate TLS at the server (`ssl = on`) rather than only at the pooler if clients bypass the
pooler. `pg_hba.conf` should name roles and databases explicitly for application hosts, with
`hostssl` rather than `host`.

## Monitoring

```sql
SELECT state, wait_event_type, count(*)
FROM pg_stat_activity
GROUP BY 1, 2 ORDER BY 3 DESC;

SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit
FROM pg_stat_database WHERE datname = current_database();
```

A `blks_hit` ratio below ~0.99 on an OLTP database means the working set no longer fits
`shared_buffers`, which is a capacity problem, not a tuning one. `xact_rollback` climbing suggests
timeouts or serialization failures, and is worth alerting on separately from `xact_commit`.

## Common mistakes

- Scaling the application horizontally and the connection count with it — twenty pods × twenty
  connections is four hundred backends for a workload that needs thirty.
- Putting PgBouncer in front of the database but leaving the application's own pool at 20 per pod.
- Raising `max_connections` to fix "too many clients" when the real problem is a connection leak.
- Using session pooling and concluding pooling does not help.
- Setting `work_mem` globally to the size the biggest query wants.
