# Modules and Composition Patterns

Terraform modules are reusable units of configuration. The root module is the directory where a Terraform command runs; every child module is included with a `module` block. A module accepts inputs, declares resources or calls other modules, and exposes outputs. It is not a separate Terraform process or a transaction: all modules in one root contribute to the same graph and state.

## A module has an interface

A typical root invokes a child module with a source and values for its variables:

```hcl
module "network" {
  source = "../../modules/network"

  name               = "orders-prod"
  vpc_cidr           = "10.40.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b"]
  tags               = local.common_tags
}

module "service" {
  source = "../../modules/service"

  name       = "orders"
  subnet_ids = module.network.private_subnet_ids
}
```

The child module's variables form the input API; its outputs are the consumer-facing results. A module should hide implementation details but not hide important operational behavior. If it creates a VPC, callers should be able to supply the CIDR, understand whether NAT gateways are created, and retrieve subnet IDs. A module that silently creates expensive or public resources behind an innocuous boolean is hard to review.

A module is a directory containing `.tf` files, not one special `main.tf`. Terraform loads all top-level `.tf` files together. Splitting `variables.tf`, `main.tf` and `outputs.tf` is a convention for navigation, not an execution order. Small modules can keep a shorter layout; clarity matters more than file count.

## Composition patterns

Prefer composition: a root module wires several focused modules together and passes explicit outputs to inputs. The root is where environment decisions are visible. A network module owns networks and subnets; a service module consumes subnet IDs; a database module consumes security-group IDs. This creates a clear graph through the module interfaces. It is generally better than a single module that conditionally creates every possible combination of network, compute, database and monitoring resources.

Avoid ambient coupling. A child module should not infer a subnet by looking up a tag that happens to be created by another module. Pass the ID as an input. Explicit interfaces help Terraform establish dependencies and make the module usable in a test root or a different environment. Remote state can provide cross-root values when state boundaries require it, but then the interface is less local and state access becomes part of the contract.

A module should own a coherent lifecycle boundary. Group resources that are created, changed and retired together. Do not split every resource into a module merely to maximize reuse: excessive module nesting makes plans difficult to read and obscures where a value originates. Conversely, a repeated pattern with stable inputs, outputs and semantics is a good candidate for extraction.

## Sources, registries and pinning

A module's `source` can be a local path, a Git repository, a registry address or another supported source. Local paths are convenient for modules developed alongside a root and are resolved relative to the calling module. Registry modules need version constraints, and Git sources should generally use an immutable ref such as a tag or commit instead of a moving branch. `terraform init` downloads remote modules and records installed module selections in `.terraform/modules`; do not edit that cache by hand.

A remote module version and provider version solve different problems. The module version controls the module's source release; `required_providers` constraints control provider plugin compatibility. The dependency lock file locks provider selections, not arbitrary module source code in the same way. Pin module source versions explicitly for production roots, then update them in a reviewed change with an updated plan.

## Versioned module example

A reusable module declares its required providers and variables. The root configures the provider and passes values:

```hcl
module "bucket" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket = "acme-artifacts-prod"
  tags   = local.common_tags
}
```

That constraint permits compatible minor and patch updates within the major version range under Terraform's version-constraint semantics. It does not mean “use whatever latest release exists forever”: initialization selects a version satisfying the constraint, and production should review upgrades. For a Git source, use a ref, for example `?ref=v2.3.1`, and ensure the ref is maintained as immutable by repository policy.

## Refactoring into modules

Module extraction changes resource addresses. A resource previously declared as `aws_vpc.main` might become `module.network.aws_vpc.this`. If Terraform does not know these represent the same remote object, it may plan a destroy and create. Use a `moved` block in the configuration for address refactors when supported:

```hcl
moved {
  from = aws_vpc.main
  to   = module.network.aws_vpc.this
}
```

Plan the move and confirm it reports a state address move rather than replacement. For older workflows, `terraform state mv` can migrate the mapping, but the operation should be coordinated and backed up. Rename modules carefully and treat address changes as behavior with production consequences.

## Providers in child modules

Reusable child modules declare which provider source and compatible versions they require, but usually do not configure credentials themselves. The root configures the provider. For aliases or multiple accounts, pass provider configurations explicitly using the `providers` argument on the module block. This keeps account and region decisions in the root where reviewers can see them. Provider inheritance is convenient for the default provider, but do not assume an alias will be passed automatically.

## Common mistakes

- Treating a module as a transaction or separate state. It participates in the root's graph and state.
- Reaching into another module's resource address rather than using its outputs.
- Using a moving Git branch for production module source.
- Building a giant all-purpose module with dozens of flags and hidden side effects.
- Extracting a resource without migrating its state address, causing an unwanted replacement plan.

## Production notes

Document the inputs that materially affect network exposure, data retention, encryption, and destruction behavior. Provide examples of normal use, test supported combinations, and keep modules narrowly focused. A root that calls versioned building blocks with explicit values is easier to upgrade than copied configuration or a generic module full of opaque switches. Every module abstraction should reduce repetition or clarify ownership enough to justify the extra layer.

## Keep the root understandable

A root module is the deployment composition boundary. It should make account, region, environment, module sources, key inputs and dependency wiring easy to find. A short `main.tf` can call `network`, `database` and `service` modules; each module can own a coherent set of resources. The root should not become a maze of pass-through locals and outputs that simply rename each value at every layer. Add a layer only when it owns a meaningful contract or reduces a real maintenance cost.

When module versions change, inspect both interface and behavior. A minor-looking upgrade may alter defaults or resource arguments. Run plans across every root consuming a shared module, not just the module's own test. Publish breaking changes with an upgrade note and, where appropriate, a new major module version. Local source paths are useful during development, but production roots should have a reproducible source revision and review process.

For an internal module, document expected provider aliases, supported Terraform versions, whether it creates public resources, data retention behavior and migration notes. Keep examples runnable with synthetic names and non-production values. Good documentation helps callers make safe choices; a module README is not a substitute for an interface that is safe by default.
