# State, Backends and Workspaces

Terraform state is the mapping between configuration addresses and real remote objects, plus attributes Terraform needs to plan future operations. A resource block alone does not identify an existing cloud object. State tells Terraform that `aws_vpc.main` corresponds to a particular remote VPC, and records values such as IDs and provider data. State is operationally critical and can contain sensitive values even when the configuration marks them sensitive.

## Why state exists

Providers expose APIs with identifiers and behaviors that do not necessarily match the structure of HCL. State stores the association, the last known values, and metadata Terraform uses to compare configuration with refreshed remote objects. On a plan, Terraform generally refreshes managed resources, compares the observed values with configuration and state, and proposes actions. It is not merely a cache: deleting or losing state does not delete the real resource, but Terraform may then try to create a duplicate because it no longer knows the object is already managed.

The default backend is local state, usually `terraform.tfstate` in the working directory. It is useful for experiments and personal prototypes, but it is a poor shared-team backend: the file can be lost, copied inconsistently, or committed to source control. Add state files and backups to ignore rules. Do not share state through email or a manually synchronized folder.

## Remote backends and locking

A backend defines where Terraform stores state and how it performs state operations. Remote backends centralize the snapshot, support team access controls and may provide locking. For example, an S3 backend can use an object key and native lockfile support in current Terraform releases:

```hcl
terraform {
  backend "s3" {
    bucket       = "acme-terraform-state"
    key          = "prod/network/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
```

Backend blocks have special rules: their configuration cannot use ordinary input variables, and credentials should come from the environment, role, or supported credential chain rather than being embedded in source. Backend settings are initialized with `terraform init`; changing them may require `terraform init -reconfigure` or a deliberate `terraform init -migrate-state`. Read the prompt carefully: migration copies state, whereas reconfiguration changes which backend Terraform uses without automatically migrating it.

Locking prevents two writers from concurrently applying changes to the same state snapshot. Without a lock, two applies can both read version N and each write a different version N+1, losing one update or corrupting the mapping. If Terraform reports a lock, determine whether another run is active before taking action. `terraform force-unlock` is an emergency tool: a stale lock should be removed only after verifying its owner and operation have stopped. Do not delete a lock file by hand as a routine fix.

Backend durability is not a substitute for access control or recovery. Enable encryption at rest and in transit, restrict state read access, enable object versioning or an equivalent recovery mechanism, and monitor access. A state snapshot may contain provider-returned credentials or values marked sensitive. Encrypting the storage layer does not make it safe to grant broad read access.

## Workspaces versus directories

A CLI workspace selects a separate state instance for one configuration and backend. `terraform workspace new staging` creates a workspace; `terraform workspace select staging` selects it; `terraform workspace show` confirms the selection. Workspaces can be useful when multiple isolated copies share exactly the same configuration and have a simple lifecycle.

Workspaces do not create separate cloud accounts, credentials, approval flows, policy, or independently versioned configuration. An accidental `terraform apply` in the wrong workspace can still modify the wrong environment if credentials and values permit it. Naming a workspace `prod` is not a production safety boundary. For environments with different ownership, access, topology or release schedules, separate root directories and backend keys are usually clearer:

```text
environments/
  dev/network/
  staging/network/
  prod/network/
modules/
  network/
```

Each root can pin inputs and provider settings and have a distinct backend key and CI approval. Shared modules reduce duplicated resource logic without forcing production and development to share one state. Avoid copying the entire configuration into three unrelated folders: fixes then drift. Instead, keep environment roots thin and call versioned or locally shared modules with explicit values.

## State boundaries and ownership

A state file should represent a deliberate operational boundary, not simply one state for everything or one state per resource. A smaller state limits the impact of a bad plan, reduces contention, and lets teams apply independent changes. Too many tiny states create dependency plumbing, complicated promotion and coordination overhead. Consider blast radius, ownership, lifecycle, access control, expected apply frequency, and whether resources must be changed together.

Cross-state dependencies should be explicit. A consumer can receive outputs through a controlled pipeline, remote-state data source, or another published interface. Reading another state grants access to its snapshot and can expose unrelated secrets, so remote-state access is not a free service-discovery mechanism. Prefer publishing the smallest needed values and keep ownership clear.

## Recovery and state operations

Before changing state, take a protected backup and record the exact address and object ID. `terraform state list` shows addresses; `terraform state show ADDRESS` inspects a tracked object. `terraform state mv` changes an address mapping without changing the remote object, useful for a refactor when a resource or module is renamed. `terraform state rm` removes only the association; it does not delete the remote infrastructure. `terraform import ADDRESS ID` associates an existing object with a configuration address, though declarative `import` blocks are often easier to review and automate.

State surgery can be safer than destroying a production database, but it is easy to orphan or duplicate ownership. Make changes during a freeze, use a lock, back up state, plan immediately afterward, and verify the remote object. Do not hand-edit JSON except as a documented last resort with a backup and an expert review.

## Common mistakes

- Committing local state or plan files to Git.
- Assuming state contains no secrets because the configuration uses `sensitive = true`.
- Using workspaces as a substitute for separate production permissions and approvals.
- Forcing an unlock while another pipeline is still applying.
- Running `init -reconfigure` when the intent was to migrate state, or vice versa.

## Production notes

Bootstrap state storage through a separately controlled process because the backend cannot depend on its own configuration. Test state restore procedures, not only backup creation. Treat backend IAM, encryption keys, object versioning, locking and CI concurrency as part of Terraform's safety architecture. A plan that targets one state can still affect many services; a deliberate boundary gives operators a comprehensible failure domain.

## Backend changes are migrations

Backend configuration is initialized outside the ordinary variable evaluation model because Terraform must know where state lives before it can evaluate the resource graph. Consequently, do not attempt to set an S3 bucket or backend key with `var.environment` inside the backend block. Use distinct root configurations or backend configuration files and keep credentials in the provider's supported identity chain. A partial backend configuration supplied to `terraform init -backend-config=...` should not contain a secret that becomes committed or logged.

Before a backend change, record the old backend and state version, stop all runs, verify the destination access policy, and choose migration versus reconfiguration explicitly. After initialization, inspect the selected workspace and run a read-only plan to confirm the expected objects are present. A backend that initializes successfully but points at an empty key is not a successful migration. If a team uses a cloud console or alternate CLI to copy state objects, preserve versions and lock semantics and validate checksums where supported.

Document who can restore a prior snapshot and how to reconcile it with live resources. A backup is valuable only if authorized responders can locate it, decrypt it and understand which deployment it represents.
