# Providers, Versions and Dependency Pinning

Terraform core parses configuration and manages the graph; providers implement resource and data-source schemas and communicate with external APIs. The AWS, AzureRM, Google, Kubernetes and many community providers are separate plugins. Configuration uses a provider source address to identify the plugin, and `terraform init` downloads a compatible version. Provider source, provider configuration and provider version are related but distinct concerns.

## Declare the provider source and constraints

Each module that uses a provider should declare it under `required_providers`. The root typically includes the provider configuration and constraints for the whole deployment:

```hcl
terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
```

The local name `aws` is used in configuration; `hashicorp/aws` is the provider's global source address. A version constraint describes a permitted range, not the exact selected version. Every module in a configuration may constrain a shared provider; Terraform must find a version satisfying all constraints or initialization fails. Child modules should express a reasonable compatibility range, while the root selects and locks a concrete version.

Terraform version constraints use operators such as `>=`, `<`, `~>` and comma-separated intersections. `~> 5.0` allows versions at least 5.0 and below 6.0, while `~> 5.2.0` allows compatible patch versions below 5.3.0. Read the precision carefully: a small difference changes which minor releases can be selected. A tight exact constraint can block important fixes; a very broad constraint can make an upgrade appear during an unrelated init.

## Lock file and provider checksums

`terraform init` creates or updates `.terraform.lock.hcl`, recording selected provider versions and checksums for supported platforms. Commit this file for root configurations so teammates and CI use consistent provider builds. `terraform init -upgrade` intentionally reevaluates selections within constraints and updates the lock file; it should be a reviewed dependency update, not a default CI command.

Checksums protect against receiving provider packages whose contents do not match the locked package checksums. `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64` can prepare lock entries for additional CI and developer platforms. The lock file is not a lock on module source contents and is not a substitute for reviewing a provider release, changelog or security advisory.

When a provider must be upgraded, inspect the changelog and breaking changes, widen constraints only when justified, run `terraform init -upgrade`, then format, validate and plan each affected root. Provider major releases may remove deprecated arguments or change defaults. A version pin prevents surprise drift but can freeze bugs and security issues; schedule and review updates rather than pinning forever.

## Credentials and aliases

Provider configuration should obtain credentials from supported environment variables, workload identity, instance roles or a credential process. Do not put access keys in HCL, tfvars committed to Git, or provider blocks. The provider may support multiple aliases for different accounts or regions:

```hcl
provider "aws" {
  region = var.primary_region
}

provider "aws" {
  alias  = "dr"
  region = var.recovery_region
}

resource "aws_s3_bucket" "replica" {
  provider = aws.dr
  bucket   = "acme-replica"
}
```

Provider aliases make the target explicit at each resource. Child modules needing a non-default configuration must receive it through the module's `providers` map. A module configured with its own credentials or hard-coded account ID is less portable and makes review harder. Use account boundary and CI identity controls to prevent a plan intended for staging from gaining production credentials accidentally.

## Plugin installation and mirrors

Terraform normally installs providers from a registry, but organizations may configure a provider installation mirror or cache for controlled environments. Treat the mirror as part of the software supply chain: limit who can publish packages, preserve checksums, and document how new versions are promoted. `.terraform/` contains downloaded plugins and module cache; it is generated and should not be committed. The lock file belongs in source control.

Third-party providers have varying maintenance and quality. Verify source addresses rather than trusting a similar-looking short name. Review ownership, release history, permissions, API calls and schema behavior. A provider upgrade can change remote objects even though the HCL diff is empty, so inspect plans after any provider selection change.

## Terraform compatibility

`required_version` constrains Terraform CLI versions for a module or root. It prevents a CLI too old to parse features or a future incompatible release from running. It does not select the CLI binary. Pin or install Terraform explicitly in developer tooling and CI, and keep the declared compatibility range aligned with tested versions. When a module uses a new language feature, its minimum Terraform version must reflect that fact.

The root and child modules can have compatible constraints that overlap. A child module should not needlessly pin a single patch version of Terraform or the provider, since that prevents callers from making compatible updates. A root can enforce a narrower tested range for a production environment. Run the same Terraform release in plan and apply; saved plans encode assumptions about configuration and provider selections.

## Common mistakes

- Confusing a provider's local name with its source address.
- Committing `.terraform/` rather than `.terraform.lock.hcl`.
- Running `terraform init -upgrade` on every CI run and silently changing provider versions.
- Assuming `~> 5.2` and `~> 5.2.0` allow the same range.
- Embedding credentials in provider configuration or passing aliases implicitly to child modules.

## Production notes

Pin the CLI version, constrain provider versions, commit the lock file, and update each deliberately. Have CI verify lock-file consistency with `terraform init -lockfile=readonly` where appropriate. Test upgrades on representative roots and inspect actual plans; the provider is executable code with API access, so its provenance and version deserve the same review as application dependencies.

## Upgrade as a controlled change

An upgrade should separate selection changes from infrastructure design changes where feasible. First determine which provider version is currently locked and which constraints permit the target. Read upgrade notes for renamed arguments, removed resources, changed defaults and state upgrade behavior. Update the root constraint and lock file, then run initialization using the exact CLI version selected for CI. If a plugin requires a state migration, follow the documented sequence and back up state first.

Run `terraform plan` for every affected root, not only the root where a shared module was edited. Changes to a provider schema can make a formerly implicit default visible or change normalization, creating diffs that were not caused by an HCL edit. Review replacement markers and computed attributes. If a provider supports multiple platforms, lock checksums for the platforms used by developers and build agents; otherwise initialization can fail only on one machine and lead to an unsafe workaround.

A provider mirror can improve availability and control, but it also becomes a trust boundary. Define how releases are admitted, checksums verified, and prior versions retained for rollback. A plugin cache is a performance optimization, not a substitute for the committed lock file or integrity verification.
