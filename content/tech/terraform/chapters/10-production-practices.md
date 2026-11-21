# Production Practices and IaC Choices

Terraform production design is the design of ownership, failure boundaries and change control as much as it is resource configuration. A syntactically valid plan can still delete a production database, expose a network endpoint, or leave a partially applied system. Good operational structure makes the target environment and blast radius obvious before a provider call occurs.

## Environment and repository layout

Separate root configurations by operational boundary. A repository might contain `environments/dev/network`, `environments/staging/network` and `environments/prod/network`, each with its own backend key, provider identity and input values. Shared child modules live under `modules/`. Roots should be small compositions that expose differences explicitly. Avoid a single root with a variable that silently switches credentials and state between dev and prod; a mistaken flag should not be enough to reach production.

Split states according to ownership, lifecycle, apply frequency and failure impact. A network foundation may have a different team and change schedule than an application database. Smaller state reduces contention and makes plans easier to review, but excessive fragmentation creates cross-state dependencies and coordination. Put resources together when they must be updated or retired together, and separate them when access control or failure isolation demands it.

Use dedicated CI identities and approval gates for privileged environments. Restrict who may change backend configuration and provider identity. Keep a clear path from commit to plan to apply and record the actor, revision, environment and plan result. Treat policy changes and provider upgrades as infrastructure changes in their own right.

## Blast radius, lifecycle and deletion

Estimate blast radius by asking which state and resources a change can affect, what downstream services depend on them, whether replacement is possible without downtime, and how to recover data. Require human review for destructive actions and have backup/restore procedures tested before a risky database change. Terraform lifecycle arguments such as `prevent_destroy` can guard selected resources, but they can also prevent legitimate refactors and are not a backup. `create_before_destroy` works only when remote naming constraints and quotas allow overlapping old and new objects.

A `-target` operation is not a general blast-radius control. It can skip dependencies or leave a partial configuration; use it only for a documented recovery task, then run a full plan. `-replace=ADDRESS` asks Terraform to replace a particular object, but it can still cause service impact and should be reviewed like any replacement. `terraform destroy` is intentionally broad; check the selected root, workspace, backend and credentials before using it.

## State surgery and incident recovery

State commands modify Terraform's ownership map, not necessarily the cloud resource. `terraform state mv` can change an address while preserving the association. `terraform state rm` forgets the association but leaves the object running. Import associates an existing object with a declaration. These operations can resolve refactors or adoption, but every action should have an exact address, ID, protected state backup, lock and a maintenance window where appropriate.

A safe recovery sequence is: stop other writers; identify the backend and state serial; back up the state; inspect the remote object and current mapping; make the smallest state operation; run `terraform plan`; review the exact result; then resume normal applies. Do not manually edit state JSON or delete a resource just to make a plan green. If an apply partially failed, inspect actual infrastructure and state before retrying. State restore can roll Terraform's view backward while cloud resources stay changed, so a restore must be followed by careful reconciliation.

## Drift and ownership boundaries

Production should have an explicit owner for every managed field. Terraform, a cloud control plane, Kubernetes, Ansible and operators can each reconcile settings. If two systems own the same property, they may oscillate. Use Terraform for account, network, cluster and service infrastructure as appropriate; use Kubernetes controllers for in-cluster objects; use configuration management for guest configuration when that is the chosen boundary. Exceptions should be documented and imports coordinated.

Run scheduled plans or a drift-detection service to discover out-of-band edits, but do not auto-apply every difference without assessing intent. Some drift is emergency remediation; blindly reverting it may reintroduce an incident. Conversely, leaving undocumented console changes means code no longer describes reality. Record the decision and reconcile either the configuration or the remote object.

## Terraform, OpenTofu, Pulumi and CDK

Terraform uses HCL and a provider ecosystem with a graph-based plan/apply workflow. OpenTofu is a community fork that supports HCL and aims for compatibility, while its releases, licensing, state behavior and ecosystem can evolve separately. Validate exact Terraform/OpenTofu versions and provider/module combinations before switching; compatibility should not be assumed from similar command names alone.

Pulumi allows infrastructure definitions in general-purpose languages such as TypeScript, Python, Go or C#. It can be a natural choice when teams need familiar abstractions, loops, functions and language-native testing. The tradeoff is that arbitrary program logic can make a desired-state diff less transparent and requires language runtime and package management discipline. Terraform's constrained expression model can make configuration easier to inspect, though it can feel less expressive.

Cloud development kits such as AWS CDK let developers define resources in code and synthesize cloud-native templates. They can provide high-level constructs and close integration with one cloud, but may tie the deployment workflow to that cloud's template engine. Choose based on provider breadth, state and governance needs, team language skills, reviewability, ecosystem maturity, and migration cost—not on syntax preference alone. All tools require explicit ownership, credential controls, tests, policy and recovery planning.

## Common mistakes

- Using one root and one state for every production system because it is easy to bootstrap.
- Treating `prevent_destroy` as a substitute for backups and change review.
- Running state commands without a backup, lock or follow-up plan.
- Auto-applying drift without deciding whether the external change was intentional.
- Migrating tools without testing provider, module, state and workflow compatibility.

## Production checklist

Before apply, confirm the root directory, backend key, environment identity, provider selections, lock state, commit and approval. Review all destroys and replacements, policy results and sensitive artifacts. After apply, check the service, audit logs and monitoring, then close the change record. Keep state backups and recovery instructions accessible to authorized responders. Periodically test restoring state, recovering infrastructure and replacing a provider or tool version. A safe Terraform system is one whose operators can explain what it owns, what a plan will change, and how to recover when the apply is partial.

## Operational readiness before a change

Before a high-impact change, name the operator, approver, state owner and service owner. Confirm the plan is based on current state, the target identity is correct, a backup is recent enough for the recovery objective, and monitoring can detect a failed rollout. Decide in advance what result causes a pause or rollback. For a database replacement, a successful Terraform apply is not the rollback plan; rehearse restoration or replication cutover independently.

Maintain an inventory of roots, backend keys, provider aliases and resource owners. When an on-call engineer sees an unfamiliar lock or drift plan, this inventory helps distinguish a normal pipeline from a stranded operation. Store runbooks near the deployment code but keep credentials and state artifacts in protected systems. Record state restoration drills and dependency upgrades so knowledge is not confined to one operator.

Review resource lifecycle settings periodically. `prevent_destroy` may be useful for selected critical objects, but a stale guard can block a migration, and removing it should itself receive scrutiny. Expiration and cleanup policies need clear ownership too. Production safety is not a collection of magic HCL flags: it is a tested system of boundaries, permissions, approvals, backups and operational evidence.
