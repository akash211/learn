# Macros, Jinja and Packages

Jinja is dbt's templating language for configuration, reusable SQL generation and project-aware references. It is powerful because SQL can be parameterized and adapted to the current target; it is risky because too much generated SQL can obscure the actual query. Use templating to remove genuine repetition or express controlled variation, not to build a second programming language inside your warehouse project.

## Jinja in a model

A model may call `ref()` and `source()`, use variables, inspect configuration or conditionally include SQL. dbt renders the template before handing SQL to the adapter. The `{{ ... }}` delimiters evaluate an expression; `{% ... %}` controls flow or statements; `{# ... #}` is a Jinja comment removed from compiled SQL. For example:

```sql
select
    order_id,
    {{ cents_to_currency('amount_cents') }} as amount
from {{ ref('stg_orders') }}
{% if target.name == 'dev' %}
where ordered_at >= dateadd(day, -30, current_date)
{% endif %}
```

Environment-conditional logic can make development cheaper, but it can also create divergent results and hide defects. A dev-only row limit should not silently change joins, grain or business rules. Prefer representative dev data or explicit variables with documented defaults, and compile against the same adapter and meaningful inputs as production.

Project variables are supplied through `dbt_project.yml` or `--vars` and accessed with `var()`. Environment variables are read with `env_var()` and are commonly used for credentials or deploy-time settings. Secrets should not be emitted into SQL, logs or artifacts. Avoid a proliferation of flags that turns every model into a configuration matrix nobody can test.

## Write a macro when reuse earns its cost

Macros are Jinja functions stored in `macros/`. They can return SQL fragments, generate repeated expressions or implement adapter-aware operations. A simple macro may standardize a cents conversion or null-safe comparison. A macro should have a clear contract: accepted inputs, output SQL and assumptions. Use meaningful names and comments, and write a small model or test that demonstrates the generated SQL.

The more a macro controls the whole query, the harder it is to reason about compiled output and lineage. Keep model-level business logic visible where possible. Prefer ordinary SQL CTEs for one query's steps; use macros for repeated patterns or behavior that genuinely varies by adapter. After changing a macro, inspect compiled SQL and run representative models: a shared macro change can alter many graph nodes even when their model files did not change.

Adapter dispatch allows projects or packages to define implementations for different adapters behind a common macro interface. This can make an abstraction portable, but only if each implementation has matching semantics. Dispatch is not a guarantee that SQL syntax or transaction behavior is identical across platforms. Test all adapters the project claims to support.

## Packages add reusable resources

Packages are dependencies declared in `packages.yml`, then installed by `dbt deps`. They may provide macros, tests, models or documentation. A common example is `dbt_utils`, which provides utilities such as surrogate-key generation and reusable generic tests. A model can invoke a package macro with a namespace, for example `dbt_utils.generate_surrogate_key([...])`, assuming the dependency version includes that macro.

Pin package versions or use a checked-in lock file as appropriate for the project's dbt version, and review package changes like code changes. Package installation affects the compiled project and can introduce behavior or compatibility shifts. Avoid adding a dependency for a one-line expression unless central reuse, correctness or maintenance justifies it. Verify package license, maintenance and adapter support according to team policy.

A dependency should not be treated as trusted simply because it is popular. Read macro SQL when it touches key generation, quoting or warehouse operations. A surrogate key is only as good as its null handling, serialization and chosen fields; adding a package does not decide business identity. Test representative edge cases such as null values, delimiters and data-type conversions.

## Keep generated SQL debuggable

Compilation is the bridge between Jinja source and warehouse query. Use `dbt compile --select model_name`, then inspect the corresponding file under `target/compiled/` when debugging. The compiled artifact shows rendered SQL but not always the exact warehouse execution wrapper. If compiled SQL is valid but execution fails, inspect adapter error details and query history too.

Jinja can make a model's dependency graph incomplete if references are dynamically constructed or hidden in logic the parser cannot inspect. Keep `ref()` and `source()` calls literal and statically visible. When programmatically generating many models, be especially careful that all nodes and references exist at parse time and that generated resources have stable names.

Macros also affect state-based CI. A macro change can change compiled SQL for dependent nodes; ensure your state selection and tests account for macro modifications. A single utility macro used by hundreds of models has a broad blast radius. Selectors like `state:modified+` can help include affected descendants when state artifacts are set up correctly, but verify the selected set.

## Common mistakes

- Hiding a model's full business logic in nested macros, so reviewers cannot understand compiled SQL from the source file.
- Using `run_query()` or metadata queries in parse-time code without guarding execution; it can break parsing or produce environment-dependent project graphs.
- Building dynamic `ref()` names that dbt cannot record as edges.
- Updating packages without pinning or reviewing transitive changes.
- Treating a macro as portable when its implementations differ semantically across adapters.

## Production notes

Keep generated SQL small enough to inspect and keep macro interfaces stable. Use package locks and CI to catch dependency resolution drift. Avoid executing side-effecting SQL from macros during parse, and do not leak credentials through rendered output. For important shared macros, build focused fixtures or test models and include their dependents in upgrade validation. The goal is less duplicated code without losing the transparency and reviewability that made SQL models valuable.

A good macro review asks whether callers can infer the generated SQL from the interface, whether arguments are validated or documented, and whether all supported adapters preserve the same business meaning. If a macro has many Boolean switches, hidden warehouse queries or repeated nested dispatch, separate its responsibilities or move the logic back into a model. Build small compile fixtures for edge cases such as empty lists, null arguments and unusual identifiers. Keep package upgrades in their own review when possible: a lockfile change plus a generated SQL diff is easier to assess than combining dependency churn with business logic changes. Record the macro's expected output in comments or tests and inspect compiled artifacts for a representative caller after edits.

When a macro must call `run_query()` or inspect the warehouse, separate parse-time behavior from execution-time behavior using the appropriate dbt context safeguards. Parsing should remain deterministic so dbt can construct one consistent graph without depending on whether a warehouse is reachable at that moment. Such macros can also behave differently under documentation generation, compile-only commands and CI, so test those paths explicitly. Prefer a static project graph with dynamic SQL generation limited to the query body; this makes selection, state comparison and review more predictable.
