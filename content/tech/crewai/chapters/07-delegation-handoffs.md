# Delegation, Handoffs and Failure Modes

CrewAI has no single "handoff" primitive. It has three mechanisms that people describe with the same word, and they behave very differently:

1. **Delegation tools** — an agent with `allow_delegation=True` gains tools to *delegate work to a coworker* and *ask a question to a coworker*. The coworker runs, returns text, and the delegating agent continues.
2. **Manager delegation** — the hierarchical process, where a manager assigns and reviews tasks.
3. **Task handoff** — sequential tasks passing output through `context`, or a Flow passing typed state between steps.

The first is a tool call inside an agent's loop. The second is a scheduler. The third is data flow you wrote. Only the third gives you an edge you can inspect, and that is why it is usually the right one.

## Delegation is a nested call, not a transfer

```python
researcher = Agent(
    role="Researcher",
    goal="Answer the assigned question from primary sources",
    backstory="You cite before you claim.",
    tools=[search_tool],
)

lead = Agent(
    role="Research lead",
    goal="Deliver a sourced answer, delegating collection to the researcher",
    backstory="You own the final answer and the evidence behind it.",
    allow_delegation=True,
)

triage = Task(
    description="Answer {question}. Delegate evidence collection; do not search yourself.",
    expected_output="An answer with 3-8 cited findings and an explicit 'unknown' list.",
    agent=lead,
)
```

When the lead delegates, CrewAI constructs a prompt for the researcher from the lead's description of the sub-task, runs the researcher's own loop — including its tools and its `max_iter` — and returns the researcher's final text to the lead. Control never leaves the lead. The lead then decides whether to accept it, ask a follow-up, delegate again, or write the answer.

That structure explains almost every delegation pathology: the delegator remains responsible while stacking a second agent loop inside its own, and there is no explicit edge to inspect — only a transcript.

## What delegation is actually good for

Used narrowly, it buys three things:

**Model routing.** A cheap coordinator can call an expensive specialist for the one step that needs it, rather than paying the expensive model for the whole task.

**Local expertise at the point of need.** A single agent can consult a policy agent or a calculator agent without you restructuring the task graph.

**Verification.** An agent can ask a reviewer coworker "does this claim follow from this source?" and get a second pass on its own output.

All three are cases where the *selection* of help is genuinely unpredictable at authoring time. If you already know that step three needs the writer, write task three.

## The failure modes

**Ping-pong.** A delegates to B; B, unsure, asks A a question; A delegates the clarification back. Each hop is a full model call, and the loop is bounded only by each agent's `max_iter` — which is per-agent, not per-conversation. Depth two is common; depth four is a budget incident.

**Over-delegation.** An agent with delegation enabled will sometimes delegate its own job: the lead asks the researcher to "answer the question", the researcher asks the lead to "decide the scope". Work moves sideways, nobody produces the artefact, and the final text reads like a status update. The instruction in the example above — "do not search yourself" — is a deliberate counterweight, and it only works because the role is narrow.

**Abdication.** The delegator's final answer becomes a description of what it asked for: "I have requested the data from the researcher." The task completes, `expected_output` is not met, and no guardrail fires because the text is fluent. Delegation makes "did the agent actually do the job" a separate question from "did the task finish".

**Provenance loss.** After three delegations, the final answer's claims have no traceable source. You log the crew result and cannot reconstruct which agent produced which sentence. This is the failure that kills auditability.

**Context dilution.** The delegator knows the user's phrasing, the prior task's caveats and the reason for the request. When it writes a two-sentence delegation prompt, most of that is gone. The coworker answers a *slightly different* question, confidently.

**Privilege escalation through the model.** If the delegate holds a tool the delegator does not, the delegator can ask it to use that tool. A "research assistant" that can ask a "billing agent" to issue a refund is an authorization path nobody reviewed. Delegation must not cross a permission boundary — the tool set of the most privileged agent in the reachable graph is effectively the tool set of all of them.

**Cost blowup.** Each delegation is a new prompt containing the delegator's persona plus the sub-task, followed by a fresh tool loop. A four-agent crew with delegation enabled everywhere can multiply call count by an order of magnitude compared with the same tasks written explicitly.

| Pattern | Control | Cost | Provenance | Best fit |
|---|---|---|---|---|
| Delegation tools | Low — model decides | High, unpredictable | Weak | Genuinely unpredictable need for expertise |
| Hierarchical manager | Medium — manager decides | Highest | Medium | Overlapping specialists, review gate |
| Sequential tasks + context | High — list order | Low, near-linear | Strong | Known pipeline |
| Flow with routers | Highest — code decides | Lowest per step | Strongest | Branching, retries, approvals |

## Designing handoffs that hold

If two agents must exchange work, prefer a **task boundary with a schema** over a tool call:

```python
class ResearchPacket(BaseModel):
    question: str
    findings: list[Finding]
    gaps: list[str]
    searched_at: str

collect = Task(
    description="Collect findings for {question}.",
    expected_output="A ResearchPacket JSON object.",
    agent=researcher,
    output_pydantic=ResearchPacket,
)

assess = Task(
    description="Assess whether the packet answers the question. Do not re-search.",
    expected_output="A verdict (answered / partial / unanswered) plus the specific gaps.",
    agent=assessor,
    context=[collect],
    output_pydantic=Verdict,
)
```

Three properties are now explicit: the payload shape, the recipient, and the condition for proceeding. A Flow can add the fourth — what happens on `unanswered` — with a router that sends the packet back for a second collection pass with the gaps as input. That is a handoff with a contract, and it is testable without a model in the loop for the routing decision.

## Controls worth having

Enable `allow_delegation` on at most one or two agents, never globally. Give delegates narrower tool sets than their delegators, and no write tools at all unless the workflow requires them. Set `max_iter` low on both sides — a delegator at 20 that delegates four times can trigger eighty model calls before it stops. Put the delegation policy in the goal ("delegate evidence collection, do not search yourself"), and check the trace rather than the summary to see whether it was followed. Log delegation events with parent task, delegator, delegate, sub-task text and returned length; without that tree, cost attribution is guesswork.

## Common mistakes

- **Enabling delegation to "make the crew smarter".** It makes the crew more expensive and less accountable.
- **Reading the final answer as the crew's work.** In a delegating crew, the final text may be mostly a receipt for work done elsewhere.
- **Assuming the manager or delegator validates.** It reads text, not tool calls, and shares the delegate's blind spots.
- **Delegating across permissions.** The union of reachable tools is the real permission set.
- **No depth limit.** `max_iter` is per agent; nested delegation multiplies it.

## Production notes

Model the delegation graph explicitly in your documentation — who can call whom, with which tools — and review it like an IAM policy. Enforce a per-run token and call budget outside the framework, because internal limits do not compose across nested loops. Keep a delegation-free variant of the crew for evaluation, so you can tell whether delegation improved quality or merely moved it around. And when a delegated crew starts producing status reports instead of deliverables, the fix is almost never a stronger instruction to the delegator; it is replacing the delegation with a task that has an owner.
