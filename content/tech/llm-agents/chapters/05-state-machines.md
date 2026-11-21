# State Machines Versus Free-Form Loops

Once an agent needs to survive a restart, pass a compliance review, or be tested by someone who did not write the prompt, the question "who decides the next step" gets a second answer: sometimes it should be the graph. This chapter is about that boundary — what an explicit state machine buys, what it costs, and how to run a free-form loop inside one without losing the benefits.

## The free-form loop, and where it breaks

The loop from chapter 1 has no structure beyond "call model, run tools, repeat". It is the fastest thing to build and the right choice for exploration: an unknown repository, a messy dataset, a task you have not seen enough of to draw a diagram.

It breaks in five specific ways as stakes rise:

1. **No invariants.** Nothing guarantees the customer was authenticated before the refund tool ran, or that the plan was approved before execution. The prompt says these things; prompts are advice.
2. **No resumption.** If the process dies at step nine, the state is prose in a dead process. Restart is from zero, or from an unverified transcript replay.
3. **No bounded transitions.** "Call up to forty tools" is a budget, not a control-flow guarantee. Some paths should be illegal, not merely expensive.
4. **No test surface.** You can test the prompt end-to-end or not at all. There is no unit under test that is not "the model".
5. **No audit shape.** A reviewer asking "could this have issued a refund without approval?" gets a transcript and an opinion.

## What an explicit graph buys

A state machine makes the nodes, the edges, and the state schema explicit data. In LangGraph the pieces are `StateGraph`, nodes as callables, conditional edges as routing functions, and a checkpointer keyed by thread id; other frameworks use different names for the same three ideas, and the ideas transfer.

```python
graph = StateGraph(AgentState)          # typed state schema
graph.add_node("triage", triage)        # model call, returns a typed decision
graph.add_node("research", research)    # budgeted agentic sub-loop
graph.add_node("refund", refund)        # side-effecting, guarded
graph.add_node("approve", request_approval)   # interrupts the run

graph.add_edge(START, "triage")
graph.add_conditional_edges("triage", route_triage, {
    "research": "research",
    "refund": "refund",
    "answer": END,
})
graph.add_edge("refund", "approve")
graph.add_edge("approve", END)
app = graph.compile(checkpointer=checkpointer)
```

Concretely, you gain: **type-checked state** (a node cannot read a field nobody wrote), **deterministic routing** where you want it, **checkpointing after every node** (resume is a read, not a replay), **interrupts at named points** (chapter 6), and **per-node tool scoping** (chapter 4). You also gain a diagram that a reviewer can read, which is often the actual deliverable.

The cost is real: more code, an extra abstraction to debug, and a tendency to encode product logic as topology until the graph has sixty nodes and nobody can explain it.

## Routing on validated signals

The boundary between "model decides" and "code decides" should be a *validated value*, not free text. Have the triage node return structured output against a schema — a `Literal` of dispositions plus a confidence and a rationale — then route on that field. Two rules:

- Route on enums, never on prose. `if "refund" in text` is a bug waiting for the word "no refund".
- Put the fallback in code. Unknown disposition, failed validation, or low confidence goes to a `needs_human` node, not to the most common branch.

This is where most "the graph didn't help" experiences come from: routing was implemented by parsing the model's sentence, so the graph inherited the model's fuzziness and added indirection.

## The agentic node

The productive pattern is a graph whose skeleton is deterministic and whose nodes may be agentic. A `research` node can run a ReAct loop with its own step budget and tool set, then return a typed result — findings, sources, confidence, and a flag if it ran out of budget. The outer graph never sees the loop's mess; it sees a value.

```python
def research(state: AgentState) -> dict:
    result = react_loop(
        goal=state["open_question"],
        tools=[search_docs, read_doc, fetch_policy],
        max_steps=8,
        max_tokens=60_000,
    )
    return {"findings": result.findings, "status": result.status}   # "ok" | "budget"
```

Keep the contract narrow: the node returns data, not instructions to other nodes. A node that appends "now call refund" to the state is a hidden edge, and hidden edges are how state machines become free-form loops with extra files.

## Checkpoints, replay, and duplicate effects

A checkpointer persists state between nodes, keyed by a run/thread id. Resume reads the last checkpoint and continues. That is the feature that makes long tasks viable — and the feature that produces duplicated side effects, because replaying from a checkpoint can re-execute the node that already sent the email.

Rules: checkpoint *after* a side effect is confirmed, not before; make side-effecting nodes idempotent (chapter 4); store the external effect's id in state so a re-run can detect "already done". Also decide your checkpoint granularity — per node is the default and usually right; per token is a database write per token.

State schema drift is the quiet failure. A field renamed between deploys makes old checkpoints unusable, and a resumed run may crash or, worse, proceed with a default. Version the schema, keep a migration or refuse to resume old versions explicitly.

## Cycles and budgets

Graphs allow cycles, and cycles are how you express retry, refinement, and investigation. Every cycle needs a decrementing counter in state and an exit edge, or the graph is a loop with a prettier diagram. Put the counter in the state schema so it is checkpointed — a budget in a local variable is lost on resume, which is exactly when a runaway loop needs to be stopped.

## When free-form is right

Do not over-graph. Use a free-form loop when the task is investigative with no compliance surface (research, code exploration, data spelunking), when you are still discovering the shape and a diagram would be fiction, and when the whole run is short enough that resumption is irrelevant. Use a graph when any of these are true: money or customer-visible side effects, regulatory or audit requirements, multi-minute runs, more than one team owning steps, or a need for per-step approval.

The tell that you should have used a graph: you are writing prompt instructions that begin "always", "never", or "before doing X, first". Those are edges.

## Common mistakes

- Encoding every LLM decision as a node, producing a graph that is really a flowchart of prompts with no deterministic logic.
- Parsing free text to route, then blaming the graph for non-determinism.
- Side-effecting nodes without idempotency, then discovering replay duplicates on the first incident.
- Cycles with no checkpointed counter.
- Hiding state in message history while claiming the graph is the source of truth.
- Letting each node call the model with a different ad-hoc prompt format, so nothing can be evaluated consistently.

## Production notes

Emit a trace span per node with the state delta, so "what changed here" is answerable without diffing JSON by eye. Keep node outputs small and typed; large blobs belong in object storage with a handle in state. Version the graph and the state schema together, and record both ids in every run record, so a resumed run is never executed by a newer topology than the one that started it. Finally, draw the graph in CI — if the rendered topology has an edge you cannot explain, you have found a bug before a customer did.
