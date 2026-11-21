# The dbt Model Lifecycle and Project Anatomy

dbt turns a directory of SQL, YAML and Jinja into a directed build graph and a set of database relations. To use it well, follow the lifecycle from project discovery to execution rather than thinking of `dbt run` as a mysterious SQL launcher. The commands are short; the project and target context determine what they mean.

## Start with a project and a profile

A project is the unit dbt parses and builds. Its `dbt_project.yml` names the project and configures paths and defaults. A minimal project often contains:

```text
analytics/
├── dbt_project.yml
├── models/
│   ├── staging/
│   ├── intermediate/
│   └── marts/
├── macros/
├── tests/
├── snapshots/
├── seeds/
├── analyses/
├── snapshots/
└── packages.yml
```

`models/` holds SQL models and YAML properties; `macros/` holds reusable Jinja macros; `tests/` is commonly used for singular data tests; `seeds/` contains small version-controlled CSV inputs; `snapshots/` defines snapshot resources; and `analyses/` is for saved SQL that is not materialized as a model. Some paths are configurable, and real projects may add documentation assets, external tests or custom folders. Do not confuse a folder name with a resource type: a `.sql` file under configured model paths is normally parsed as a model.

The project file controls which directories dbt discovers, defaults such as materialization, and package-specific configuration. Resource-specific properties such as descriptions and tests are usually declared in YAML files within model paths. Configuration is hierarchical: project defaults apply broadly and model config can override them. This helps establish conventions without forcing every model to repeat boilerplate.

Connection credentials are kept in a profile, traditionally `profiles.yml`, rather than committed into project configuration. The profile selects a target with an adapter, account or host, database, schema and authentication. Use environment variables or a managed secret mechanism for credentials. A profile's `dev` target and production deployment target should be intentionally separated; environment names alone do not prevent accidental writes to production.

## Parse, compile, execute

A typical development loop is:

```bash
dbt debug
dbt deps
dbt parse
dbt compile --select stg_orders
dbt build --select stg_orders+
```

`dbt debug` checks the profile and connection. `dbt deps` resolves packages declared in `packages.yml`. `dbt parse` reads the project and produces a manifest describing nodes, configs and dependencies without running model SQL. `dbt compile` renders Jinja and shows the SQL for the selected nodes; compilation can make metadata or warehouse calls depending on adapter and project features, but it is not a substitute for executing a model. `dbt build` runs selected resources in DAG order and includes tests and other buildable resource types. `dbt run` focuses on models only.

This process has a useful distinction: parsing answers “what resources and edges exist?”; compilation answers “what SQL does this project generate for this target and context?”; execution answers “did the target platform successfully build the relation?” A syntactically valid Jinja template can compile to invalid warehouse SQL, and valid SQL can still fail because of permissions, missing source relations, incompatible types or data volume.

Every invocation has a target and execution context. `--target dev` selects a profile target; `--vars` passes project variables; `--select` narrows the graph; and the current branch or installed dependencies define the code being evaluated. Keep these dimensions visible in CI logs. A command that works on one developer's schema may fail in a clean CI schema because it depends on undeclared pre-existing relations.

## The project outputs and artifacts

The main result is database state: views, tables, incremental targets, snapshots and test outcomes. In the `target/` directory, dbt also writes machine-readable artifacts. The `manifest.json` captures the parsed project graph, metadata and configs; `run_results.json` records nodes and statuses for a command; `catalog.json` can hold warehouse-observed column metadata after documentation generation. These files power docs, CI comparisons, state selection and downstream tooling. They are diagnostic and input artifacts, not a replacement for the source project.

`target/` is commonly treated as generated output in development. In production, saving artifacts per invocation is valuable: CI and observability tools need an identifiable previous manifest and run result. Give each artifact bundle a clear environment, commit and invocation context, and avoid allowing concurrent runs to overwrite a shared directory or object-store key.

A dbt command is not inherently a transaction around the entire DAG. Some models may have succeeded before another model fails. Tests may run after a relation has been built. A deployment plan therefore needs to handle partial completion, safely rerun idempotent resources, and avoid exposing half-updated business outputs where the warehouse's materialization behavior permits an atomic swap or versioned release.

## A model lifecycle in practice

An analyst adds `models/staging/stg_orders.sql`, selecting and cleaning from a declared source. A YAML file documents columns and adds `not_null` and `unique` checks. A mart model uses `{{ ref('stg_orders') }}` to express the dependency. In a feature branch, the author installs pinned packages, compiles, builds in an isolated schema and runs tests. Reviewers inspect SQL, config, tests, generated SQL when useful, and the graph impact. After merge, CI or a deployment job builds the production selection using production credentials, then saves artifacts and logs.

The lifecycle is iterative, not linear: a failed test may lead to revised logic, a source freshness failure may indicate ingestion rather than transformation, and a compile error may reveal a missing package or invalid reference. Diagnose by resource and phase. `dbt ls` helps inspect which nodes the project contains; `dbt compile --select ...` narrows SQL-generation problems; warehouse query history helps investigate execution cost or platform errors; test output points to failing expectations.

## Common mistakes

- Committing credentials or target-specific secrets in `dbt_project.yml` or checked-in profiles.
- Treating `dbt run` as a full quality gate; it does not run data tests. Use `dbt build` or explicitly run `dbt test`.
- Assuming `dbt compile` proves that data will build successfully. Compilation does not guarantee warehouse execution or data correctness.
- Reusing a developer schema as the only test environment, hiding undeclared dependencies on old relations.
- Ignoring `target/` artifacts in production workflows even when slim CI or docs generation depends on them.

## Production notes

Pin compatible dbt and adapter versions, lock package versions, and test upgrades before promoting them. Keep project code portable where that is practical, but acknowledge adapter-specific SQL and materialization behavior explicitly. Separate development and production credentials and schemas, store generated artifacts by commit or run, and make the deployment selection deliberate. dbt manages transformations; it does not own ingestion, warehouse administration, or every release-coordination decision around consumer-facing data.

A repeatable development session should record the commit, target name, installed adapter and dependency lock alongside the command output. When two developers report different results, compare those inputs before comparing SQL: target schemas can hold different historical relations, package versions can render different macros, and profiles can point to different warehouse accounts. A small run manifest in CI logs makes “works on my machine” a diagnosable difference rather than a guess. For sensitive targets, verify the active target before any command that can write, and ensure the credentials cannot silently fall back to production.
