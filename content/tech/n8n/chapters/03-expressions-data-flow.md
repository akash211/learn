# Expressions and Data Flow

Most integration bugs are data-contract bugs: a later node receives a different shape, type or item relationship than its author expected. n8n expressions let a node's fields derive values from execution data, but an expression is only reliable when the author understands which item it reads, what happens when data is absent, and how transformations affect item identity.

## Items and JSON values

A node commonly receives and emits an array of items. An item has a `json` object containing the business data and may also carry binary data. A simple item can look like `{"json":{"email":"ada@example.test","status":"new"}}`. If a node returns three records, downstream nodes may receive three items, not one object with a three-element array. That distinction determines whether a node runs once or processes each record.

Use Edit Fields to make the expected shape explicit. It can add, rename or remove fields, and its options determine whether other input fields are kept. A deliberate normalized shape reduces downstream coupling to a vendor-specific response. For example, convert `customer.emailAddress` and `customer_id` to `email` and `customerId` near the source, and document whether a missing email becomes null, is omitted, or causes a validation branch. Avoid passing a huge response object through every node if only two fields are needed.

Expressions are often written as `{{ $json.email }}` for the current item's JSON field. Other useful references include `$input.all()` to access input items, `$itemIndex` for an item's position, `$execution.id` for a run identifier, and `$workflow.id` for workflow metadata. References such as `$node["HTTP Request"].json` can access a named node's data, but references must align with the current execution path and item linking. Prefer the current item's `$json` when a direct connection makes the dependency clear. Expressions execute within n8n's expression environment; do not assume arbitrary browser globals or shell state exist.

## Mapped items versus paired items

Mapped item processing means a downstream node receives multiple items and processes each one according to its own semantics. A one-to-one chain often preserves correspondence naturally: item 0 from an input produces item 0 from an output, item 1 produces item 1, and so on. In that case, current-item expressions such as `$json.id` are usually clearer and safer than indexing another node's output.

Paired items capture lineage between an output item and the input item or items that produced it. n8n uses item linking to resolve references across nodes. If a node produces one output for each input, it can preserve a direct pairing. A node that aggregates multiple items into one, splits a single item into several, or builds new items in a Code node may change or lose the pairing relationship. A later expression that asks for a prior node's item “paired” with the current item can then be ambiguous or fail. This is why a workflow should treat data shape and lineage as part of its contract, not invisible editor behavior.

When a Code node creates items, return the expected item structure, typically objects with a `json` property, and preserve input linking when downstream expressions need it. n8n's Code node has modes such as “Run Once for All Items” and “Run Once for Each Item.” The mode controls the input API and execution count. Do not copy code written for one mode into the other. For all-items work, retrieve the inputs as a collection and deliberately return a collection; for per-item work, operate on the current item and return the correct shape. Consult the node's version-specific docs because helper APIs can differ.

## Expressions, types and missing values

An expression can produce strings, numbers, booleans, arrays, objects or null-like values depending on the target field and node. A common error is interpolating a number into a text template, then sending that string where an API expects an integer. Another is confusing a missing field with an empty string or `null`. Validate inputs before using them in requests or writes. IF can route missing or invalid values to a deliberate error path; Edit Fields can rename or coerce fields but should not silently conceal invalid source data.

Expressions should not be built by concatenating untrusted text into SQL, shell commands or raw request fragments. Use database node parameters and API-supported JSON fields where possible. If dynamically creating a URL, encode path or query components appropriately and never let untrusted data control an unrestricted destination host. Escaping user input for one context does not make it safe in another context.

For arrays, distinguish a collection of items from an array-valued field within one item. If an API returns `{ "results": [ ... ] }` as one item, a downstream node may still execute only once with `$json.results` as an array. To turn those elements into separate items, use a node or transformation that explicitly splits the array. Conversely, aggregate only when the receiving API expects a single batch payload. Check node output after the transformation; field names and nesting often vary across operations and API versions.

## Transform without losing context

A useful pattern is to retain stable identifiers while reducing payload size. Keep a source record ID or event ID even when removing unused fields, so retries can be idempotent and operators can trace the source. When merging two branches, choose a key such as `customerId` and define what happens when the key is absent or duplicated. Position-based merging assumes consistent order; independently sorted or filtered branches can pair unrelated records.

For debugging, inspect a small representative execution at each boundary: trigger input, normalized input, external response, and final write payload. Use test data that includes missing optional fields, non-ASCII text, empty arrays and multiple items. Pinning data can make a downstream node convenient to configure, but remove or refresh it before judging current upstream behavior. If a later expression reads a node far away in the graph, ask whether explicitly carrying the needed field forward would make lineage simpler.

## When to use a Code node

Use Edit Fields, IF, Switch, Merge and dedicated integration nodes for routine mapping and routing: their configuration is visible and easier for teammates to inspect. A Code node is justified for a compact transformation such as normalizing a nested structure, validating a schema, or computing a value that would otherwise require many fragile expressions. Keep the logic pure where possible: the same input should produce the same output, without hidden network calls or side effects. This makes it easier to test with example items and reason about retries.

When code changes cardinality, make that explicit in the output contract. If ten input records become one summary, downstream expressions should not expect ten paired items. If one record becomes several line items, carry a parent identifier into each result. Include a stable key and, when needed, source metadata in normalized output. These conventions make downstream matching reliable even when an API changes ordering or a workflow branches.

## Common mistakes

- Treating an array-valued property as though it were already multiple n8n items.
- Using `$itemIndex` to correlate records after one path has filtered, reordered or aggregated them.
- Assuming a Code node automatically preserves item pairing when it creates new data.
- Referencing a named node that did not execute along the current branch.
- Allowing absent values to become malformed API parameters or accidental strings.