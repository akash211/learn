# Testing Terraform and CI Plans

Terraform's `validate` command catches syntax and type problems, but it cannot establish that an infrastructure change is correct, safe, or accepted by the target API. Reliable testing combines cheap static checks, provider-aware planning, policy evaluation, module-level tests and operational verification. The objective is to discover mistakes as early as possible without creating costly or destructive resources in a test environment.

## A layered validation workflow

Start with formatting and initialization, then validate:

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform providers lock -platform=linux_amd64
```

`fmt -check` verifies canonical formatting without modifying files. Initializing with `-backend=false` installs modules and providers for validation without connecting to a configured remote backend; CI still needs a controlled provider installation path and lock file. `validate` checks configuration syntax and internal consistency, not live credentials or cloud policy. Use `terraform test` for native module tests where supported by the Terraform version; tests can invoke plans and applies, so inspect their fixtures and cleanup behavior.

Static tools can catch common issues that Terraform's own checks do not: security misconfigurations, unused declarations, and policy violations. Pin tool versions, configure rules explicitly, and separate findings that are mandatory from advisory warnings. Static scans should not be treated as proof: they may miss dynamic values or flag intentional patterns. A plan provides provider-resolved changes and is a much stronger context for many policy checks.

## Plan in CI

A pull-request pipeline should use an isolated, read-only or low-privilege identity for plan where provider permissions permit, then create a plan artifact tied to the commit and exact root. A typical structure is:

```bash
terraform init -input=false
terraform validate
terraform plan -input=false -no-color -out=tfplan
terraform show -no-color tfplan
```

The pipeline can render machine-readable plan JSON with `terraform show -json tfplan` for policy evaluation, but the JSON can contain sensitive values. Protect it and avoid posting raw values into pull request comments. A compact summary should report resource actions and link to a restricted artifact. Require approval for production applies and ensure that the approved artifact is the one being applied, not a newly generated plan.

CI concurrency groups should prevent simultaneous applies to the same state. Backend locking is still required because manual runs or other pipelines may use that state. Use the same Terraform binary and lock-file selections for plan and apply. Use `-lockfile=readonly` in workflows that must not modify dependencies; a deliberate upgrade workflow can update and commit lock selections.

`-detailed-exitcode` is useful in CI: exit code 0 indicates no changes, 2 indicates a successful plan with changes, and 1 indicates an error. Handle these codes explicitly rather than treating every nonzero result as a failed plan. Do not use `-auto-approve` as a shortcut around review; it belongs only in a pipeline with a defined approval gate and scoped credentials.

## Unit and integration tests

Terraform native tests can exercise modules with mock providers or test-specific configurations, depending on Terraform version and provider support. They are useful for checking interface behavior, validation conditions, resource argument values and module composition without depending on a live production account. Keep tests small and deterministic; tests should be clear about which provider calls they make and whether a real apply occurs.

Terratest is a Go library commonly used for integration tests that run Terraform against real infrastructure. It can create an environment, assert externally observable behavior, and destroy test resources afterward. Real-cloud tests catch provider/API differences that mocks cannot, but they require isolated accounts, quotas, cost controls, timeouts and robust cleanup. Use unique names and ensure cleanup runs even when assertions fail. Never run destructive integration tests against shared production state.

OPA tests can validate policy rules against plan JSON fixtures. Include positive examples that must pass and negative examples that must fail. A policy with only rejection fixtures may accidentally reject every plan; test its expected allow path. Review exceptions and version the policy alongside its tests.

## Test boundaries and safety

A saved plan is a tested proposal, not a guarantee of success. Remote APIs can change, permissions can expire, and external objects can drift before apply. End-to-end tests should verify actual application behavior and infrastructure health after apply. Terraform tests do not replace cloud monitoring, backup validation, failover exercises or security review.

For module tests, focus on public behavior: valid inputs produce intended resource settings and outputs, invalid inputs fail with useful diagnostics, and dangerous combinations are rejected. Avoid asserting every incidental internal resource attribute; that makes refactoring unnecessarily expensive. For integration environments, use the same module version and relevant provider versions as production while keeping accounts and state separate.

## Common mistakes

- Treating `terraform validate` as an API or security test.
- Posting a plan JSON or saved plan containing secrets into a public build artifact.
- Applying a freshly regenerated plan instead of the artifact that was reviewed.
- Allowing parallel CI jobs to write the same state.
- Forgetting to destroy test infrastructure after failed assertions.

## Production notes

Keep fast checks on every change and reserve live integration tests for controlled environments. Make the PR pipeline's root, backend, commit and identity explicit. Policy checks should consume the same plan proposed for apply, and an approval must bind to that plan. After deployment, test service-level behavior and alert on operational regressions; infrastructure API success is only one layer of correctness.

A green pipeline must also make clear which tests were mocked and which touched a real API. Report that distinction beside the plan summary, so reviewers do not mistake fast synthetic coverage for evidence of cloud-side behavior.

## Keep the workflow reproducible

CI should run from a clean checkout so undeclared local files cannot affect Terraform evaluation. Select the working directory explicitly, pin the CLI binary, initialize with the committed lock file, and pass required variable files intentionally. Avoid running `init -upgrade` in ordinary pull-request checks. If a validation job does not need a backend, `terraform init -backend=false` can prevent accidental access to production state, but planning still needs the correct backend and appropriate credentials.

For no-change detection, `terraform plan -detailed-exitcode` returns 0 when no changes are proposed, 2 when a plan succeeds with changes, and 1 on error. CI must handle these statuses explicitly. Locking should exist at the backend and workflow level; serialize applies by state key and retain backend locks for manual clients. Keep plans private and short-lived, and bind approval to the same commit and plan bytes.

Test teardown as a separate acceptance criterion. Integration tests should use isolated accounts, unique names, budgets or quotas, and cleanup that runs after both success and failure. A cleanup failure should alert an owner rather than silently leak infrastructure. Periodically audit test identities and residual resources so temporary test permissions do not become permanent production access.
