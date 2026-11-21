# Memory — Context, Summaries, and Stores

"Memory" in agent systems names four different things that get conflated in design discussions: the current context window, a compressed history, a durable record of past episodes, and a knowledge base of facts. They have different lifetimes, different failure modes, and different costs. Choosing the wrong one is how agents end up either forgetting the task halfway or drowning in their own transcript.

## What the model actually has

The model has one thing: the tokens in this call. There is no hidden state between calls. Every memory design is therefore a *retrieval-and-assembly* problem — deciding which bytes to put in the window before each model call, and in what order. This is why "the agent remembers" always describes the surrounding system: a conversation appears to have memory because the client resends the transcript, and a coding agent appears to remember the repository because it re-reads files.

## Short-term memory: the working set

The working set is what the current step needs: the task statement, the plan or current sub-goal, the last few observations, and the tool catalogue. Everything else is a candidate for eviction.

The two hard constraints are size and position. Size is the obvious one — long trajectories blow the window, and the failure is not a clean error but a truncation somewhere in the middle of the assembly code, which is the worst possible place. Position is subtler: recall of material buried in the middle of a long context is weaker than recall of material at the start or end ("lost in the middle", Liu et al., 2023). An observation that mattered twelve steps ago is exactly the kind of thing that gets buried.

Practical working-set discipline:

- Keep the task statement pinned at the top of every call, verbatim. Do not let it drift into paraphrase through summarisation.
- Keep the last *k* observations verbatim, k small (two or three). Older observations get compressed or dropped.
- Put the current sub-goal immediately before the model's turn, not at the start of the message.
- Truncate tool output at the tool boundary, not later. A 200 KB page fetch that gets cut by the context assembler wastes the fetch and may cut mid-sentence; the tool should return a summary plus a handle for the full text.

## Summarisation: compression with a loss budget

When history exceeds a threshold, replace the oldest span with a summary. Three variants, each with a distinct failure:

**Rolling summary.** Keep a running summary, append each new turn, drop the oldest turns. Fails through *lossy drift*: the summary is regenerated repeatedly, and each regeneration can drop a detail ("account 4471") that later becomes essential. Mitigation: summarise once per span and never re-summarise an existing summary; keep identifiers out of prose summaries by extracting them into a structured slot.

**Structured state.** Instead of prose, maintain typed fields: task, constraints, entities touched, decisions made, open questions, artefacts (file paths, URLs, IDs). This is the most reliable form, because it fails visibly — a missing field is a bug you can see, whereas a missing sentence is invisible. Most production agents should prefer a small structured state object plus a short narrative summary over a long narrative alone.

**Retrieval over history.** Embed every observation and retrieve the top-k for the current step. Fails through *similarity is not relevance*: the embedding finds text that looks like the query, not the fact that constrains it. "Refund limit is 500" and "refund limit was raised" are near-identical vectors with opposite meanings.

```python
def assemble(state, step):
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": render_task(state.task)},          # pinned, verbatim
        {"role": "user", "content": render_state(state.facts)},        # structured slots
        {"role": "user", "content": summarise(state.history[:-3])},    # compressed tail
        *state.history[-3:],                                           # last observations verbatim
        {"role": "user", "content": f"Current step: {step}"},
    ]
```

## Episodic memory: what happened before

Episodic memory stores past runs — task, actions, outcome, and a short lesson — so a later run can avoid a repeated mistake or reuse a working approach. It is the mechanism behind "last time this customer's export failed because of a locale setting; check that first".

The failure modes are severe and worth stating plainly. *Stale episodes*: the world changed, the stored lesson did not, and the agent confidently applies an obsolete workaround. *False generalisation*: one incident becomes a rule ("this API always needs a retry"). *Poisoning*: a bad run gets stored as a lesson and propagates. *Privacy leakage*: episodes contain customer data and get re-injected into prompts for other customers.

Design rules that make episodic memory survivable: store the outcome alongside the lesson and only promote lessons from successful or explicitly verified runs; attach a timestamp, an environment/version tag, and an expiry; scope retrieval by tenant and by entity, not only by semantic similarity; and keep the injected episode short and clearly labelled as *prior experience, may be outdated* rather than as fact.

## Semantic memory: durable facts

Semantic memory is the knowledge layer — policies, schemas, product facts, entity attributes. In agent architectures this is usually a retrieval tool rather than injected context, and that distinction matters. If facts are injected at the start of every call, they compete for window space and go stale silently. If they are a tool (`lookup_policy(query)`), the agent fetches them when relevant, the answer carries a timestamp and source, and a stale fact produces a visible tool result rather than an invisible premise.

The exception is small, stable, high-traffic facts — the current user's name, their plan tier, today's date. Those belong in the prompt, because a tool call to fetch them is pure latency. The rule of thumb: *facts the agent always needs go in the prompt; facts it sometimes needs are a tool; facts that change hourly are always a tool.*

| Store | Lifetime | Typical medium | Main risk |
|---|---|---|---|
| Context window | One call | Tokens | Truncation mid-assembly; middle-of-context loss |
| Structured scratchpad | One run | JSON state object | Fields silently missing |
| Rolling summary | One run | Prose | Drift, dropped identifiers |
| Episodic store | Weeks–months | Vector/keyword index + metadata | Stale or poisoned lessons |
| Semantic store | Long | DB / index, retrieved via tool | Staleness without timestamps |

## Compaction and its costs

Compaction is any operation that reduces tokens: summarise, dedupe, drop tool schemas, truncate observations. It is necessary and it is never free. Three costs to budget explicitly: *information loss* (the dropped detail was the one that mattered), *latency* (compaction is itself a model call, on the critical path), and *cache invalidation* — if the prompt prefix changes, provider-side prompt caching stops helping, so a summarisation that rewrites the first thousand tokens can cost more than it saves.

Two habits reduce the damage. First, compact at natural boundaries — after a sub-goal completes, not mid-investigation. Second, make compaction reversible: when you drop an observation, keep the full artefact in a store and leave a handle (`obs_17, 4.2 KB, fetch_page result`) so the agent can re-read it if it needs to. Handles are cheap; lost context is not.

## Common mistakes

- Treating the message list as the system of record. Then state is prose, budgets are unenforceable, and resumption is impossible.
- Re-summarising a summary every turn until the identifiers are gone.
- Using vector similarity as the only relevance signal for history or episodes.
- Injecting every stored fact into every prompt, then wondering why the model ignores the instructions at the top.
- Storing episodes without outcomes, so failures become folklore.
- Forgetting that memory is an injection surface: anything written to it can be read back later, including text an attacker caused the agent to fetch (chapter 9).

## Production notes

Version the memory schema alongside the prompt. A field renamed in code but not in the store silently empties a slot, and the agent gets vaguer without erroring. Log the assembled context size per call and the fraction that is history versus instruction — a rising history share predicts quality loss before you see it. Give each run an id and each artefact a content hash so a re-read is a cache hit rather than a refetch. Finally, redact on write, not on read: personal data that reaches the store has already leaked, and read-time filters are the wrong place to discover that.
