# Data Tools: Text-to-SQL and Read-Only Query Paths

A SQL tool is the highest-leverage and highest-risk tool most teams build. Leverage because one tool answers questions across the whole warehouse; risk because SQL is a complete language, and a single statement can read every table, exfiltrate through a network function, or drop an index. The prompt is not the control. The database role, the parser, and the execution wrapper are.

## Defence in depth, in order

Assume each layer can fail and design so the next one holds.

1. **A read-only database role.** `GRANT SELECT` on an allow-listed set of relations and nothing else: no `INSERT`/`UPDATE`/`DELETE`, no DDL, no `CREATE TEMP`, no `TRUNCATE`. Set `default_transaction_read_only = on` on the role so a statement cannot escape via a function. In Postgres, revoke `EXECUTE` on dangerous functions and check that `search_path` cannot be hijacked.
2. **A separate connection and pool.** The SQL tool never shares a pool with the application's read-write connection. Different credentials, different limits, different timeout.
3. **A statement timeout and a row cap.** `SET LOCAL statement_timeout = '5s'`, plus a server-side cap on returned rows and bytes. Both are enforced by the database, not by the model.
4. **An AST check before execution.** Parse the statement and reject anything that is not one `SELECT`.
5. **A result-shape contract.** Columns, types, truncation flag, and row count returned to the model in a fixed envelope.

If the role is read-only and the AST check rejects non-`SELECT`, you have two independent controls. That redundancy is the point: the parser catches privilege abuse that the role might miss (a `SELECT` calling a side-effecting function), and the role catches parser bugs.

## AST validation, not regex

Regexes on SQL fail: comments, string literals, case, `/*! */` hints, dollar quoting, and CTEs all provide cover. Parse instead. `sqlglot` is a practical choice for Postgres, MySQL, Snowflake, BigQuery, and DuckDB dialects:

```python
import sqlglot
from sqlglot import exp

ALLOWED_TABLES = {"analytics.orders", "analytics.order_items", "analytics.products"}
FORBIDDEN_FUNCS = {"pg_sleep", "dblink", "lo_import", "pg_read_file", "xp_cmdshell"}

def check(sql: str, max_rows: int = 500) -> exp.Select:
    statements = sqlglot.parse(sql, read="postgres")
    if len(statements) != 1:
        raise QueryRejected("exactly one statement is allowed")
    tree = statements[0]
    if not isinstance(tree, exp.Select):
        raise QueryRejected("only SELECT is allowed")

    for table in tree.find_all(exp.Table):
        name = ".".join(p for p in (table.db, table.name) if p)
        if name not in ALLOWED_TABLES:
            raise QueryRejected(f"table not allowed: {name}")

    for func in tree.find_all(exp.Func):
        if (func.name or "").lower() in FORBIDDEN_FUNCS:
            raise QueryRejected(f"function not allowed: {func.name}")

    # wrap rather than append, so an existing LIMIT cannot be bypassed
    return exp.select("*").from_(tree.subquery("q")).limit(max_rows)
```

Three details that matter more than the code:

**Wrap, don't append.** Appending `LIMIT 500` to a query that already has `LIMIT 10` is fine, but appending to a query with `UNION` or `ORDER BY` changes meaning or fails to parse. Wrapping in an outer `SELECT * FROM (…) LIMIT 500` is predictable.

**Allow-list relations, not schemas.** `GRANT SELECT ON SCHEMA analytics` includes the `pii` table someone added last week. Enumerate relations and review the list when the warehouse changes.

**Check for row-level security.** If the tool serves multiple tenants, the role or the views must enforce tenant filtering. Do not rely on the model adding `WHERE tenant_id = …`; it will forget, and when it remembers it may use the wrong value. Prefer per-tenant views or a session variable the connection sets before execution.

## Schema exposure

Do not dump `information_schema` into the prompt. Give the model a curated description:

```
analytics.orders
  order_id      text      -- 'ord_' prefix, unique
  customer_id   text      -- joins analytics.customers.customer_id
  status        text      -- one of: placed, shipped, delivered, cancelled, refunded
  total_minor   bigint    -- minor units, USD
  placed_at     timestamptz
```

