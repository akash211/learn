# Orchestration Loops, Retries, and Duplicate Side Effects

A tool call is one turn. An agent is a loop, and the loop has properties no single request has: an unbounded step count, cumulative latency, a growing transcript, and multiple opportunities to perform the same side effect twice. Most agent incidents are loop bugs wearing a model costume.

## The loop, precisely

```python
state = Conversation(system=SYSTEM, messages=[user_message], tools=SPECS)

for step in range(MAX_STEPS):
    reply = model.complete(state, timeout=remaining_time())
    state.append(reply)

    if not reply.tool_calls:
        return reply.text

    results = dispatcher.execute(reply.tool_calls, principal=user)  # validates, authorises, executes
    state.append_tool_results(results)

return Outcome.budget_exhausted(state)   # never silently return partial text
```

Four budgets, all enforced, none optional:

| Budget | Why it exists | Typical guard |
|---|---|---|
| Steps | Prevents loops and runaway cost | 8–20 depending on task |
| Wall clock | User is waiting; downstream tokens expire | 30–120 s per user turn |
| Tokens | Cost and context exhaustion | Per-call and cumulative |
| Side effects | Blast radius | Max writes per run, e.g. 1 refund |

Enforce them in the loop, not in the prompt. "Do not take more than five steps" is advice; `range(MAX_STEPS)` is a guarantee. When a budget trips, the caller must get a truthful outcome — not a truncated answer that reads like success.

## Termination is a design decision

The loop ends when the model stops requesting tools, or when a budget trips, or when your code decides the task is done. Three extra conditions are worth implementing because they catch the failures models actually exhibit:

**Repeated identical call.** Hash `(tool_name, canonical_args)` and count. A second identical call with identical args in the same run is usually a stall, not a deliberate retry. If the model does it, return a result that says "this exact call was already made and returned the following; do not repeat it".

**No progress.** If three consecutive steps produce no new state — no successful write, no new information — stop.

**Human-required action.** If the model requests a tool that needs approval, suspend the run with a durable checkpoint rather than blocking a request thread. The resume path must not re-execute already-completed steps (see below).

## Retry classes

Retries inside an agent loop come from three places, and mixing them is how amplification happens.

1. **The HTTP client / SDK** retrying a failed model call.
2. **The dispatcher** retrying a failed tool execution.
3. **The model** re-issuing the same tool call on the next turn because it saw an error.

Each layer must have one owner and one policy. In practice: SDK retries for connection errors and 429/5xx with jittered backoff; dispatcher retries only for idempotent reads and only for transient failures; the model gets an error result and is told whether a retry is appropriate via the `retryable` flag from chapter 3.

Never let all three retry. Three layers × three attempts is twenty-seven backend calls for one user request, and if any is a write, up to twenty-seven charges.

Backoff belongs in the dispatcher with a deadline derived from the run's remaining wall clock, not a fixed schedule. If 800 ms remain, a one-second sleep followed by a retry is worse than returning `deadline_exceeded` immediately.

## Where duplicate side effects come from

This is the failure that costs money, so enumerate the sources rather than trusting vigilance: an ambiguous timeout (your 10 s limit fires while the upstream applies the refund at 12 s); the model re-issuing after `retryable: true`; a loop restarted from a persisted transcript after a crash or a "try again" click; queue redelivery of the tool execution itself; a user double-submit; and parallel fan-out, where the model emits two creates because it was unsure the first succeeded. That last one is underappreciated: models emit redundant writes when results look ambiguous, so "the model will not do that" is not a control.

## Idempotency keys, derived rather than invented

The standard mechanism is a key the server stores alongside the effect, so a repeated submission returns the original outcome instead of performing the operation again. Two properties decide whether it works:

**The key must be stable across the retries you want to deduplicate.** Generate it deterministically:

```python
def idempotency_key(run_id: str, tool: str, args: dict) -> str:
    canonical = json.dumps(args, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "tc_" + hashlib.sha256(f"{run_id}|{tool}|{canonical}".encode()).hexdigest()

# run-level key, stable across model re-issues within one conversation
workflow_key = f"{conversation_id}:{intent_slot}"   # for writes the user meant once
```

Canonicalisation is not a detail. Key order, float formatting, whitespace, unicode normalisation, and trailing slashes all change the hash. `{"amount": 45.90}` and `{"amount": 45.9}` must produce the same key, or deduplication silently fails. Likewise, never include a timestamp, a random nonce, or the model's `tool_call_id` in the key: the first makes every call unique, and the `tool_call_id` differs on a re-issue, which is precisely the case you need to catch.

Two scoping choices are both valid and serve different purposes. **Per call** (hash of args, scoped to the run) deduplicates a model's accidental repeat of the same action. **Per intent** (a slot the application assigns, e.g. "refund for order 8812 in this conversation") deduplicates a user pressing "try again" or a run resuming after a crash, which is the case that prevents double refunds. Use the intent-scoped key for irreversible writes.

## Reserve, act, record

The server side must be atomic with respect to concurrency. A workable sequence, with the order mattering more than the technology:

1. Look up the key. If a completed record exists, return the stored response verbatim.
2. If an in-progress record exists (another worker holds it), return `409 in_progress` or wait with a short deadline. Do not execute.
3. Insert the reservation with a unique constraint on the key. The constraint — not a `SELECT` followed by an `INSERT` — is what makes this safe under concurrency.
4. Perform the effect.
5. Write the outcome to the record and mark it complete.

If step 4 succeeds and step 5 crashes, the record stays in-progress and a retry cannot distinguish "never happened" from "happened, unrecorded". That is why the *upstream* system should also accept your key where it supports one, and why long effects should be split so the ambiguous window is small. A common shape: create a durable operation record first, then have a worker perform it, then mark it complete — the retry then resumes a known operation rather than re-deciding.

Exactly-once delivery does not exist across a network boundary. What you can build is **at-most-once effect on writes** plus **at-least-once reads**, and a reconciliation job for anything left in-progress beyond a threshold.

## Resuming a run without replaying it

If runs can pause (approval, crash, long tool), persist the transcript *and* a step ledger: for each step, the call ID, the argument hash, the outcome, and whether the effect was committed. On resume, replay the transcript for the model's benefit but skip execution for steps whose effects are already recorded, substituting the stored result. Without the ledger, "resume" means "do it all again", which for a refund tool is a incident with a timestamp.

For multi-step writes that must all happen or none, a saga with explicit compensating actions is usually more honest than a distributed transaction: record each step, and on failure run compensations in reverse, idempotently, keyed by the same run.

## Common mistakes

- No step budget; the loop ends when the provider's context limit does.
- Retrying non-idempotent writes because "it was probably a network blip".
- Deriving the idempotency key from the model's `tool_call_id`, which changes on every re-issue.
- Resuming a crashed run by replaying the transcript and re-executing everything.
- Swallowing budget exhaustion and returning partial text as if it were the answer.

## Production notes

Track, per run: steps used, tool calls by name, duplicate-call detections, idempotency hits, in-progress conflicts, retries by layer, and total wall clock. Alert on idempotency-hit rate spikes — a sudden rise means something upstream started timing out, and the dedupe layer is the only thing standing between you and duplicates.

Rehearse the ugly cases in tests: a tool that commits and then drops the response; two identical calls arriving within 5 ms; a resume after a kill between effect and record; a key reused with different arguments (must fail loudly, not silently return the old result). Those four scenarios cover most of the ways this goes wrong in production.
