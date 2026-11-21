# Variables, Locals, Outputs and Validation

A well-designed Terraform module has a small, explicit interface. Input variables describe what callers may choose, locals derive internal values, outputs expose useful results, and validation rejects invalid inputs close to the point where they enter the system. These features are not just syntax conveniences: together they define a contract that helps prevent accidental environment changes.

## Inputs with types and defaults

Declare root-module inputs in `variable` blocks. Specify a type whenever possible so Terraform can reject malformed values before a provider call. A variable without a default is required; a default makes it optional. Descriptions improve CLI prompts and generated documentation.

```hcl
variable "environment" {
  description = "Deployment environment name."
  type        = string
  nullable    = false

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "subnet_cidrs" {
  description = "Private subnet CIDR blocks, one per availability zone."
  type        = list(string)
  default     = []
}
```

Terraform has primitive types such as `string`, `number` and `bool`, plus collection and structural types: `list(string)`, `set(string)`, `map(number)`, `object({ ... })` and `tuple([ ... ])`. A precise object type communicates shape and can provide optional attributes in supported Terraform versions. Avoid `any` unless the module genuinely forwards a value without inspecting it. Weak types defer errors and make module contracts harder to understand.

Values may come from defaults, `terraform.tfvars`, `*.auto.tfvars`, `-var`, `-var-file`, or environment variables such as `TF_VAR_environment`. In automated workflows, prefer an explicit variable file or a controlled CI input instead of relying on whichever local file happens to exist. Sensitive values should be supplied through a secrets mechanism, not checked into a tfvars file.

## Validation and preconditions

Variable validation expresses rules at the interface. The condition must evaluate to a boolean; the error message should say what is allowed. Validate invariants such as a supported environment name, a CIDR format, or a positive replica count. Do not duplicate every provider-side rule: over-validation can reject values that the provider supports and becomes a second, stale schema.

Resource and output preconditions/postconditions can assert assumptions about computed or remote values. For example, a precondition can reject a dangerous combination of inputs, while a postcondition can ensure a resource result satisfies an invariant. Preconditions are not a replacement for cloud policy and do not guarantee that an external actor will leave the resource unchanged later. Choose the narrowest place that has enough context to give a useful error.

## Locals for derived values

A `locals` block assigns expressions to names that are private to the module. Locals are useful for derived names, common tags and normalization. They do not create resources or change input values.

```hcl
locals {
  name_prefix = "${var.project}-${var.environment}"
  common_tags = merge(var.extra_tags, {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}
```

Locals can reference other locals and inputs. Several `locals` blocks are allowed, but a circular reference is not. Keep derivations simple enough that a reviewer can see the final value. Do not hide important production differences in clever string manipulation; make them explicit inputs or environment-specific root configuration.

`merge` returns a map or object where later arguments override earlier keys. Ordering therefore matters. In the example, fixed `Project`, `Environment` and `ManagedBy` keys override caller-supplied tags. If the desired precedence is the reverse, swap the order deliberately. This seemingly minor choice matters when teams rely on tags for billing, access control or policy.

## Outputs as an interface

An `output` block exposes a computed value from a module. A root output appears after apply and can be queried with `terraform output`; child-module outputs are addressed as `module.network.vpc_id`. Outputs are also the boundary used to pass information to a caller. Give outputs stable names and descriptions, and publish the smallest useful set rather than the entire resource object.

```hcl
output "vpc_id" {
  description = "ID of the VPC created by this module."
  value       = aws_vpc.this.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs in stable input order."
  value       = [for subnet in aws_subnet.private : subnet.id]
}
```

Output values can themselves be sensitive. Mark an output with `sensitive = true` when it contains sensitive information; Terraform then redacts it in common CLI output. This is a display safeguard, not encryption, and state still stores the value. Avoid using outputs to transport credentials between otherwise isolated states.

Outputs may also have preconditions where supported, ensuring an exported value meets an expectation. If another module depends on an output, the reference creates a graph edge back to the resources used to compute it. Keep that dependency chain clear rather than using `depends_on` to paper over a hidden interface.

## Composition and precedence

A reusable child module should typically require callers to provide environment-specific decisions and use defaults only for safe, broadly applicable behavior. At the root, keep production inputs visible and reviewable. Avoid a module with dozens of switches that represents every possible infrastructure shape; a few focused modules compose more predictably than a giant “platform” module with conflicting modes.

Terraform combines variable values from several sources with a defined precedence, and command-line flags can override file values. This flexibility is useful for controlled automation, but it can also make local runs surprising. Inspect the exact CI command and included files, and do not assume a default is in effect simply because it is declared. `terraform console` can evaluate expressions for debugging, but never paste secrets into shared logs or command transcripts.

## Common mistakes

- Using `type = any` for a module interface whose expected shape is known.
- Adding a default to a critical environment variable, making an accidental production run appear valid.
- Assuming `sensitive = true` encrypts state or hides values from all logs and APIs.
- Letting caller-provided tags silently overwrite mandatory ownership tags.
- Exposing every resource attribute as an output, coupling consumers to implementation details.

## Production notes

Descriptions and validation messages are part of the user interface. Phrase errors so someone running CI can fix inputs without reading provider internals. Validate stable business invariants, use explicit type constraints, and keep secrets out of source-controlled variable files. For large object inputs, document an example and test the schema. A concise module contract is a security feature too: every input is a choice the caller can make, so do not expose dangerous toggles without a clear reason.

## Make input precedence observable

Unexpected variable values often come from precedence rather than HCL mistakes. Terraform accepts defaults, auto-loaded variable files, explicitly selected `-var-file` files, command-line `-var` flags and environment values; explicit command-line values take precedence over less-specific sources. Keep the exact invocation in CI visible and avoid relying on developer-specific auto files in production roots. A checked-in example file can document required shape without containing actual credentials.

Validation should be precise and portable. A string non-empty check may prevent a missing name, but elaborate regular expressions for cloud resource IDs can become stale when provider formats evolve. Use a type for structural requirements and a validation for a meaningful domain rule. For invariants involving multiple resource attributes, a resource precondition may give better context than separate variable validations. For example, reject an enabled public ingress option when an environment explicitly forbids public exposure.

Outputs should describe stable values rather than expose provider implementation accidentally. If a module's output changes from a list to a map, consumers may break even though managed infrastructure does not. Version module interfaces with the same care as a small API and add tests for important contract behavior.
