# Validation and Error Contracts

The model is an untrusted client. It produces arguments that are usually well-formed, frequently plausible, and occasionally wrong in ways no schema can catch. Validation is the boundary where a suggestion becomes an operation, and the error contract is how you teach the model to recover without teaching an attacker anything.

## Two layers, different jobs

**Structural validation** answers: is this a well-formed instance of the declared schema? Types, required keys, enum membership, string length, numeric bounds, array size, no unknown properties. This is what a JSON Schema validator or a typed model does, and it should be mechanical and total — every call passes through it, no exceptions for "trusted" tools.

**Semantic validation** answers: does this make sense against reality? Does the account exist, is the amount within the refundable balance, is the date in the future, does the address belong to this customer, is the state transition legal. This requires your domain and your database, so it belongs in the handler, not the schema.

Teams that stop at structural validation ship tools that accept `{"order_id": "ord_000000"}` — valid string, nonexistent order — and then either raise an unhandled exception or, worse, match it loosely to some other order. Both layers must reject, and both must reject into the same error shape.

## Parse defensively

```python
class RefundArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    order_id: Annotated[str, StringConstraints(pattern=r"^ord_[0-9a-f]{8}$")]
    amount_minor: Annotated[int, Field(gt=0, le=5_000_00)]
    reason: Literal["damaged", "not_received", "duplicate_charge"]

def handle_refund(raw: str | dict, principal: Principal) -> ToolResult:
    try:
        args = RefundArgs.model_validate_json(raw) if isinstance(raw, str) else RefundArgs.model_validate(raw)
    except ValidationError as exc:
        return ToolResult.failure(
            code="invalid_arguments",
            message=render_for_model(exc),   # field paths + expectation, no internals
            retryable=False,
            details={"violations": redact(exc.errors())},
        )
```

Four things in that snippet are deliberate.

`extra="forbid"` rejects hallucinated fields instead of dropping them. A model that adds `"currency": "EUR"` to a tool with no currency parameter should be told, not silently ignored — the silence hides a misunderstanding that will resurface.

Coercion is conservative. Accepting `"5"` for an integer is usually fine; accepting `"five dollars"` is not. Strict modes already guarantee types on some providers, but you cannot assume that for every model you route to, or for arguments that arrive through a queue or a replayed log.

Bounds are semantic as well as structural. `le=5_000_00` encodes a policy ceiling in the schema, so it appears in the description the model reads and in the validator that enforces it.

## Validate the resource, not just the arguments

An argument can be perfectly formed and still refer to something the caller must not touch. Object-level authorisation is not a schema concern:

- The `order_id` exists **and** belongs to the authenticated principal.
- The `account_id` is in the tenant the session was scoped to.
- The `file_path` resolves, after symlink resolution, inside the allowed root.
- The `url` resolves to a public address, after redirects, not to a link-local metadata endpoint.

Check these in the handler, on the resolved object, before the side effect. Never derive authorisation from the model's description of what the user asked for — the model's summary of intent is not evidence of entitlement.

## What the model should see when a call fails

The error goes back into the context window and becomes the model's only information about what to do next. Three properties matter: it must be **actionable**, **safe**, and **distinguishable from data**.

```json
{
  "ok": false,
  "error": {
    "code": "invalid_arguments",
    "message": "amount_minor must be a positive integer in minor units (cents). Received 4599.00, which is not an integer.",
    "field": "amount_minor",
    "retryable": false,
    "hint": "Pass 459900 for 4599.00 USD."
  }
}
```

The `code` is stable and machine-checkable. The `message` states the expectation and the received value in domain terms, not in validator jargon. The `field` lets a repair loop target the fix. `retryable` tells the loop whether an identical retry could ever work. The `hint` is optional and only present when you know the correct form.

Classify every failure into one of three buckets, and make the classification explicit in the payload:

| Class | Examples | Model should | Loop should |
|---|---|---|---|
| **Fixable by the model** | Bad argument type, unknown enum member, missing required field, malformed ID | Correct the call and retry once | Allow one repair attempt |
| **Transient** | Timeout, 503, rate limit, connection reset | Nothing — retrying is the runtime's job | Backoff and retry within budget, same idempotency key |
| **Terminal** | Forbidden, policy denial, not found under this principal, quota exhausted, validation of a business invariant | Explain to the user, stop | Do not retry; surface to the user or escalate |

Conflating these is the most damaging error-contract mistake. A model told "forbidden" may try a different tool that performs the same effect; a model told "temporarily unavailable" may loop. A runtime that retries a terminal error wastes budget and can duplicate side effects.

## Do not leak the inside of your system

Error messages travel into a context window, into logs, and potentially into a user-facing answer. Strip:

- Stack traces and exception class names.
- SQL text, table names, and column names not already public.
- Internal hostnames, IP addresses, bucket names, and queue URLs.
- Tokens, cookies, and anything from an `Authorization` header.
- Whether an account exists, when that fact is itself sensitive. Prefer a generic not-found over a distinguishable forbidden for object lookups on public-facing surfaces.

Log the full detail server-side against the call ID; return the sanitised form.

Careful: sanitising must not remove information the model needs to act. "Database error" is safe and useless. "Query exceeded the 5-second limit; add a filter on `created_at` or reduce the date range" is safe and useful.

## Never signal failure with a success shape

```json
{"ok": true, "result": "I couldn't find any orders for that customer."}
```

This is a bug that survives review because it reads fine to a human. To the model it is a successful read whose content is a sentence, and it will either quote it as a finding or conclude the customer has no orders when the real cause was a typo in the email. If the operation succeeded but produced nothing, return an empty collection plus a count. If it failed, set the failure flag — and on Anthropic, mark the `tool_result` block `is_error: true`, which is the provider-level signal that the content is an error rather than data.

## Repair loops need a stop condition

A common pattern: on a fixable error, append the error result and let the model re-issue the call. This works, and it is also an infinite-loop generator if unguarded.

- Allow at most one or two repair attempts per tool per user turn.
- If the same `code` + same `field` appears twice, stop and surface a human-readable message. The model has not understood; a third attempt will not help.
- Count repairs against the same step budget as normal calls, so a repair storm cannot bypass the cap.
- Log repair rate per tool. Above a few percent, the schema or description is wrong — fix the tool, not the prompt.

## Common mistakes

- Validating only in the handler and letting unparseable arguments raise, so the model sees "tool failed" with no detail.
- Returning raw exception text, leaking SQL and hostnames into the transcript.
- Treating "not found" as a hard error for a search tool, or as success with a sentence for a get-by-ID tool.
- Retrying validation errors automatically in the runtime; the payload will not change.
- Letting the model retry indefinitely on a terminal authorisation failure.
- Trusting `format` annotations in JSON Schema as validation.

## Production notes

Emit a metric per `(tool, error.code)`. The distribution tells you what to fix: a spike in `invalid_arguments` on one field is a schema bug; a spike in `not_found` is usually an upstream data or naming mismatch; a spike in `forbidden` after a permissions change is a policy rollout that missed a scope.

Test the error paths as carefully as the happy path — missing field, wrong type, unknown enum, oversized array, nonexistent ID, wrong-tenant ID, upstream timeout, upstream 500 with an HTML body. Each should produce a distinct, stable code. If your tests only assert "it failed", you have no error contract at all.