Three properties: only allow-listed relations, only columns the model may query, and descriptions that encode the traps (units, enums, join keys, timezone). Add two or three example queries for the shapes that are common — revenue by month, orders per customer — because examples teach join structure better than prose. Keep the whole thing under a couple of thousand tokens; a schema dump degrades accuracy as much as it helps.

Where a semantic layer exists — dbt metrics, a warehouse metrics API, pre-defined views — expose *that* instead of raw tables. "Revenue" is a definitional argument; letting the model invent `SUM(total_minor)` produces numbers that differ from the official dashboard, which is worse than an error.

## Result handling

Return a compact, typed envelope:

```json
{"columns": [{"name": "month", "type": "date"}, {"name": "revenue_usd", "type": "numeric"}],
 "rows": [["2026-01-01", 182340.55], ["2026-02-01", 201887.10]],
 "row_count": 2, "truncated": false, "elapsed_ms": 412}
```

Notes: send rows as arrays with a separate column list when the result is wide (it is cheaper than repeating keys per row), or as objects when the model must reason about specific fields — pick one and keep it stable. Format numerics deliberately (round money, never send `182340.54999999999`). Include `truncated`, because a model told "these are all the rows" will compute a total from a capped result and present it as fact.

Sanitise error messages: return the database's syntax error position and message (useful for a repair), but never the connection string, the file path, or the full table list.

## The repair loop

Syntax and semantic errors are the common case for generated SQL, and one repair attempt is usually enough:

1. Execute. On error, return `{"ok": false, "code": "sql_error", "message": "<sanitised>", "query": "<the query>", "retryable": true}`.
2. Allow **one** repair. The second failure returns a terminal error to the user with the query shown.
3. Count repairs against the step budget.

Cap total execution time across repairs, not per attempt — three 5-second queries is 15 seconds of a user's patience.

## Correctness is the harder problem

A query can run, return rows, and be wrong. The failure modes are specific and worth naming:

- **Fan-out.** Joining orders to items multiplies rows, so `SUM(orders.total_minor)` over the joined set double-counts. The result looks plausible and is inflated.
- **Inner join loss.** `JOIN customers` silently drops orders with a null `customer_id`, understating totals.
- **Wrong grain.** Averaging an average.
- **Timezone drift.** `placed_at::date` in UTC versus local shifts month boundaries.
- **Definitional drift.** The model's "active customer" is not the company's.

Mitigations that actually work: define canonical metrics in views; add a verification step that re-runs the query with `COUNT(*)` and compares to an expected order of magnitude; show the generated SQL to the user alongside the answer for anything consequential; and, for high-stakes numbers, restrict the tool to parameterised templates rather than free SQL.

## Templates as the safer default

If 90% of questions fall into a dozen shapes, expose twelve parameterised tools (`revenue_by_month(month_from, month_to, segment)`) instead of one `run_sql`. The model then chooses and fills arguments — the problem described in chapter 2 — rather than writing a language. You get bounded cost, guaranteed correctness of the SQL, and a schema the database can index for. Keep the free-form SQL tool for the long tail, with every control above, and route to it explicitly rather than by default.

## Common mistakes

- Read-only enforced by prompt or by a `if "insert" in sql.lower()` check.
- A single statement check that misses `;` inside a string literal or multiple statements split by comments.
- Appending `LIMIT` to a query that already has one, or to a `UNION`.
- Granting schema-level `SELECT` and later adding a PII table to that schema.
- Dumping the full catalog into the prompt.
- Sending 50,000 rows into the context window.
- Returning `NULL` as the string `"NULL"`, or numerics as unrounded floats.
- Trusting a plausible-looking aggregate without a fan-out check.
- Letting the model see raw database errors including hostnames.

## Production notes

Log every query with the run ID, the SQL hash, the SQL itself (redacted), rows returned, elapsed time, and whether it was truncated. Review the slowest and the most frequent queries weekly: they tell you which templates to build.

Set a per-principal query budget and a concurrency cap, because one agent in a repair loop can saturate a warehouse's small-query queue. Test with a hostile corpus: `; DROP TABLE`, `SELECT pg_read_file('/etc/passwd')`, `UNION SELECT` against a disallowed table, a cartesian join over two large tables, and a recursive CTE that runs forever. Every one of them must be rejected before execution, and the rejection must not reveal which control caught it.
