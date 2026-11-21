# Testing, CI and Choosing the Right Tool

Ansible content is executable operations code, so review and testing should cover more than YAML syntax. A playbook can parse correctly and still select the wrong hosts, render invalid configuration, make a non-idempotent change or fail halfway through a rollout. A useful test strategy combines static checks, integration tests in disposable environments, check mode where supported, and controlled production rollout.

## Static checks and execution previews

`ansible-playbook --syntax-check site.yml` checks basic playbook syntax and some structural issues. `ansible-lint` checks common quality and correctness patterns, including FQCN usage, risky shell commands and task naming. Configure lint rules intentionally and pin the tool version in CI. A linter is not a full proof: it cannot determine whether production inventory is correct or whether an application is healthy after a reload.

`ansible-playbook --list-hosts` shows the host set selected by inventory and patterns; `--list-tasks` shows task ordering. `--check` asks supported modules to predict changes without applying them, and `--diff` displays proposed file differences for compatible modules. Some modules have partial or no check-mode support, and tasks can behave differently when previous registered values are absent in check mode. Treat these as review aids, not as a transaction or a guarantee of no side effects. Protect secrets from diff output and use a non-production target for unknown workflows.

`ansible-playbook --check --diff` is most useful when the play is designed to support it: modules declare state, validations are safe, and commands do not make uncontrolled changes. A task with `check_mode: false` still executes in check mode by explicit instruction and should be highly exceptional. Document such tasks so pipeline users understand that the preview can perform real work.

## Molecule and integration tests

Molecule is a testing framework commonly used to exercise Ansible roles and collections with scenarios that create an environment, converge it, verify it, and destroy it. The exact drivers and workflows depend on the installed Molecule version and project configuration. A test should validate the resulting service, file permissions, package state or API behavior, then run convergence again to check idempotency. An empty verifier that always succeeds does not establish correctness.

Tests should target the supported platforms and role inputs, not every imaginable combination. Use containers for fast tests only when the role behavior is valid in a container; systemd, kernel features, package services and privilege boundaries may differ from a real VM. A disposable virtual machine or integration environment can catch issues that a container misses. Keep tests isolated from production credentials and production inventory.

At the project level, use a reproducible controller environment that pins `ansible-core`, collections, Python dependencies, `ansible-lint` and Molecule as needed. `requirements.yml` declares collection dependencies; Python dependency declarations and the execution environment image pin controller libraries. A `Makefile` or documented commands can standardize lint, syntax check and integration test execution. Tests should run against the same dependency set as deployment.

## A practical CI pipeline

A CI pipeline can follow a sequence such as:

1. Check formatting and lint rules.
2. Run syntax checks and inspect test inventory selection.
3. Run role or playbook integration tests in disposable targets.
4. Validate idempotency with a second converge run.
5. Build or select the immutable execution environment and publish its version.
6. For deployment, require approval, select a canary, record the commit and inventory, then expand in batches after health checks.

Separate validation from deployment credentials. Pull requests from untrusted forks should not receive production secrets. Store vault credentials in protected CI variables or a credential manager and scope them to the deployment job. Ensure logs and artifacts do not retain secret values. A green CI job means the checks passed under the tested conditions; it does not mean every production host is healthy.

## When to choose Ansible, Terraform or neither

Use Ansible when the primary work is configuring operating-system state, managing files and services, deploying software to existing hosts, or coordinating operational steps across machines. It is particularly convenient when SSH-based access already exists and agentless execution is valuable. It is not inherently a desired-state database for cloud resource lifecycle, and playbook behavior can depend on controller environment, inventory and execution order.

Use Terraform when the primary work is provisioning and managing infrastructure resources through provider APIs: networks, instances, disks, IAM objects and managed services. Its plan and state model help reason about resource lifecycle and dependencies. Terraform can invoke configuration tools, but provisioning and host configuration have different ownership and drift models. A clean boundary is often Terraform to create the host and its access path, then Ansible to configure it. Avoid two tools both claiming authority over the same property.

Use a configuration-management-free approach when immutable images, containers, serverless platforms or managed services make ongoing host mutation unnecessary. Baking a versioned image and replacing instances can produce simpler rollback and lower drift than repeatedly converging mutable servers. Cloud-init can handle small first-boot tasks. The tradeoff is that image build, rollout and observability become central; eliminating Ansible does not eliminate operational work.

The choice depends on lifecycle, team skill, fleet size, audit requirements and failure recovery—not on a universal tool ranking. A small static fleet may be maintained with a few well-tested playbooks; a dynamic cloud platform may benefit from image-based replacement and provider-native resource management. Use the smallest tool set with clear ownership boundaries.

The deployment step should also handle concurrency and change control. Two pipeline runs targeting the same environment can interleave tasks, overwrite release variables or restart the same service unexpectedly. Use the CI platform's environment lock or another single-writer policy for high-impact deployments, and make the selected revision immutable for the run. Record who approved it, which inventory was resolved, the execution environment digest, and the resulting health checks. A rollback should name a known-good artifact or image, not just rerun an older playbook against an unknown current state. For infrastructure provisioning, review Terraform plans and outputs before the configuration stage; do not allow an Ansible run to begin with stale host data. These controls make failures attributable and allow an operator to repeat or halt a rollout with confidence.

## Common mistakes

- Equating syntax check or lint success with safe production behavior.
- Trusting check mode for a module or command that does not support meaningful prediction.
- Testing only the first converge and never checking idempotency.
- Running CI with mutable collection versions or a developer-specific Ansible installation.
- Giving production credentials to arbitrary pull-request jobs.
- Using Terraform and Ansible to continuously overwrite the same resource settings.

## Production notes

Test data should include a representative inventory shape and variable sources, but avoid production secrets and live production APIs. Include a negative test for a missing required variable and a targeting test that confirms a production play cannot accidentally select unrelated groups. For a role, test defaults and at least one supported override; for a playbook, test the orchestration path and failure handling. Store the CI logs and test reports for diagnosis, but scrub secrets and avoid retaining rendered credential files as artifacts. Use dependency update automation to propose newer collection and tooling versions in a branch where the full test suite can run. Treat a skipped integration test as an explicit risk decision, not equivalent to a passed test. Document manual approval and rollback steps next to deployment instructions so an operator can follow the tested procedure during an incident.

Pin the execution environment, lint and test dependencies. Test both a clean installation and a no-change second run. Record the exact inventory, commit and dependency set for deployments, and stage changes through canaries and health checks. Choose Ansible, Terraform or immutable-image workflows according to which tool should own each lifecycle boundary; the safest design may deliberately use no ongoing configuration-management system.