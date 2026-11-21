# Plan, Apply, Drift and Imports

The Terraform workflow separates proposing a change from executing it. `terraform plan` evaluates configuration, refreshes managed objects as allowed, calculates actions, and shows what Terraform intends to do. `terraform apply` can create, update or destroy remote infrastructure. The plan is the most important review artifact, but a plan is only valid for its configuration, state, provider selections and assumptions at the time it was made.

## Initialize, validate and plan

A normal local workflow starts with initialization and validation:

```bash
terraform init
terraform fmt -recursive
terraform validate
terraform plan -out=tfplan
terraform show tfplan
terraform apply tfplan
```

`init` installs providers and modules and configures the backend. `validate` checks syntax and internal consistency; it does not prove that credentials work, an API accepts the changes, or the resulting infrastructure is safe. `plan` is where provider reads and diffs surface. Use `-out` to save a plan for later review and `terraform show` to inspect that exact plan. A plan can contain secrets, so protect it like state and delete it when the workflow is complete.

For a human-reviewed apply, inspect creates, updates, replacements, and destroys. Replacement is often shown as delete-and-create or create-and-delete and may interrupt service or destroy data. Check the reason a field forces replacement, any lifecycle directives, and whether the address is the intended environment. `-target` is not a routine way to make a large plan smaller; it can leave dependencies or configuration only partially applied. Use it only for exceptional recovery with a subsequent full plan.

Applying a saved plan executes the actions encoded in it. Terraform can reject it if state changed since planning, and the apply should use the same code revision and compatible provider selections. Do not generate a plan on an untrusted branch and later apply it with production credentials. CI should bind the artifact to the reviewed commit, backend, workspace/root and environment.

## Drift and refresh

Drift is a difference between the configuration/state expectation and the remote object. Someone may have changed a security group in the cloud console, a managed service may normalize fields, or an API may update computed metadata. A normal plan refreshes observed values and reports resulting changes. If configuration still declares the old value, Terraform may plan to revert the manual change. Decide which system is authoritative: update HCL to preserve an intentional change, or apply the plan to restore the declared design.

`terraform plan -refresh-only` proposes state updates based on remote observations without proposing configuration changes to make the remote object match desired settings. It is useful when an external change is intentionally accepted into state, but it does not modify the configuration; follow it by updating the HCL so later plans remain consistent. The older `terraform refresh` command is discouraged because it updates state directly without a reviewed plan.

Drift detection is not continuous enforcement. Terraform does not run a daemon that watches every API change. Scheduled CI plans, cloud configuration monitoring or provider-specific controls can surface drift between normal changes. A clean plan means no difference was detected under that run's credentials and provider behavior, not that no one can change the resource later.

## Import existing infrastructure

When adopting an existing object, first write a matching resource block, then import it. Declarative `import` blocks make the intent reviewable:

```hcl
import {
  to = aws_s3_bucket.logs
  id = "acme-prod-logs"
}

resource "aws_s3_bucket" "logs" {
  bucket = "acme-prod-logs"
}
```

Run `terraform plan` to see the import action and any follow-on updates. The provider's import ID format is resource-specific; consult that provider's documentation. Generated configuration (`terraform plan -generate-config-out=...`, where supported) can be a starting point but often includes defaults and attributes that need careful cleanup. Import does not guarantee the configuration exactly matches the remote object.

The imperative command `terraform import ADDRESS ID` is available for existing workflows, but it updates state and is less visible in an ordinary plan-review pipeline. In either case, import associates an object; it is not a cloud API creation call. If two states import the same remote object, both can attempt to manage it, which is an ownership error. Before import, establish that no other state or tool owns the resource.

## Apply failures and partial progress

A Terraform apply is not an atomic transaction. It may create several resources, then fail because of quota, connectivity, permissions or provider behavior. Successful changes remain in the remote environment and are normally recorded in state as the run proceeds. Diagnose the specific failure, inspect state and the remote API, then run a new plan. Do not blindly re-run or delete state to “reset” the deployment.

A plan can become stale if another writer changes state, which is why remote locking and CI concurrency matter. A lock prevents concurrent state writers but cannot prevent all external console changes or API-side effects. Review the new plan after any failed or interrupted operation. Never assume an error means nothing changed.

## Common mistakes

- Treating `validate` as proof that an apply will succeed safely.
- Applying a new plan after reviewing a different saved plan.
- Believing drift refresh changes HCL or fixes the remote configuration automatically.
- Importing an object without checking whether another state already owns it.
- Re-running a failed apply without inspecting partial resources and updated state.

## Production notes

Use a protected pipeline that runs formatting, validation, policy and plan, then requires review before apply. Preserve a plan artifact only as long as needed and restrict access. For destructive changes, require a second set of eyes or a change window. After apply, verify service health and key attributes through normal operational monitoring; Terraform success only reports that provider operations completed according to the provider's contract.

## Read plans as operational change records

A plan is not merely a list of resource names. For every destructive or replacement action, identify the affected service, data durability implications, dependency chain and recovery path. For an in-place update, check whether the provider API itself may cause restart, failover or temporary unavailability. A field marked as computed may change in output without being configured, so distinguish noisy observations from consequential planned actions. Ask why an action occurs: a changed input, provider upgrade, remote drift, moved address or import follow-on each suggests a different response.

Machine-readable output is useful for automation: `terraform show -json tfplan` exposes planned resource changes to policy engines. The JSON representation is complex and may contain sensitive values; consumers must handle unknown values and schema evolution rather than assuming every attribute is a plain string. Human review remains important for operational context that policy cannot infer.

After apply, compare the result with the planned actions and monitor the service. If a pipeline is interrupted, do not assume Terraform did nothing or finished everything. Inspect the backend state serial, remote API and provider error, then create a new plan. A fresh plan is the reconciliation mechanism; manually editing state to remove a frightening diff can conceal the actual failure.
