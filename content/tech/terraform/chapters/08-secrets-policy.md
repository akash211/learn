# Secrets, Sensitive Values and Policy as Code

Infrastructure configuration often handles passwords, private keys, tokens, connection strings and outputs that reveal sensitive topology. Terraform's `sensitive` marking helps prevent accidental display in CLI output, but it does not encrypt or erase a value. A secure design begins with reducing the amount of secret material Terraform ever sees, then protecting state, plans, credentials and logs that remain.

## What sensitive means

Mark an input variable as sensitive to redact it from common plan and apply output:

```hcl
variable "database_password" {
  description = "Password supplied by the deployment secret manager."
  type        = string
  sensitive   = true
}

resource "example_database" "main" {
  username = var.database_user
  password = var.database_password
}
```

A sensitive value can flow through expressions to another value, and Terraform propagates sensitivity in many cases. A sensitive output should be explicitly marked. Redaction affects presentation; the provider still receives the value, state may store it, and a saved plan can contain it. A user with state or plan access may recover it. Do not commit state or plan files, and do not print secret values via `terraform console`, shell tracing, debug logs or CI echo statements.

Terraform's `ephemeral` values and write-only resource arguments, where supported by the Terraform version and provider schema, can reduce persistence in state and plans. They are not universally available and should be verified for the exact resource and provider version. A normal sensitive argument can still end up in state even when the CLI redacts it. The safest option is often to let a runtime retrieve its secret from a secret manager rather than passing the secret through Terraform at all.

## Secret delivery and identity

Prefer short-lived workload identity for Terraform's own provider credentials: CI OIDC federation, cloud instance roles, or an equivalent mechanism. Avoid long-lived cloud keys in variables. Secret inputs should be fetched from a managed secret store with limited access, injected only into the Terraform process, and kept out of logs and artifacts. Environment variables can avoid placing a secret literally in a command line, but they are not a vault; process inspection and CI environment handling still matter.

For application secrets, Terraform can create a secret container or grant access policy, while an application or deployment system writes and reads the actual value. If Terraform must provision the secret value, minimize who can read state and rotate credentials after accidental exposure. Never use a source-controlled `terraform.tfvars` file for production secrets. Do not put a secret into a resource name, tag, `for_each` key or output: those values often appear in plans and logs even when unrelated attributes are sensitive.

## Protect state and plans

Remote state access should be limited by role and environment; separate read access from apply permissions where possible. Enable backend encryption and versioning, use locking, protect backups, and audit reads. Treat saved plan files as sensitive artifacts. CI should restrict artifact visibility and lifetime, and use a trusted commit-to-apply process. A state encryption feature does not prevent an authorized reader from downloading and decrypting state.

If a secret is committed or logged, removing the line from Git is not enough. Revoke or rotate the secret, assess access logs, invalidate affected artifacts, and consider the repository's history and backups. A version control cleanup does not replace credential rotation.

## Policy as code

Policies enforce organizational invariants beyond local variable validation. Examples include requiring encryption, forbidding public database endpoints, allowing only approved regions, requiring ownership tags, or preventing production destroys without special approval. HashiCorp Sentinel integrates with Terraform Cloud/Enterprise workflows; Open Policy Agent (OPA) can evaluate plan JSON in a custom pipeline. Other platforms provide policy engines with similar goals.

A typical OPA flow is: create a plan, render its JSON representation, evaluate Rego policies, and fail the pipeline on a violation. The JSON plan may include sensitive data, so secure it like the original plan. A useful policy examines planned resource changes and their actions, not just static text. For example, a rule can reject a public ingress rule or a deletion of a protected database. Policies should be tested against representative plans, including known-good and known-bad cases, before becoming a production gate.

Policy design has tradeoffs. A blanket deny can block incident recovery; a broad exception can nullify the control. Make exceptions explicit, time-bound where appropriate, attributable to an approver, and visible in logs. Policy is not a substitute for cloud-side preventive controls: it checks Terraform plans, but it cannot stop console changes or another tool from making the same unsafe API request.

## Minimize privilege and blast radius

The identity used for plan may need read access; apply requires the resource-specific mutations. Avoid giving every developer permanent administrator access simply because Terraform can manage many resource types. Split roles or approval boundaries where practical, and use separate credentials for separate environments. Provider aliases and environment variables should not make a development pipeline capable of reaching production accidentally.

## Common mistakes

- Assuming `sensitive = true` means encryption or state redaction.
- Putting production secrets in tfvars, outputs, resource keys or tags.
- Storing saved plans in long-lived, broadly visible CI artifacts.
- Forgetting to rotate a value after it appears in a log or repository.
- Treating Terraform policy checks as controls over console changes or other IaC tools.

## Production notes

Build the secret strategy around identity and lifecycle: who can issue credentials, how they are rotated, and which systems need the values. Prefer short-lived identities and runtime secret retrieval; when a value must enter Terraform, protect every persistence and presentation path. Policy as code is strongest when it is narrowly written, tested with plans and backed by cloud-side controls that enforce the same high-risk invariants.

## Design controls for usable enforcement

A policy is most effective when its decision matches an observable requirement. “No public database endpoint” is testable from planned attributes; “secure configuration” is too vague. Define which resource types and actions the rule covers, how unknown values are handled, and what evidence permits an exception. Unknown values may require rejecting a plan, deferring a decision, or requiring a later check; silently treating unknown as safe creates a gap. Choose deliberately and document the behavior.

Policy should fail early but provide a route for legitimate emergency work. A documented break-glass process can require a separate approver, reason, incident reference and audit trail. It should not be a permanent broad allow-list hidden in code. Run policy tests as part of changes to the rules themselves and include examples of resources that should pass as well as fail. Version the policy and pin its runtime where reproducibility matters.

Minimize secret handling at every step. Avoid putting raw plan JSON in pull-request comments, retain only restricted artifacts, and make sure debug mode does not serialize secret inputs. Review the permissions of policy jobs: a plan evaluator usually needs to inspect an artifact, not apply changes. Separate read, policy and apply roles so a bug in a checker does not automatically grant infrastructure mutation rights.
