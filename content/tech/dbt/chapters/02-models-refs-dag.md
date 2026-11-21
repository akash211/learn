# Models, refs and the DAG

A model is usually a `.sql` file containing a query that defines a relation. dbt's most important job is not to add another SQL dialect; it is to turn those model files and their references into a graph that can be selected, ordered, documented and tested. If the graph is wrong or incomplete, a successful command may still build an incorrect dataset.

## Models describe transformations

A staging model commonly selects from one raw source and applies consistent naming, type casting and basic cleanup. An intermediate model joins or reshapes business entities. A mart model presents facts and dimensions for consumption. These are conventions rather than mandatory directories, but layers help teams decide where logic belongs and which relations are stable interfaces.

A model should have an intentional grain: what one row represents. For example, `fct_order_items` may have one row per order line, whereas `dim_customers` aims for one row per customer. Grain is a business and data-design concept, not something dbt can infer from the filename. Tests such as `unique` on the key and reconciliations can enforce it. Without an explicit grain, joins can multiply rows and aggregates can appear plausible while being wrong.

A model's SQL is a `SELECT` statement. dbt wraps or adapts it according to its materialization and adapter. Do not place a semicolon-driven deployment script or assume one model file can perform arbitrary multi-statement operations. For repeated logic, prefer a model reference or macro only when the abstraction helps. Models should express a meaningful transformation boundary, not every SQL clause broken into a separate file.

## `ref()` is both name resolution and dependency

Use `{{ ref('stg_orders') }}` where a downstream model reads an upstream model. dbt resolves the model name to the relation appropriate for the active target and records a graph edge. That edge drives build order, selection syntax, lineage and environment-specific schema resolution.

```sql
-- models/marts/fct_orders.sql
select
    order_id,
    customer_id,
    ordered_at,
    order_total
from {{ ref('stg_orders') }}
```

A hard-coded `analytics.stg_orders` bypasses this contract. It can accidentally read production while building a development branch, fail in an isolated schema, or refer to a relation with a different name. `ref()` preserves indirection so dbt can use configured database, schema and alias rules.

`ref()` creates a dependency only when dbt can discover it during parsing. References inside a Jinja branch that is never evaluated for parsing, constructed dynamically from strings, or hidden inside opaque SQL can be difficult or impossible for the parser to infer. Use explicit references and deterministic project logic. If a dependency is intentionally indirect, declare it with a documented `-- depends_on: {{ ref('...') }}` comment in a model where appropriate; don't use comments as a substitute for ordinary static references.

For versioned models, `ref()` can target a version explicitly, such as `{{ ref('customers', version=1) }}`, allowing controlled migration between schemas. Versioning is useful when a breaking change cannot be coordinated across every consumer, but creates a maintenance obligation: document supported versions, migrate dependents and remove old versions only through an intentional deprecation process.

## Sources are graph nodes too

Raw tables not built by this project should be declared in YAML as sources and referenced with `{{ source('app', 'orders') }}`. This records lineage and allows dbt to attach source descriptions, tests, freshness rules and database/schema configuration. A source node is a declared upstream interface, not a promise that dbt controls the ingestion process.

A project can therefore represent raw source → staging model → intermediate model → mart. Each `source()` or `ref()` declaration makes an edge visible. If a model instead directly names a physical table, dbt cannot reliably infer that dependency; source freshness, selector expansion and lineage may omit it.

## DAG and selection semantics

The DAG is a directed acyclic graph: edges point from upstream inputs to downstream outputs, and cycles are invalid because a model cannot be built before its own result exists. dbt topologically orders selected nodes. A chain `source → stg_orders → int_order_items → fct_orders` can be selected with `dbt run --select fct_orders` for just the node, or `dbt build --select +fct_orders` to include ancestors and the selected model. A trailing plus selects descendants; `fct_orders+` means the model and downstream nodes, while `+fct_orders+` includes both sides. Selectors can include paths, tags, resource types and set operations, so inspect them carefully.

Selection is not a promise that all prerequisites will be rebuilt. A selection may assume unselected upstream relations already exist. In CI, selecting changed models and descendants is efficient, but only if a valid base state exists and the right tests are included. A selector such as `state:modified+` uses a prior manifest to find modified nodes and their descendants; it is not equivalent to selecting every model changed in Git text diff.

`dbt ls --select ...` is a good safety check before expensive or destructive commands. Confirm that a selector includes the intended models, tests and resource kinds. `dbt build` executes selected resource types in dependency order where supported; selection details can affect whether a test runs, whether its parent is included and what already-built upstream relations the test reads.

## DAG as an architectural boundary

The graph is more than a scheduler plan. A model's parents communicate its inputs, and its children communicate potential impact. If a model depends on an upstream model in another domain, the edge makes the coupling visible. A good project keeps models understandable, limits unnecessary cross-layer dependencies, and treats public marts as stable interfaces. Avoid hiding business logic in giant macros or duplicating SQL in separate models, because both practices make actual dependencies harder for readers to reason about.

The graph also improves parallelism: independent branches may run concurrently, subject to the warehouse and dbt invocation limits. Excessively fine-grained models can create many tiny queries and overhead; excessively broad models make failure recovery and ownership difficult. A sensible node represents reusable logic, a clear grain or a meaningful contract, with testable behavior and an owner.

## Common mistakes

- Using hard-coded relation names instead of `ref()` or `source()`, which hides dependencies and weakens environment isolation.
- Expecting a model's filename to declare its grain or uniqueness. Those properties must be designed and tested.
- Selecting a leaf with `dbt run --select model` and assuming its ancestors are built automatically; use `+model` when that is intended.
- Using `model+` when only upstream prerequisites were needed, thereby pulling in downstream work unnecessarily.
- Building dynamic `ref()` strings that the parser cannot resolve into graph edges.

## Production notes

Use `dbt ls --select` during selector development and keep CI selection rules in version control. Review graph diffs when changing a shared staging model or a public mart. Establish which models are stable interfaces and document ownership; a graph with many edges is not inherently bad, but unexplained edges across domains are a prompt to review the architecture. Graph correctness is a prerequisite for reliable incremental selection, lineage and deployments.
