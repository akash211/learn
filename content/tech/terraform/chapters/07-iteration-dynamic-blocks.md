# for_each, count and Dynamic Blocks

Terraform repetition constructs turn one declaration into multiple graph instances. `count` creates a numeric sequence addressed with indexes; `for_each` creates instances identified by map keys or set members. Choosing the right identity is important because an address is persisted in state. A configuration that changes keys may tell Terraform to destroy and recreate resources even when the intended remote objects are unchanged.

## count: numeric instances

`count` is useful when instances are genuinely interchangeable or naturally indexed, such as a fixed number of identical workers:

```hcl
variable "worker_count" {
  type    = number
  default = 2
}

resource "aws_instance" "worker" {
  count         = var.worker_count
  ami           = var.ami_id
  instance_type = "t3.small"

  tags = {
    Name = "worker-${count.index}"
  }
}
```

The instances are addressed as `aws_instance.worker[0]`, `[1]`, and so on. If count decreases from three to two, index 2 is destroyed. If a list is used to derive per-instance values, inserting an element at the front shifts later indexes and can cause replacement or widespread updates. This index-based identity is why `count` is a poor fit for a set of named environments, users or buckets that can change independently.

A condition can use `count = var.enabled ? 1 : 0` for an optional singleton, but callers then consume an indexable zero-or-one collection. For larger optional compositions, consider a module-level decision or a map with a stable key. Do not use `count` when order is only an accidental property of a list.

## for_each: stable keys

Use `for_each` when each instance has a meaningful identity. It accepts a map or a set of strings, and addresses instances by key:

```hcl
variable "buckets" {
  type = map(object({
    versioning = bool
  }))
}

resource "aws_s3_bucket" "data" {
  for_each = var.buckets
  bucket   = "acme-${each.key}"

  tags = {
    Purpose = each.key
  }
}
```

An instance is addressed as `aws_s3_bucket.data["analytics"]`. Adding a new map entry adds one instance; removing the key removes that specific object. Renaming a key appears as a destroy and create unless the address is migrated with a `moved` block. Keys are part of the state identity, so choose stable, non-secret names. Keys and set members must be known before apply; Terraform cannot determine a plan for a collection whose shape is only known after resources are created.

A set removes duplicates and has no ordering, which is often right for a collection of names. Maps carry per-instance attributes. Avoid converting arbitrary lists to sets if duplicates or order matter. For lists of objects, construct a map keyed by a stable attribute, and validate uniqueness before using it. A generated key based on a remote resource's computed ID is not available during planning.

To reference the collection, `aws_s3_bucket.data` is a map of instances. A `for` expression can extract IDs:

```hcl
output "bucket_ids" {
  value = { for key, bucket in aws_s3_bucket.data : key => bucket.id }
}
```

This retains a stable association between input key and output value. `values(...)` is useful when ordering is irrelevant, but it can obscure identity and should not be used to imply a stable sequence.

## Dynamic nested blocks

Some provider resources accept repeated nested blocks rather than a list or map argument. A `dynamic` block generates these nested blocks from a collection:

```hcl
variable "ingress_rules" {
  type = map(object({
    port        = number
    protocol    = string
    cidr_blocks = list(string)
  }))
}

resource "aws_security_group" "app" {
  name = "app"

  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      description = ingress.key
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = ingress.value.protocol
      cidr_blocks = ingress.value.cidr_blocks
    }
  }
}
```

The label after `dynamic` must be a valid nested block type for that provider resource. The iterator defaults to the block label (`ingress` here), and `content` holds the generated block arguments. You can set an explicit `iterator` name to avoid ambiguity in nested constructs. A dynamic block does not create a standalone resource and does not bypass provider schema validation.

Use dynamic blocks only when the provider schema truly requires a repeated block and the repetition improves the interface. A list-valued argument is easier to read and often better than generating many nested blocks. Deeply nested dynamic blocks with conditionals can make the effective HCL nearly impossible to review. Keep the input type strict and show a realistic example.

## Migrating addresses

Changing `count` to `for_each` changes state addresses. A transition from `aws_instance.worker[0]` to `aws_instance.worker["primary"]` can be recorded with a `moved` block:

```hcl
moved {
  from = aws_instance.worker[0]
  to   = aws_instance.worker["primary"]
}
```

Repeat for each retained instance and inspect the plan to ensure Terraform recognizes moves instead of proposing replacements. The migration is about state identity, not a remote rename. For complex transformations, plan in a non-production copy or use a carefully backed-up state operation under a change freeze.

## Common mistakes

- Using `count` with a reorderable list and assuming indexes track object identity.
- Choosing `for_each` keys that depend on computed values unavailable during planning.
- Including secrets in keys, which can leak into addresses, logs and state metadata.
- Expecting a dynamic block to create independent Terraform resources.
- Changing keys or repetition strategy without migrating the state addresses.

## Production notes

Treat instance keys as API and state identifiers. Prefer semantic keys that remain stable through ordinary edits, validate uniqueness, and ensure plan-time known values. A repetitive declaration can still represent a dangerous blast radius: a one-line input change may replace dozens of resources. Always inspect the instance-level plan before applying bulk changes.

A practical review should compare the before-and-after address sets, not just totals. Forty changes may be forty safe additions or forty unexpected replacements; the summary alone cannot tell which. Keep the logical key visible in plan output and logs so operators can map an instance back to its owner.

## Unknown collections and safe identity

The set of `for_each` instances must be known during planning. A map built from input variables is normally known, while a map whose keys depend on IDs created during the same apply may not be. A common design is to use known logical names as keys and place computed IDs in map values. This keeps the address predictable while allowing values to become known later. Terraform can often carry unknown attribute values through a planned instance, but it cannot plan an unknown set of addresses.

For example, create subnet instances keyed by availability-zone names supplied as inputs, then use each subnet's computed ID in a route table association. Do not use the computed subnet ID itself as the key. If input records arrive as a list, construct a map using a stable `name` property and validate that names are unique; silently overwriting duplicate keys can omit intended instances.

Bulk repetition also magnifies accidental changes. Before reducing `count` or removing `for_each` keys, inspect exactly which addresses will be destroyed and whether state migration is needed. A one-line change to a variable file can affect hundreds of resources, so use plan summaries and policy checks without substituting them for detailed review. Prefer staged changes for large fleets and verify provider quotas and API rate limits.
