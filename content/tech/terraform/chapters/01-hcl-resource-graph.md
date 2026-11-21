# HCL and the Resource Graph

Terraform configuration is a set of declarations, not a script that runs top to bottom. HCL names the objects you want, their arguments, and the relationships that constrain creation and deletion order. Terraform loads the configuration, evaluates expressions, builds a graph, asks providers to inspect or change remote objects, and records the resulting associations in state. Understanding that model prevents a common mistake: reading the file as though line order were execution order.

## Blocks, labels and expressions

A resource block has a type and a local name. Together they form an address such as `aws_s3_bucket.logs`; the local name is how other configuration refers to that declaration. Its provider type determines the schema of valid arguments.

```hcl
resource "aws_s3_bucket" "logs" {
  bucket = "acme-app-logs"

  tags = {
    Environment = "production"
    ManagedBy   = "terraform"
  }
}
```

The labels are literal strings. Inside the block, `bucket` and `tags` are arguments whose values are expressions. HCL expressions include strings, numbers, booleans, lists, maps, objects, tuples, conditionals, function calls and references. Interpolation is needed inside a larger string, not just to reference a value:

```hcl
locals {
  name = "acme-${var.service}-${var.environment}"
}
```

A variable reference has the form `var.environment`; a local is `local.name`; an output from a child module is `module.network.subnet_ids`. Resource attributes are referenced as `aws_vpc.main.id`. Those references are more than substitutions: Terraform uses them to infer dependencies.

HCL is declarative, but the configuration still has a language grammar and types. A map is not interchangeable with an object in every context, a missing required provider argument is an error, and a string that happens to contain digits is still a string. Format with `terraform fmt -recursive`, then use `terraform validate` after initialization to catch syntax and type errors.

## Resources, data sources and outputs

A `resource` block manages lifecycle: create, update, or delete an object through its provider. A `data` block reads an object that is managed elsewhere or discovers information at planning time. A data source does not normally make Terraform the lifecycle owner of that remote object. Do not declare a resource and a data source for the same object and assume the latter coordinates changes.

```hcl
data "aws_ami" "linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

resource "aws_instance" "worker" {
  ami           = data.aws_ami.linux.id
  instance_type = "t3.small"
}

output "worker_id" {
  value = aws_instance.worker.id
}
```

The data reference creates a graph edge: Terraform must obtain the image identifier before it can plan the instance. The output publishes a selected result to the root module's caller or CLI. It does not create the instance or make the output a secret store.

Resources have a lifecycle which can be nontrivial. A provider may update an attribute in place, replace an object, or require a multi-step operation. The plan marks replacement explicitly. A reference to an ID is usually preferable to copying a computed identifier into another block: the reference both carries the value and describes dependency. For a dependency with no data value to reference, `depends_on` can state an explicit ordering requirement, but it should be uncommon and scoped narrowly.

## The graph, not file order

Terraform constructs a directed acyclic graph from references and explicit dependencies. It can create independent nodes in parallel. When destroying, dependencies are generally reversed so dependents are removed before the objects they rely on. A `depends_on` edge is appropriate when behavior depends on a resource even though no attribute is consumed, but broad module-level dependencies can force unnecessary replacement or obscure the true relationship.

```hcl
resource "aws_iam_role" "app" {
  name               = "app-role"
  assume_role_policy = data.aws_iam_policy_document.app_trust.json
}

resource "aws_iam_role_policy_attachment" "read" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
```

The policy attachment depends on the role because it reads the role name. Putting the attachment first in the file changes nothing. `terraform graph` emits a Graphviz representation useful when a plan has surprising order, although large graphs are noisy. The `-parallelism` option changes how many graph operations run at once; it is not a fix for a missing dependency or API throttling strategy.

Cycles are errors: if A needs B's computed value and B needs A's, neither can be created first. Break the cycle by separating phases, using a stable input that exists before either resource, or redesigning the interface. Do not conceal a cycle with a broad `depends_on`; dependencies cannot make a circular graph valid.

## Providers and module boundaries

A provider configuration supplies credentials, region, endpoint and other context for resource types. A resource can be associated with an aliased provider, which is useful when a root module manages multiple regions or accounts. A child module should declare the provider source and version constraint it needs, while the root generally configures credentials and passes provider configurations down. The provider is not a resource in the graph in the same sense as an instance, but its configuration and schema affect graph evaluation and API access.

Modules are graph boundaries for organization, not isolated transactions. Outputs and input arguments make dependencies across that boundary explicit. If a module creates a network and a second module creates a service, pass the relevant subnet IDs as inputs rather than having the service module look up hidden global naming conventions. This makes the dependency visible in the root configuration and easier to test.

## Common mistakes

- Assuming blocks run in file order. Only data references and explicit dependencies determine graph edges.
- Using `depends_on` everywhere. Prefer precise attribute references that document why one object needs another.
- Treating data sources as managed resources. A lookup does not make Terraform responsible for deleting or correcting the object.
- Embedding IDs copied from a previous apply. References track computed values and build dependency edges.
- Ignoring replacement symbols in a plan. A replacement can destroy data or interrupt service even if the final attributes look correct.

## Production notes

Keep configurations deterministic where possible. A data lookup for “latest” may resolve differently tomorrow, so use it intentionally and understand what happens when the result changes. Use explicit resource names only when the remote system requires them; otherwise generated names can reduce collision risk. Output only the information consumers need. Finally, review the graph implied by module interfaces: a clean plan is not proof that ownership is sound, but hidden dependencies and hidden lookups make safe review substantially harder.

## Reading a small plan

Suppose a root declares a VPC, a subnet referencing `aws_vpc.main.id`, and an instance referencing the subnet ID. The graph expresses the required order without `depends_on`. A plan might show three creates, but each action deserves an individual interpretation: the VPC CIDR establishes a large address boundary, the subnet's availability-zone choice affects placement, and the instance may expose a public address depending on provider arguments. Confirm those values and outputs rather than reading only the resource count.

Computed values appear as unknown until apply, often printed as `(known after apply)`. Unknown is not the same as null or empty; downstream provider arguments may still be valid if the graph will produce the value before the API call. If a collection's shape itself is unknown, however, Terraform may be unable to expand a `for_each` during planning. Separate stable input identity from computed resource attributes.

When debugging, reduce a surprising example to a minimal root, run `terraform validate`, inspect the plan, and trace each reference. This isolates whether the issue is HCL expression semantics, provider schema, state, or a genuine dependency requirement.
