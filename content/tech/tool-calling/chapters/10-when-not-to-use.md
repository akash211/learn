# When Not to Use Model-Driven Tool Calling

The most valuable skill with this material is knowing when to close the file. Model-driven tool use is a good architecture for a real class of problems and a bad one for several larger classes, and the cost of getting it wrong is paid forever: variance, latency, security surface, and an evaluation burden that never ends.

## The decision test

Ask five questions about the request stream.

1. **Is the mapping from input to action deterministic?** If "export last month's numbers" always means one endpoint with one parameter, you need a date parser, not a planner.
2. **Is the action space small and known?** Three possible actions is a `switch` statement.
3. **Is the input genuinely open-ended?** If users pick from a menu, buttons beat inference. If they type freely and the mapping needs judgement, a model earns its place.
4. **What does a wrong action cost?** Reading a public catalogue: cheap. Issuing a refund: expensive, and the whole approval apparatus from chapter 5 becomes mandatory.
5. **Can you write a regression test for the path?** If most requests follow one route, you can — and therefore you should, in code.

If the first two are "yes" and the fourth is "expensive", the answer is almost always a deterministic path with a narrow model component (extracting arguments), not an agent.

## Signals that you have over-agentified

These show up in telemetry before they show up in complaints:

- **The modal trajectory is identical for most runs.** Log the sequences; if 80% are the same three calls, that is a workflow pretending to be an agent.
- **The model chooses among options code could compute.** "Which of these two query tools" when a date range decides it.
- **More than two tool calls per simple request.** Usually fine-grained tools (chapter 2), but sometimes an unnecessary loop.
- **p95 latency exceeds the value of the answer.** Five round trips at 2 s each is ten seconds to save a form submission.
- **Token cost per request is dominated by the transcript.** You are paying repeatedly for context you already had.
- **You cannot explain a wrong answer after the fact.** No trajectory log, no clear decision point, just "the model decided".
- **The eval suite is the only thing that knows whether it works.** If correctness cannot be checked deterministically, the product is unverifiable.

## What to build instead

**A fixed pipeline.** Extract parameters with one structured-output call (or a regex, or a form), then run deterministic code. This keeps the model where it is genuinely better than code — understanding messy language — and keeps control flow where code is better.

```python
intent = classify(user_text)              # {"intent": "revenue_report", "month": "2026-02", "segment": "emea"}
if intent.intent == "revenue_report":
    return render(revenue_report(intent.month, intent.segment))
```

**Parameterised templates.** The SQL chapter's advice generalises: a dozen named operations with typed arguments beat one general-purpose interpreter, for cost, correctness, and auditability.

**A classifier plus a router.** For routing among N known paths, a small model with a tight enum schema is cheaper and more predictable than a planner with N tools. Measure it against keyword rules; the rules sometimes win.

**Workflow engines for long processes.** If the sequence is known and long-running, durable execution (queues, schedulers, saga frameworks) gives retries, visibility, and resume semantics that chapter 4 had to build by hand.

**Retrieval instead of action.** If the task is "find the relevant document", a search index plus one summarisation call is smaller, faster, and safer than a browse-and-decide loop.

## The hybrid that usually wins

The most robust production pattern is **the model proposes, the code disposes**. The model returns a *plan* — a structured object naming an allowed operation and its arguments — and your executor validates it, authorises it, and runs it. No free-form tool selection, no unknown sequence, no model in the execution loop.

```
model → {"action": "refund", "order_id": "ord_8812a1f0", "amount_minor": 4599, "reason": "damaged"}
code  → validate schema → authorise tenant → check policy ceiling → require approval → execute
```

You keep the language understanding and lose the unbounded loop. This is also the easiest shape to evaluate: the output is data, so a test is an equality assertion.

Reserve the full loop for cases where the *sequence* genuinely depends on intermediate findings: an investigation across several systems, a coding task where the next file to read depends on the last, a search that must page until it finds the record. Those are real, and they are a minority of enterprise "agent" projects.

## The costs you are accepting

Be explicit about the bill, because it is not only tokens:

| Cost | What it looks like |
|---|---|
| Latency | 2–10× a single call; p95 is what users experience |
| Variance | Same input, different trajectory; hard to reproduce bugs |
| Security | Every tool is an attack surface reachable through conversation |
| Evaluation | Scenario sets, judges, nightly runs, human review |
| Debugging | Failures live in transcripts, not stack traces |
| Cost | Transcript resend, tool definitions per turn, retries |
| Org | Someone must own prompts, tools, and evals as a product |

An agent that saves a team two hours a week but costs a day of maintenance a month is not a win, and that arithmetic is rarely done.

## When the loop is genuinely right

- **Open-ended input** where the space of requests is not enumerable (support, research, coding).
- **Heterogeneous sources** where the path depends on what the first lookup reveals.
- **Long-tail operations** where building a UI for every branch is uneconomic, and the common cases are already covered by code.
- **Exploratory analysis** where the next question depends on the last answer.
- **Developer tooling**, in a sandbox, where the user is technical and can see and correct each step.

Notice the common thread: the *value* comes from adapting the sequence, not from calling the API. If the sequence is fixed, the model is doing expensive routing.

## Migration: from agent to code

The path back is straightforward if you logged trajectories (chapter 8):

1. Cluster trajectories by their tool sequence.
2. Take the largest cluster and write it as a deterministic function with the same validation and authorisation.
3. Route to it with a classifier or an explicit user choice.
4. Keep the agent for the residual, and keep its step budget small.
5. Compare cost, latency, and success rate before and after. Publish the numbers.

Most mature systems converge on this: code for the head of the distribution, an agent for the tail, and a shared validation and authorisation layer underneath both. That layer — chapters 2, 3, and 5 — is the part that was worth learning; the loop was the easy part.

## Common mistakes

- Choosing an agent because it demos well, then discovering the maintenance cost.
- No non-agent baseline, so you cannot show the agent is better.
- Adding tools to fix a routing problem that a merged tool or a better description would solve.
- Treating "the model can figure it out" as a substitute for a specification.
- Agentifying a workflow that regulators, auditors, or finance need to be deterministic.
- Building the loop before owning the tools' validation, error contracts, and permissions.
- Assuming the agent will get cheaper or more reliable "as models improve" without changing the architecture.

## Production notes

Decide the architecture per capability, not per product. A support system can have deterministic billing actions, a retrieval path for policy questions, and an agent for the genuinely open-ended troubleshooting conversation — sharing tools, validation, and audit.

Re-evaluate quarterly with the data you already log: trajectory distribution, cost per resolved request, success rate by route. Architectures drift because nobody re-asks the question. The honest default, when a request shape repeats, is to write it down as code and let the model handle what remains.
