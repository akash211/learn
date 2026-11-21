# Designing Tools an Agent Can Use

A tool is an API whose only client is a probabilistic program. That client does not read documentation, cannot ask a clarifying question, will invent plausible-looking arguments, and may call the same function twice for the same reason. Most agent reliability problems are tool design problems wearing a costume: the model looks stupid because the interface was designed for a human who already knows what they want.

## The schema is part of the prompt

Tool definitions are serialised into the model's context on every call. That has three consequences: descriptions cost tokens on every step, argument names are read as instructions, and the amount of choice affects accuracy. A tool taking `{"action": string, "params": object}` is an invitation to hallucinate; five flat, typed parameters with enums are a constraint.

Design rules that hold up in practice:

- **One verb per tool.** `search_orders`, `get_order`, `refund_order` — not `manage_orders(op="do")`.
- **Flat arguments.** Nested objects invite malformed nesting. If a call needs a structure, define a model for it, but keep the top level shallow.
- **Enums over free strings** wherever the set is finite. `status: "shipped" | "pending" | "cancelled"` prevents a category error before it happens.
- **Units and formats in the name.** `amount_cents`, `deadline_iso8601`, `window_days`. The model cannot see your type comments, only the schema text.
- **Few required fields.** Every required field is a chance to guess. Derive what you can from session context on the server side.
- **No free-form execution surfaces.** `run_sql(query)`, `run_shell(cmd)`, and `fetch_any_url(url)` are not tools; they are a shell with extra steps and they belong behind a sandbox, an allowlist, or not at all.

```python
# Weak: two ways to fail before any work happens
def update_order(order, changes: dict): ...

# Better: explicit, bounded, and readable as an instruction
def update_shipping_address(
    order_id: str,
    line1: str,
    city: str,
    postal_code: str,
    country: Literal["US", "CA", "GB"],
) -> UpdateResult:
    """Change the shipping address on an order that has not shipped.

    Use when the customer asks to correct an address. Fails with
    ORDER_ALREADY_SHIPPED if fulfilment has started; do not retry then —
    escalate. Never use this to change the billing address.
    """
```

The docstring is not decoration. It is the instruction the model reads at decision time, so it should say what the tool does, when to use it, when *not* to use it, and what the errors mean. Write it for a capable new colleague with no context, then delete every word that does not change a decision.

## Descriptions must disambiguate

The most common tool bug is not a bad schema but two tools that look interchangeable. `search_docs` and `search_knowledge_base`, or `get_customer` and `lookup_account`, produce selection errors that look like reasoning failures. Fixes, in order of effectiveness: delete one of them; rename so the difference is in the first two words; add an explicit negative ("use `search_knowledge_base` only for internal policy, never for product documentation"); or move one behind a sub-agent so the decision is made with a smaller menu.

Menu size matters. Selection accuracy degrades as the number of similar tools grows, so curate per step. A graph node that only needs three tools should be given three, not the platform's forty.

## Response design

What a tool returns is also prompt. Prefer compact, structured, self-describing results:

- Return the fields needed to decide, plus an identifier for the rest. A list result should carry `id`, a human label, and the two attributes most likely to be relevant — not forty columns.
- Paginate explicitly with a cursor, and say how many more exist. An agent given "50 results" with no total will assume completeness.
- Truncate with a pointer, not silently: `{"truncated": true, "total_bytes": 214_003, "handle": "doc_8812"}` plus a `read_handle` tool. Silent truncation is how agents conclude that a document does not mention something.
- Never return raw HTML, stack traces, or megabytes of JSON. Every token of noise competes with the instruction.
- Echo back the identifying keys you acted on (`order_id`), so the model can verify it targeted the right entity.

## Idempotency, because retries are normal

Three sources of duplicate calls: the model repeats a step it thinks failed, the orchestrator retries on timeout, and a resumed run replays the last node. All three are routine, so every write tool must survive being called twice with the same intent.

- Accept an `idempotency_key` and deduplicate server-side, returning the original result on a repeat. Derive the key from the intent, not a random UUID: `refund:{order_id}:{amount_cents}:{reason_code}`.
- Separate reads from writes at the tool level. A single `manage_*` tool that sometimes mutates makes retry policy impossible.
- For irreversible actions (send email, charge card, delete record) prefer a two-phase shape: `prepare_*` returns a preview and a token, `commit_*` executes. The preview is cheap to redo, gives the model a chance to notice a mistake, and gives you a natural audit record.
- Never make a write tool's success ambiguous. "It probably worked" guarantees a duplicate.

## Error surfaces are instructions

The model reads error strings and acts on them, so an error is a prompt you wrote under pressure. Structure it: a stable machine code, a one-line human message, whether retry is sensible, and what to change.

```json
{
  "ok": false,
  "code": "INVALID_DATE_RANGE",
  "message": "start_date must be on or before end_date",
  "retryable": false,
  "hint": "Swap the dates and call again; do not ask the user."
}
```

Three classes deserve different handling. **Retryable** (timeout, 429, 503): say so and let the orchestrator back off; do not let the model burn steps deciding. **Correctable** (validation, unknown enum value, missing required field): return the constraint precisely — "country must be one of US, CA, GB" — because the model can fix that in one turn. **Terminal** (not found, permission denied, already shipped): say "do not retry" and name the escalation, or the agent will loop.

Two things never belong in an error returned to the model: stack traces and secrets. A traceback teaches the model to retry a deterministic failure, and a connection string in an error message is a credential leak into logs and transcripts.

## Permissioning

The tool surface is the blast radius. Treat it as a security boundary, not a convenience layer.

- **Per-user credentials, not ambient ones.** The tool should act as the requesting user, with that user's scopes. An agent holding a service account with org-wide admin is a privilege-escalation engine that anyone who can phrase a prompt can drive.
- **Scope at the tool, not only at the endpoint.** `refund_order` should be unavailable — not merely rejected — to a session without refund rights. Absent tools cannot be prompted into existence.
- **Check model-supplied identifiers against session scope.** The classic *confused deputy*: the model passes `account_id=8812` and the tool trusts it. Resolve the account from the authenticated session and reject mismatches.
- **Least privilege by default, widened explicitly.** Read-only credentials for research tools; write credentials only for the specific resource; administrative actions behind an approval gate (chapter 6).
- **Rate-limit and budget per tool.** A tool that can be called 400 times will be, especially in a loop.

## Common mistakes

- One mega-tool with an `action` string, forcing the model to encode routing in an argument.
- Descriptions that restate the function name and omit when *not* to use the tool.
- Returning whole database rows, including fields the model should never see.
- Writes without idempotency, then "fixing" duplicates downstream.
- Error messages like `Error: 400` that give the model nothing to correct.
- Trusting IDs, tenant names, or amounts supplied by the model.
- Exposing a shell or arbitrary SQL because it "makes the agent more capable". It makes the incident larger.

## Production notes

Version tool schemas and keep old versions callable during rollout; a prompt pinned to an old description will behave differently against a renamed parameter. Log every call with arguments hash, latency, status code, and result size — arguments are the highest-value debugging signal you have, and hashes spot loops without storing sensitive payloads. Measure per-tool error rate and per-tool "called then abandoned" (a call whose result never influences the next step); the second finds tools the model selects but cannot use. Test tools twice: a contract test for the schema, and a selection test over realistic requests checking which tool the model picks. Different bugs, different tests.
