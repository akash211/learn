# How Tool Calling Works: Schemas, Selection, and Parallel Calls

Tool calling is a negotiation between two programs that cannot share memory. Your application describes a set of operations in text and JSON Schema; the model answers with a name and an argument object; your code decides what actually happens. Understanding the mechanics matters because almost every production failure — wrong tool chosen, arguments that fail validation, a side effect repeated twice — traces back to something in this contract rather than to the model being "bad at reasoning".

## The request contains the tools, not the model

There is no persistent toolbox attached to a model. Every request carries the tool definitions in the request body, exactly like the system prompt: if you omit them, the model has nothing to call. If you send fifty, all fifty are in the context window and billed as input tokens on every turn.

A definition has three parts and one optional one:

| Part | Purpose | Consequence if weak |
|---|---|---|
| `name` | Identifier the model emits and your dispatcher matches | Collisions call the wrong handler |
| `description` | Natural-language specification the model reads to decide *whether* and *how* | Wrong tool selected; arguments misunderstood |
| `parameters` | JSON Schema for the argument object | Invalid or under-specified calls |
| strictness flag | Provider-specific constraint on generation | Syntactically valid but schema-invalid JSON |

OpenAI's Chat Completions shape nests the function under a typed wrapper: `{"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}`. Its newer Responses API flattens the same information (`{"type": "function", "name": ..., "parameters": ...}`) and adds a `strict` flag. Anthropic's Messages API uses `{"name": ..., "description": ..., "input_schema": {...}}` — same three fields, different key names, and `input_schema` holds an ordinary JSON Schema object.

These differences are cosmetic and belong behind one internal representation. Define your tools once, in your own type, and render them per provider at the edge. What is *not* cosmetic is that Anthropic returns arguments as a parsed object while OpenAI returns a JSON-encoded string in `function.arguments`. Code that assumes a dict breaks the moment you add a provider or switch to streaming, where both providers deliver arguments as fragments.

## JSON Schema is doing real work

The `parameters` value is a JSON Schema, but providers support a subset. In strict modes, OpenAI requires that every property appear in `required` (optionality is expressed with a nullable type or an empty-string sentinel), that `additionalProperties` be `false`, and that the schema avoid unsupported keywords such as recursive `$ref`, complex `oneOf`, or `patternProperties`. Some keywords are silently ignored rather than rejected, which is worse: the model can produce a value that passes the provider's grammar and fails your validator.

Practical rules that hold across providers:

- Prefer `enum` over `pattern` for closed sets. Enums steer generation; regexes only reject.
- Model optionality explicitly. `{"type": ["string", "null"]}` with `"required": ["x"]` is more reliable than omitting the key, because models handle "present but null" better than "absent".
- Avoid deeply nested objects. Argument quality degrades faster with nesting depth than with the number of top-level fields; flatten or split the tool.
- Never rely on `format: "date-time"` for validation. It is advisory in most implementations — enforce it in code.
- Keep descriptions inside the schema too, not only at the top level. Per-property `description` is what disambiguates `start_date` from `created_after`.

Validate the schema itself at startup, not per request. A schema the provider rejects produces a 400 at 2 a.m.; a schema snapshot test produces a failing build.

## How the model selects a tool

Selection is a classification problem over your descriptions plus the conversation. The model reads names, descriptions, and the user's request, and picks. Three levers control this:

`tool_choice` — `auto` lets the model answer in prose or call a tool; `none` forbids calls; `required`/`any` forces at least one call; a named tool forces that specific one. OpenAI, Anthropic, and most compatible servers expose these modes with slightly different spellings of the forced variants.

**Descriptions as discriminators.** If two tools could plausibly apply, the model picks by whichever description reads as a better match. Vague descriptions ("Search for things") produce coin-flip routing. Descriptions that state the triggering condition ("Use when the user gives an order ID and needs its current fulfilment status") produce stable routing.

**Tool count.** Accuracy falls as the list grows, particularly when names share prefixes (`get_user`, `get_user_orders`, `get_user_preferences`). Beyond roughly a dozen tools, group them behind a smaller number of parameterised entry points or add a retrieval step that selects a candidate set. Sending everything and hoping is the most common cause of "the agent picks the wrong tool".

Forcing a tool is not a correctness mechanism. `tool_choice` with a named tool guarantees *a* call with that name; it does not guarantee the arguments make sense, and it removes the model's ability to answer "I can't do that" or ask a clarifying question.

## The round trip, and why transcripts grow

A tool-using turn is at least two model calls:

1. Request with tools → response with `finish_reason`/`stop_reason` indicating a tool call.
2. You append the assistant message exactly as received, execute, append one result message per call, and request again.

OpenAI marks this with `finish_reason: "tool_calls"` and an assistant message containing a `tool_calls` array; each entry has an `id`, a `type`, and `function.name` / `function.arguments`. Results go back as messages with `role: "tool"` and a matching `tool_call_id`. Anthropic uses `stop_reason: "tool_use"`, content blocks of `type: "tool_use"` with `id`, `name`, `input`, and results returned as a *user* message containing `tool_result` blocks that reference `tool_use_id`. Anthropic additionally supports `is_error: true` on a result block, which is the cleanest way to tell the model that the call failed rather than returned data.

Both APIs are stateless: you resend the whole conversation each turn. A ten-step agent run therefore pays for the system prompt and all ten tool results ten times. That is the real cost model of agents, and it is why tool results should be small, stable, and cache-friendly — providers discount repeated identical prefixes, so keeping early turns byte-identical preserves those savings.

## Parallel calls

Modern models routinely emit several calls in one turn: three lookups, or a read followed by a write they believe is independent. Both major providers support this and both let you disable it (`parallel_tool_calls: false` on OpenAI; `disable_parallel_tool_use` inside `tool_choice` on Anthropic).

Parallelism is a performance feature and a correctness hazard. Execute independent calls concurrently, but respect dependencies the model may have assumed wrongly: if call B's arguments were derived from what the model *expects* call A to return, running them together is fine, but running them out of order and streaming partial results into the next turn is not. Return every result, one message per `tool_call_id`, in the same turn — omitting one leaves the transcript malformed and many providers reject the next request.

Failure handling needs a policy per batch: all-or-nothing (abort and report), best-effort (return successes and structured errors), or fail-fast on the first terminal error. Best-effort is usually right for reads, all-or-nothing for writes that must be consistent.

## Common mistakes

- Treating `function.arguments` as an object. It is a JSON string on OpenAI; parse and validate it.
- Assuming the call is valid because it parsed. Schema validity says nothing about whether the customer ID exists or the amount is sane.
- Handing the model a `run_sql` or `run_shell` tool because it is "more flexible". You have replaced an interface with a general-purpose interpreter.
- Letting the model decide permissions. It can request; your dispatcher authorises.

## Production notes

Log, per call: request ID, model and version, tool name, argument hash, validation outcome, authorisation decision, latency, result size, and whether the result was an error. That record is what makes an incident debuggable, and it is the dataset you will later use for evaluation.

Bound argument size before parsing (a 4 MB argument object is an attack or a bug), set a per-tool timeout shorter than the request deadline, and cap the number of steps per conversation. Treat the tool-call ID as the unit of correlation across logs, traces, and the idempotency store described in chapter 4 — it is the only identifier both the model and your infrastructure agree on.
