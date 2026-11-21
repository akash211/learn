# Designing Tools the Model Can Use

A tool definition is an API contract whose only consumer is a model. Unlike a human developer, the model cannot read your source, ask a colleague, or notice that `amount` is in cents. It sees a name, a description, and a schema, and it fills them in from the conversation. Every ambiguity you leave becomes a distribution of wrong calls in production.

## Name for the decision, not the implementation

The name is the strongest signal the model has. It should state the action and the object in the vocabulary of the domain, and it should be distinguishable from its neighbours at a glance:

| Weak | Better | Why |
|---|---|---|
| `search` | `search_orders_by_customer_email` | Says what is searched and what identifies it |
| `update` | `update_shipping_address` | Names the mutated field |
| `get_data` | `get_invoice_line_items` | Distinguishes from siblings |
| `process` | `issue_refund` | Names the side effect |

Use one convention everywhere — `verb_noun` is the common choice — and keep it stable, because renaming a tool is a breaking change for every prompt, eval, and cached transcript that references it. If the semantics change, add a new tool and deprecate the old one rather than silently redefining the name.

Avoid two tools that differ only by a flag or an adjective. `get_user` and `get_user_details` force the model to guess which one carries the field it needs; the usual outcome is that it calls both. Merge them and return the union, or make the distinction structural (`get_user_profile` versus `get_user_permissions`).

## Descriptions are the interface

Write it as a specification for a competent contractor who cannot ask questions. It should answer:

- **What it does**, in one sentence, including the unit of work.
- **When to use it**, phrased as a trigger condition from the user's request.
- **When not to use it**, naming the sibling tool that applies instead. This single line prevents most misroutes.
- **Side effects**, explicitly: does it charge, send, delete, or only read?
- **Argument conventions**: currency, timezone, ID format, whether a name is acceptable or an ID is required.
- **What comes back**, at the level of shape, not every field.

A description that restates the name ("Searches orders") contributes nothing; the model already has the name. A description that says "Use when the user supplies an email address or an order number. Do not use for refunds — use `issue_refund`. Read-only. Returns at most 20 orders, newest first, with a `next_cursor` when more exist." does four jobs at once, in the declarative tone that works best.

## Choose the right granularity

Granularity is the highest-leverage design decision and the one teams get wrong most often, usually by exposing their internal service methods one-for-one.

**Too fine** — `get_customer`, `get_customer_addresses`, `get_customer_credit`, `get_customer_orders` — forces a multi-turn chain for one user question, multiplies latency, and gives the model four chances to pick wrong. Every extra hop is another full model call over a growing transcript.

**Too coarse** — `manage_account(action, payload)` — pushes schema construction into the model, hides the side effects, and makes authorisation impossible to express, because one tool spans reads and irreversible writes.

The right unit is a **user-meaningful action**: the thing a competent operator would describe as one step. If two operations always occur together and the second's arguments are derived entirely from the first, they are one tool. If the second requires a decision based on the first's output, they are two.

A useful test: can you write a policy for it? "This tool may be called without approval" only works if the tool's effect is uniform. The moment a tool can either read a balance or move money depending on an argument, you cannot gate it.

## Shape arguments so wrong values are hard to express

The schema is a constraint system; use it as one.

- **Enums over free strings** for statuses, sort orders, regions, and categories. `{"enum": ["open", "shipped", "cancelled"]}` eliminates a whole class of failures that a `string` invites.
- **IDs, not names, for anything that mutates.** Resolve a human name to an ID in a separate read tool, then require the ID for the write. This makes the model's choice visible before it acts.
- **Explicit units and currency.** `amount_minor: integer` plus `currency: {"enum": ["USD","EUR","INR"]}` beats `amount: number` every time. Ambiguous money is the classic expensive bug.
- **ISO 8601 strings with an explicit timezone field**, or epoch integers — never locale-dependent formats like `03/04/2025`.
- **Bounded collections.** If a tool takes `items`, set `maxItems` and validate it. A model asked to "add these line items" will happily produce forty.
- **Required means required.** If a parameter genuinely must be inferred, say so in its description rather than marking it optional and hoping.

## Return structure, not prose

Tool results re-enter the context window and are read by the same model that called the tool. Return JSON with stable, self-describing field names — not a formatted string, not a rendered table, not HTML.

```json
{
  "orders": [
    {"id": "ord_8812", "status": "shipped", "total_minor": 4599, "currency": "USD",
     "placed_at": "2026-03-02T14:11:00Z", "tracking": "1Z999AA10123456784"}
  ],
  "count": 1,
  "truncated": false,
  "next_cursor": null
}
```

Three properties make this usable. It is **stable**: the same keys appear whether there are zero results or fifty, so the model does not have to reason about shape. It is **typed**: `total_minor` cannot be confused for dollars. And it is **bounded**: the result states whether it was truncated and how to continue.

What to avoid:

- **Prose summaries as the only payload** ("I found 3 orders, the first is shipped..."). The model cannot re-aggregate prose, and it will hallucinate fields you never sent.
- **Raw upstream responses.** A vendor's 40-field object with nested metadata burns context and buries the two fields that matter. Project to a shape designed for the model.
- **Silent truncation.** If you cap at 20 rows, say so and provide a cursor. A model that believes it has all the data will confidently answer "you have no other orders".
- **Null versus absent.** Pick one and document it. Prefer explicit `null` for "known to be empty" and omit the key only if you consistently omit it.

## Errors are part of the design

Return failures as structured results, not exceptions that surface as "tool failed". A useful error object carries a stable code, a message written for the model to act on, the offending field, and whether retrying the same call could ever succeed. Chapter 3 treats this in depth; the design point here is that the tool author, not the framework, decides what the model sees.

## Versioning and deprecation

Tools are public API. Additive fields are safe; removing a field, tightening an enum, or changing units is breaking. Because the consumer is a model, breakage is silent — it keeps emitting the old shape and your validator rejects it at some unknown rate. Keep the old tool registered for one deprecation window, log calls to it, and delete it when the rate reaches zero.

## Common mistakes

- Descriptions that duplicate the name and say nothing about triggering conditions.
- One tool per internal RPC method, producing a twelve-hop chain for a two-sentence request.
- `string` where an enum belongs; `number` where a minor-unit integer belongs.
- Returning the vendor payload verbatim, or a prose sentence instead of data.
- Truncating results without a flag, so the model reports absence as fact.
- Tools whose effect ranges from "read" to "irreversible write", making approval impossible.

## Production notes

Instrument per tool: call count, selection rate relative to sibling tools, argument-validation failure rate, empty-result rate, and result size in tokens. A tool with a 15% validation failure rate is not a model problem; it is a schema problem, and the fix is usually a missing enum or an under-described field.

Cap result size in bytes *and* in tokens, and measure both — a 2 KB JSON blob of long IDs can cost more tokens than a 20 KB table of short ones. Where a tool can return large payloads, provide a second "fetch detail by ID" tool so the model can pull one record instead of fifty. Finally, keep a human-readable description of each tool in your runbook: when an incident reviewer asks what the agent could have done, the answer should be a list, not an inference from code.
