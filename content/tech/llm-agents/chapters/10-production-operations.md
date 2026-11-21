# Running Agents in Production

Everything before this chapter makes an agent work. This one makes it keep working: on a bad Tuesday, at 3 a.m., while a provider is degrading, halfway through a run that must not be repeated. The engineering here is unglamorous and it is what separates a demo from a system.

## Shape: agents are not request handlers

An agent run takes seconds to hours and can pause for a human. Do not put it behind an HTTP request that expects a response in 30 seconds. The shape that survives:

- **A durable queue** for run creation, so a run is a record with an id before any model is called.
- **A worker** that executes steps, writes a checkpoint after each (chapter 5), and can be killed at any point.
- **A state store** for runs, checkpoints, and pending approvals, with the state schema versioned.
- **A streaming channel** (SSE or websockets) or polling endpoint so the UI can show progress without holding the worker open.
- **A decision endpoint** for approvals and cancellations, idempotent and authenticated (chapter 6).

The run id must appear in every trace span, log line, and outbound call. When a customer says "the agent is stuck", the first query is `run_id`, and it should return one record, not a grep through application logs.

## Timeouts, at three levels

**Per model call.** Provider timeouts are often generous by default; a hung call can sit for minutes. Set an explicit connect and total deadline, and treat a timeout as a retryable-by-the-caller condition (chapter 8).

**Per tool call.** A tool that hangs is worse than a tool that fails, because it consumes a worker and a budget slot while producing nothing. Every tool needs its own deadline — including the ones wrapping internal services you believe are fast.

**Per run.** Derived from the product, not from the sum of the others: "a user will wait five minutes" or "this must finish inside the nightly window". When it fires, stop cleanly, mark the run `timed_out`, persist the partial result, and tell the user what exists so far.

Cancellation must propagate. A user closing the session should cancel the run, and cancellation must reach the in-flight tool call — a cancelled run whose subprocess keeps running is a resource leak with a plausible explanation.

## Partial failure

The normal state of a distributed system is that one dependency is degraded. Decide per dependency whether to **degrade** (search unavailable: answer from cached documents, say so), **escalate** (payments API down: hand to a human rather than guess), or **fail** (the answer cannot be produced honestly).

Multi-step side effects need compensation, not hope. If the run issues a refund and then fails to record it, the next run does not know. Two patterns work: write the intent and the effect id into state *before* the call (so a resume can check), and where a saga is genuinely needed, define the inverse operation and run it on failure — acknowledging that some effects (an email sent, a payment captured) have no inverse and therefore need a gate in front rather than a rollback behind.

Provider outages deserve their own runbook. Model endpoints fail regionally, rate limits arrive in bursts, and a fallback model is not a drop-in: it may produce a different tool-call format, refuse differently, and answer worse. Keep a fallback that has passed the eval suite, tag traces with which model served each call, and never fail over silently inside a run that has already made side effects — a resumed run on a different model with different arguments is a correctness hazard.

## Prompts and tools are versioned artefacts

The prompt is the program. Treat it like one:

- **Version everything**: system prompt, tool descriptions, tool schemas, model version, decoding settings, and the routing logic. One `release_id` should identify the combination, and every run should record it.
- **Review prompt changes like code.** A diff plus an eval report. "Tweaked the wording" is not a review.
- **Keep prompts out of ad-hoc string concatenation.** Prompts assembled from six scattered f-strings cannot be versioned or evaluated. Load them from files or a registry, render with a documented template, and pin the model name in configuration rather than in the template.
- **Couple the prompt to its tools.** A prompt that mentions `search_docs` while the tool was renamed to `search_documentation` will produce a hallucinated call. Validate that every tool name referenced in the prompt exists at startup.
- **Pin model versions.** "Latest" is a dependency with no changelog. When the provider deprecates a version, that is a migration with an eval gate, not a config edit.

```yaml
# prompt release manifest, committed beside the code
release: 2026-03-14-refund-triage
model: vendor/model-2026-02
system_prompt: prompts/triage.v7.md
tools: [get_order, get_customer, policy_lookup, refund_order]
tool_schema_hash: 9f2c31e
decoding: {temperature: 0, max_output_tokens: 900}
eval: {suite: agent-core, pass_at_1: 0.87, pass_pow_5: 0.74}
```

## Rollout and rollback

Roll out in three steps: **shadow** (score decisions on live traffic without acting), **canary** (a small percentage of real runs, with the ability to stop), **ramp**. Gate each step on the eval suite and on production metrics — success rate, cost per success, step-limit rate, escalation rate — not on the absence of complaints.

Rollback must be instant and must not require a deploy. A flag that selects `release_id` gives you that, provided in-flight runs can finish on the release that started them: store `release_id` in the run state and route resumed steps to it, or accept that a rollback cancels in-flight runs and says so. The second is simpler and usually right; the first requires keeping old prompts and schemas loadable, which is an operational cost worth paying only for long-running work.

Prompt rollback is not enough if the tool schema changed. A change to a tool's arguments is an API break for the model, so version tool schemas too and keep the old version callable until no run can reference it.

## Operating it

**Dashboards**: success rate and cost per success by release, p95 latency, step-count distribution, tool error rate, stop-reason mix, approval latency and override rate. One page, one release filter.

**Alerts** on rates of change and on hard invariants. Hard invariants (duplicate refunds, forbidden tool calls, cross-tenant reads) alarm at any count above zero. Soft metrics alarm on deviation from a rolling baseline, not on a fixed threshold chosen on launch day.

**Runbooks** for the four incidents that actually happen: step-limit rate spikes (a prompt or tool regression — check the last release), cost spikes (a loop or a context blow-up — check tokens per run), approval backlog (notification path, not approver diligence), and provider outage (failover, then check whether the fallback's arguments are still valid).

**A kill switch** that disables the agent per tenant or globally, revoking tool credentials, tested quarterly.

## Common mistakes

- Running the loop inside a web request and discovering timeout behaviour in production.
- Retrying a whole run because one step failed, duplicating every side effect in it.
- Prompt text edited directly in a database row, unversioned, with no eval and no history.
- Rollback that requires a deploy, so the fix takes twenty minutes while the incident runs.
- A fallback model enabled in the failover path that was never evaluated, quietly changing refusal and tool-call behaviour.
- Alerts on absolute thresholds that were never revisited after launch.
- No record of which release served a run, making every regression investigation an archaeology project.

## Production notes

Write the run's stop reasons and release id to a table that outlives the trace retention window; six weeks later, "did the March release make escalation worse?" is answerable from that table and from nothing else. Keep a replay tool that takes a run id and re-executes it against a fixed clock and recorded tool responses — it is the difference between a hypothesis and a reproduction. Rehearse the kill switch and the provider failover before you need them, and record the rehearsal in the runbook. And when an incident closes, add the eval case (chapter 7) in the same week, while the failure is still concrete; the institutional memory of an agent system is its test suite, and it is written one incident at a time.
