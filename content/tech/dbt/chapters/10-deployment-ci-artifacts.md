# Deployment: Core, Cloud, CI and Artifacts

Deploying dbt means taking reviewed transformation code and running it against a deliberate target with the right credentials, dependency versions, selection and recovery plan. dbt Core and dbt Cloud can both execute dbt projects, but their operating models differ. A reliable release process makes those differences explicit and preserves enough run information to reproduce and diagnose a deployment.

## Core and Cloud: separate engine from platform

dbt Core is the open-source command-line framework and project engine. A team installs `dbt-core` with a compatible adapter, configures profiles and credentials, then runs commands in developer machines, CI workers or infrastructure it operates. The team chooses its scheduler, secret storage, artifact retention, worker isolation, alerting and deployment design. This provides operational control and flexibility, but the team owns that supporting system.

dbt Cloud is a hosted platform that provides managed development and orchestration capabilities around dbt projects, such as environments, jobs, permissions and a web interface, depending on the product configuration. It reduces the need to build some platform operations yourself, but it does not make warehouse permissions, project quality or release policy disappear. Cloud jobs still run project code against data platforms using configured environments. Core and Cloud should not be described as different SQL transformation languages; they share the project concepts while differing in product services and management surface.

Choose based on organizational requirements: who will operate schedules and workers, how secrets and access are governed, what audit and collaboration features are needed, and how the existing CI/orchestration system works. Avoid selecting only by the number of command-line scripts. Consider ownership of upgrades, artifact storage, reliability, network access and incident response.

## Environments and deployment targets

A developer environment should isolate writes, commonly using a per-developer schema or database. CI should use a temporary or dedicated target that does not collide with production. Production credentials should be available only to the deployment identity and should have the minimum permissions needed for model builds, tests, snapshots and required metadata operations. Keep profile configuration and secrets out of Git.

Environments can differ in target name, database, schema, variables, warehouse size or branch. Use these differences intentionally and avoid changing business logic between targets. A `target.name` condition that filters data in dev can help control cost but may leave code paths untested; add representative tests or an explicit integration run. A clean target is especially useful because it reveals hidden dependencies on relations left behind by previous executions.

Promotion can mean rerunning the same commit in production, building a release schema and switching consumers, or another warehouse-specific pattern. The approach should state how consumer availability is preserved, how schema changes are applied, and how rollback works. A dbt DAG run is not necessarily one transaction, so failures can leave some relations updated and others old. Idempotent builds and stable consumer interfaces reduce risk.

## CI and slim CI

A basic pull-request check validates dependencies, parses or compiles the project, builds selected models in an isolated schema, and runs relevant unit and data tests. A conventional full build is simple and thorough but may be too slow for a large project. Slim CI uses a previous production manifest as comparison state and selects nodes that are new or modified plus affected descendants, for example:

```bash
dbt build --select state:modified+ --state path/to/prod-artifacts
```

The `+` includes downstream dependents of changed nodes; selection operators can be combined with other rules. Always check the resulting selection with `dbt ls --select state:modified+ --state path/to/prod-artifacts` before relying on it. Depending on project policy, include tests explicitly or use `dbt build` so selected tests run. A selector alone does not create missing ancestors; a valid base environment or an expanded upstream selection may be needed.

The comparison manifest must come from the intended prior state and must not be overwritten by the current invocation before selection. Separate current `target/` output from downloaded baseline artifacts, or use a distinct state directory. State comparison is based on dbt's parsed manifest and resource changes, not merely changed file names in Git. Changes to shared macros, configs, contracts or dependencies can affect many nodes. Verify selector behavior after dbt upgrades and keep a full-build path for periodic validation.

Slim CI can also use deferred relation resolution so unchanged upstream models resolve to existing relations from a production manifest rather than being rebuilt in CI. Deferral is not an excuse to test against stale or incompatible upstream schemas: track which state artifact is used, control target/schema mapping, and use clean builds periodically. Tests may need a complete environment even if model execution is slim.

## Artifacts, observability and recovery

`manifest.json` describes the parsed project and graph; `run_results.json` records statuses and timing for command nodes; `catalog.json` contains introspected relation metadata after docs generation. Store the artifacts with commit SHA, job ID, target and timestamp so they can be matched to code and environment. Do not share mutable artifact paths across parallel jobs. Artifact retention supports slim CI, documentation, lineage integrations, operational monitoring and incident review.

A successful process exit is not the only operational signal. Record which selection ran, whether source freshness was checked, what tests failed or warned, and which relations were changed. Monitor duration, warehouse query cost, test failures and freshness. A run can partially succeed; preserve per-node results and identify downstream outputs that might need rebuilding or withholding.

For recovery, determine whether rerunning the same selection is safe, whether an incremental model needs a lookback repair or full refresh, and whether a snapshot history could be damaged by replacing its target. Avoid “rollback” by rerunning unreviewed old SQL against changed data. A documented rollback could mean repointing consumers to a previous schema, restoring a warehouse clone, or applying a corrective build; choose and test the method appropriate to the platform.

## Common mistakes

- Using a production manifest and current `target/` in the same directory so state files are overwritten before comparison.
- Selecting `state:modified+` without checking the selected nodes or including necessary tests.
- Assuming Cloud schedules remove the need for source control, environment separation or warehouse least privilege.
- Running CI in a shared schema where concurrent pull requests overwrite one another.
- Claiming a deployment is atomic when several model relations can update before a later node fails.

## Production notes

Pin Core, adapter and package versions and upgrade through a representative CI run. Define immutable artifact storage keyed by commit and invocation. Use a non-production target for pull requests, least-privilege production credentials, and explicit production selection. Keep full-build and recovery procedures documented even when slim CI is the normal path. Deployment quality is measured not by a green command alone, but by a reproducible run, verified outputs, known lineage and a recovery path that the team has rehearsed.
