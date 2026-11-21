# Materialisations and Choosing the Right One

A materialization determines how dbt turns a model's query into a database object. The same `SELECT` can become a view, table, incremental table or ephemeral common-table expression (CTE), but those choices change build cost, query behavior, storage and downstream dependencies. Choosing one is an architectural decision, not just a speed toggle.

## View: always compute from current inputs

A view stores a query definition and evaluates it when a consumer queries the view. dbt's default materialization is often a view unless project configuration changes it. Building a view is usually fast because dbt creates or replaces the definition rather than reading all source rows into a new table. It is useful for staging transformations that are lightweight and need to reflect upstream changes immediately.

The cost is deferred to the consumer. A complex chain of views can cause a dashboard query to expand into many joins and repeated scans. Warehouse optimizers can inline views well, but a view is not automatically cached and does not make an expensive transformation cheap. Permissions and replacement behavior also vary by platform; downstream consumers should not depend on implementation details such as a view's internal SQL text.

## Table: persist a full result

A table materialization executes the model query and stores its complete result. It shifts work to the dbt build and gives downstream queries a stable, usually faster-to-read object. Tables fit frequently reused or expensive transformations, curated marts, and workloads where a consistent physical snapshot between builds is valuable.

A table rebuild usually scans all required inputs and replaces or recreates the target relation according to adapter behavior. That can be wasteful for huge append-oriented histories, and it means build duration and warehouse cost scale with the full result. Some platforms can perform atomic replacement, but teams should not assume every adapter and DDL path has identical guarantees. Building into an isolated schema and promoting a tested result can reduce consumer exposure to partial release states.

## Incremental: process a bounded change set

An incremental model materializes a table and uses adapter-generated SQL to add or update a subset of rows on later runs. The first build (or a `--full-refresh`) creates the baseline; subsequent runs follow model SQL guarded by `is_incremental()` and a selected strategy. Incremental can be the right choice for very large facts or event histories where rebuilding everything is too expensive.

Incremental is not “automatically only new rows.” The model author must define a correct filter, a strategy and key semantics. If late records, updates or deletes are ignored, the table drifts from a full rebuild. A `unique_key` guides supported merge or delete-and-insert strategies; it does not make incoming data unique by magic. Incremental models need explicit recovery and reconciliation plans, discussed in the next chapter.

## Ephemeral: compile into downstream SQL

An ephemeral model is not created as a warehouse relation. When another model references it, dbt injects its SQL into the dependent query as a CTE. This can keep small, reusable transformations out of the schema and is useful for simple logic that only exists to organize SQL. It also means there is no standalone table to query, inspect or test directly in the warehouse, and repeated references can duplicate compiled query logic.

Deep chains of ephemeral models can yield giant SQL statements, poor compilation diagnostics or optimizer stress. Ephemeral models do not support every feature available to relation-backed models, and they are not suitable when consumers need a persistent interface, independent access controls, or materialization-level monitoring. Use them sparingly for small compositional steps rather than hiding a substantial pipeline.

## Compare costs and requirements

| Materialization | Persists a relation? | Main benefit | Main trade-off |
|---|---:|---|---|
| `view` | Yes, as a view definition | Low build work; reads current upstream state | Query-time work and potentially deep view chains |
| `table` | Yes, as stored data | Predictable query performance and reusable result | Recomputes the full result at build time |
| `incremental` | Yes, as a table | Limits work when the change set is correct | More state, logic and recovery complexity |
| `ephemeral` | No | Reusable SQL without an extra relation | Inlined SQL; no direct relation or independent reuse |

Other options exist, such as materialized views, but support and semantics are adapter-specific. Do not conflate a dbt `view` with a warehouse materialized view. Before selecting a non-core materialization, check adapter support, refresh semantics, permissions and deployment behavior for the exact target.

## Choose from the consumer and data shape

Start by asking what the downstream consumer needs and how often the model changes. If the model is lightweight staging SQL and source freshness matters, a view may be enough. If it is expensive and reused by many dashboards, a table may be easier to operate. If it has billions of historical rows with a small, well-defined update window, incremental processing may justify its extra state and testing. If the SQL is only a tiny helper and no one needs a relation, ephemeral can reduce schema clutter.

Then ask how failures are recovered. A full table build may be easy to rerun; an incremental build can require a targeted repair window or full refresh. Consider whether the warehouse's cost is paid per query, storage or compute, whether consumers need isolation from changing upstream data, and whether the target supports the strategy's DDL and transactions. Materialization belongs in project config or model config, but operational intent should also be documented.

A familiar layering convention is views for staging, ephemeral for very small intermediate helpers, and tables or incrementals for marts. Treat it as a starting point, not dogma. A single-use, costly staging view could be a bad fit; a tiny dimension can be rebuilt as a table every run. Measure query plans and warehouse history rather than choosing purely from the directory name.

## Common mistakes

- Using `incremental` just because the source is large, without proving the filter captures updates and late arrivals.
- Assuming a `table` guarantees consumers never see a partially deployed release; verify adapter DDL and publish strategy.
- Calling a regular view “cached.” It stores a query definition, not necessarily the result.
- Marking many large models ephemeral and then wondering why compiled SQL is huge.
- Switching a model's materialization without considering existing target relations, schema changes and dependent permissions.

## Production notes

Record why a large model is incremental and what command or procedure repairs it. Track build duration, bytes scanned, query latency and full-refresh frequency. A materialization is a contract between a transformation and its consumers: changing from a view to a table or dropping a persistent relation can affect grants, freshness expectations and downstream tools. Validate behavior on the actual adapter because dbt's abstraction does not erase warehouse-specific DDL details.
