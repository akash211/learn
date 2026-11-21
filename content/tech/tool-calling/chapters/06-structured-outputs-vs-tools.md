# Structured Outputs vs Tool Calls

Both features ask the model to produce JSON matching a schema, and both are built on the same machinery. They are not interchangeable, and choosing the wrong one produces systems that look fine in a demo and are awkward to reason about later.

## The distinction that matters

A **structured output** is a *document*: the model's answer, shaped. A **tool call** is an *invocation*: a request to do something, carrying the arguments for it. The difference is intent and consequence, not format.

| | Structured output | Tool call |
|---|---|---|
| Semantics | "Here is the result" | "Please perform this" |
| Arity | Exactly one document per response | Zero, one, or many calls per turn |
| Continuation | Usually terminal | Necessarily continues the loop |
| Side effects | None by itself | Whatever the handler does |
| Schema lives in | Response format | Tool definition |
| Typical use | Extraction, classification, routing labels | Actions, lookups, multi-step work |

A model that returns `{"intent": "refund", "order_id": "ord_8812a1f0", "amount_minor": 4599}` as a structured output has done classification. Nothing has happened yet, and your code decides whether to act. A model that returns a `issue_refund` tool call has asked you to act, and the security boundary from chapter 5 now applies to that request.

## When structured output is the right tool

Choose a response schema when the model's job ends with producing data:

- **Extraction**: invoices to line items, emails to contact records, support tickets to category and priority.
- **Classification and routing**: which queue, which policy, which of five known intents — especially when you want the label plus a rationale field.
- **Normalisation**: free-text addresses into structured components.
- **Planning as data**: a list of steps you will validate and execute yourself. This is the "model proposes, code disposes" pattern and it is often safer than letting the model drive.

Structured output keeps the control flow in your program. There is one request, one response, no loop, no transcript growth, and no chance of the model calling something twice. It is also easier to evaluate: compare the parsed object to an expected object, and you are done.

## When a tool call is the right tool

Choose a tool when the model genuinely needs to *act or observe*, especially when the sequence is not known in advance:

- The next step depends on what the previous step returned (look up the customer, then decide whether a refund is in policy).
- The set of resources is open-ended (search, then fetch by ID, then page).
- The operation has a real side effect that must be authorised, approved, and audited as an operation.
- You want the provider's native round-trip, including parallel calls, result formatting, and error signalling.

If you find yourself using a tool call purely to get JSON back — a single tool that "returns" the extraction and is never meant to be executed — you have built structured output with extra steps and worse semantics.

## The forced-tool-call trick, and why it lingers

Before native JSON-schema response formats were widely available, the standard workaround was to define one tool, e.g. `submit_answer`, and force it with `tool_choice` so the model had to emit schema-shaped arguments. That still works, and on some providers it remains the most reliable way to get strict adherence on complex schemas.

Its costs are real. Your logs show a tool invocation that never happened. Your dispatcher needs a special case that treats this "tool" as a response rather than an action. Error handling gets confused: is `invalid_arguments` a failed action or a failed parse? And future maintainers read the code as an agent that does nothing but talk to itself.

Use it when you must, isolate it behind one adapter, and name it clearly (`emit_extraction`, never `save_record`). Prefer the provider's native structured-output mode where it exists, and verify current support in the docs — this area changes faster than any other in the module.

## Strictness is syntax, not meaning

Constrained or "strict" modes restrict decoding so the output matches the schema's grammar. That eliminates the class of failures where the model emits an unquoted string, a trailing comma, or a missing brace. It does not:

- Guarantee the values are true, plausible, or refer to real records.
- Enforce `format: "date-time"`, `minimum`, or `maxLength` in every implementation.
- Support every JSON Schema keyword. Recursive `$ref`, `oneOf` with overlapping branches, `patternProperties`, and some numeric bounds are commonly unsupported or silently ignored.
- Validate against your domain. A perfectly shaped `{"order_id": "ord_000000"}` is still a hallucinated order.

So the rule stands: validate at the boundary even when the provider says strict. The validator is also your compatibility layer — the same code works when you switch to a model or provider without strict support.

Practical schema advice for both features: keep nesting shallow, prefer flat objects with explicit nullable fields over deep `oneOf` trees, use enums for closed sets, put constraints where the model can see them (descriptions), and keep the schema under a few kilobytes. Very large schemas cost input tokens on every request and measurably degrade adherence.

## Combining them

Three compositions are worth knowing:

**Structured output containing a plan.** The model returns `{"steps": [{"tool": "get_order", "args": {...}}, ...]}` against a schema where `tool` is an enum of allowed names and `args` is deliberately loose (an object). Your executor validates each step against the real tool schema, applies policy, and runs them. You get the model's sequencing without giving it live control, and the whole plan is auditable in one object. The trade-off: no adaptation to intermediate results, which is exactly what you want for repeatable back-office workflows and exactly what you do not want for exploration.

**Tool results that are themselves structured.** A tool returning `{"ok": true, "data": {...}}` gives the model a stable envelope across all tools. Keep the envelope identical for every tool; per-tool shapes inside `data` are fine.

**A tool whose only job is to hand back a schema-shaped artifact.** E.g. `propose_query(plan: QueryPlan)`. Useful when the artifact is genuinely an action request, but do not let it become the generic JSON channel.

One caution about mixing: if the model can both produce free prose and call tools, some providers will emit prose *and* a call, or emit a call inside a code fence. Treat the structured field as authoritative and never parse the prose for arguments.

## Cost and latency

Schemas are input tokens, counted on every request in the conversation. A 3 KB schema for a tool that is never called still costs on every turn. Structured output schemas cost once per response, which is usually cheaper.

For high-volume classification, a small model with a tiny schema (`{"enum": ["a","b","c"]}`) is often several times cheaper and faster than a large model with a tool, and its accuracy on a narrow label set is frequently adequate. Benchmark the small structured-output path against the tool-calling path before assuming the larger model is required.

## Common mistakes

- Using tools for pure extraction, then shipping a dispatcher full of "tools" that never execute.
- Assuming `strict` means semantically correct, and skipping validation.
- Deeply nested union schemas that some providers reject at request time and others silently degrade on.
- Different result envelopes per tool, forcing the model to relearn the shape every call.
- Parsing the assistant's prose for the answer while ignoring the structured field.
- Forgetting that the schema is billed on every turn of a long conversation.
- Conflating "the model returned valid JSON" with "the model returned a valid answer".

## Production notes

Snapshot both kinds of schema in tests: assert the exact JSON Schema your code sends, so an accidental type change fails CI rather than production. Validate the schema against the provider at startup with a tiny probe request — a rejected schema is a deployment error, not a runtime surprise.

Log the structured field verbatim (redacted) for both features. When a classification disagrees with a human review, that log is the only evidence of what the model actually saw and said. And measure the failure split: syntax failures (should be near zero with strict modes), schema failures (keyword support gaps), and semantic failures (the real, ongoing work).
