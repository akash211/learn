# Observability and Cost Control

An agent produces two outputs per run: an answer, and a bill. Neither is visible from a normal application dashboard. A request that returns 200 in 40 ms is healthy; an agent run that returns 200 after nineteen steps, two retries, and a duplicated write is a 200 too. The instrumentation that makes the difference visible is the same instrumentation that lets you debug the run, which is why observability and cost control are one chapter and not two.

## What a trace has to contain

A trace is a tree, not a log line. One run has one trace id, propagated into every model call, tool call, and downstream request, with the user and session ids attached as attributes (hashed or redacted where they are personal data).

Per **model call**: model name and version, prompt version id, token counts split into input, cached input, output, and reasoning where the provider reports them, latency to first token and total, finish reason, and a hash of the rendered prompt.

Per **tool call**: tool name, arguments hash plus the safe subset of arguments, status code, error class, latency, and result size in bytes and tokens.

Per **step**: index, the decision that was taken (which tool, or final answer), the state delta, and the budget consumed so far.

Per **run**: stop reason from the enumerable set, total steps, total tokens, total cost, wall clock, and outcome. That last one is the join between observability and evaluation: the trace is the record, the eval is the judgement, and they should share an id.

```python
with tracer.start_as_current_span("agent.run", attributes={"run.id": run_id}) as run_span:
    for step in budget:
        with tracer.start_as_current_span(f"step.{step.index}"):
            reply = call_model(state, tools)            # child span: tokens, latency
            for call in reply.tool_calls:
                with tracer.start_as_current_span(f"tool.{call.name}"):
                    result = run_tool(call)              # child span: status, size
            state.apply(reply)
            run_span.set_attribute("run.tokens", state.tokens)
```

OpenTelemetry's GenAI semantic conventions cover most of this shape, and using them means the traces land in existing tooling instead of a bespoke dashboard nobody checks.

## Why the trace is the product

Three questions arrive in every incident: what did it try, what did it see, and where did it stop. A log line per request answers none of them. A trace answers all three, and it is also what the eval harness reads, what the reviewer sees in an approval, and what a new engineer reads to understand the system.

Practical consequences: sample aggressively at the head (100% of errors and escalations, a small percentage of successes), redact on write, and retain long enough to cover a slow-burning quality regression — thirty days is common, longer for regulated actions. Store large payloads out of band with a content hash in the span; traces that carry 200 KB tool results become expensive and unreadable.

## Where the money goes

Four levers, in order of impact:

**Input tokens grow with history.** Every step resends the system prompt, tool schemas, task, and accumulated observations. On a fifteen-step run, input dominates the bill even though output is priced higher per token. The fix is not a cheaper model; it is less context — prune observations, summarise, and stop carrying tool schemas the step cannot use.

**Prompt caching rewards a stable prefix.** Put the unchanging part first (system prompt, tool definitions, long reference material) and the varying part last. Any edit that rewrites the prefix — reordering tools, injecting a timestamp at the top, regenerating the system prompt per request — silently disables caching and can multiply cost.

**Model routing beats model choice.** Use a small model for classification, extraction, and routing, and the large model only where reasoning is the product. A triage call that picks one of four dispositions does not need the frontier model. Measure each node's contribution to outcome before downgrading, though — routing errors are cheap and compound.

**Output and reasoning tokens are the expensive ones.** Cap output, ask for structured short answers, and treat a verbose trace as a cost item (chapter 2). Streaming does not reduce cost; it reduces perceived latency.

## Budgets you can enforce

A budget that is checked after the call is a report, not a control. Enforce before: count tokens for the assembled context, compare against the remaining allowance, and refuse the call if it would exceed it — with a distinct stop reason so the run is distinguishable from a model failure.

Set four: per step (a single runaway generation), per run (the trajectory), per tenant per day (abuse), and per tool (a loop calling one endpoint). Soft limits warn and annotate the trace; hard limits stop and return a partial result with `budget_exceeded`. Chapter 6's approvals and chapter 10's operations both depend on this being real.

Then measure **cost per success**, not cost per call. An agent that costs $0.04 per call and succeeds half the time costs $0.08 per success, and that number is the one that belongs next to the success rate on a dashboard.

## Retries without amplification

Retries are where cost control and correctness collide. Rules that hold:

- Retry only transient classes: timeouts, connection resets, 429, 5xx. Never retry a 400, a validation failure, or a permission error — the model will read the same error again and may "fix" it by inventing arguments.
- Exponential backoff with jitter, capped attempts, and honour `Retry-After`. A retry storm against a rate-limited provider turns a short outage into a long one.
- Retry the *call*, not the *run*. Re-running a whole trajectory because one tool timed out repeats every side effect in it.
- Make side effects idempotent (chapter 4) before you enable automatic retries, not after.
- A fallback model is a different system: it may call different tools, produce a different schema, and behave differently on refusal. Re-run the eval suite against the fallback before you rely on it, and tag traces with which model served the call.

## Latency, and the tail

Agent latency is a sum of many round trips, so the tail is where the pain is. Parallelise independent tool calls (a plan with three independent lookups should not serialise them). Stream tokens to the UI so perceived latency is first-token, not total. Give every step its own timeout, and make the run timeout strictly greater than the sum of the step timeouts you expect, not equal to one of them.

Circuit-break per dependency. When a search provider is down, an agent that keeps calling it burns its step budget discovering the outage on every run. A broken dependency should fail one step fast and route to a degraded path — "I could not reach the documentation service; here is what I have" is a usable answer.

## Common mistakes

- Logging whole prompts and responses unredacted, turning the observability system into the largest PII store in the company.
- One aggregate "agent errors" metric that hides the difference between model refusal, tool failure, and budget exhaustion.
- Tracking cost per call while success rate falls, so the dashboard improves as the product gets worse.
- Retrying non-idempotent writes "just in case".
- Prompt caching disabled by a per-request timestamp at the top of the system prompt.
- No per-tenant quota, discovered when one customer's batch job consumes the month's budget.
- Tracing 100% of successful runs at full payload size, then disabling tracing because the bill for tracing exceeded the agents'.

## Production notes

Build the dashboard before the launch: success rate, cost per success, p50/p95 latency, step-count distribution, tool error rate by tool, and stop-reason mix. Alert on rates of change, not absolute values — a step-limit rate that doubles overnight is actionable even when the absolute number looks acceptable. Keep a per-run ledger that finance can reconcile, with the model price table versioned alongside the code, because provider prices change and historical costs must not silently recompute. Finally, put a kill switch on spend: a single flag that disables the agent for a tenant or globally, tested quarterly, so the answer to "what if this goes wrong at 3 a.m." is a command someone has run before.
