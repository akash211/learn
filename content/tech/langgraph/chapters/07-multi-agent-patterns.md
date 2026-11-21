# Multi-Agent Patterns and Their Costs

“Multi-agent” can mean several different architectures. In LangGraph, a multi-agent workflow is a graph in which distinct nodes or subgraphs have bounded responsibilities and communicate through explicit state or messages. A separate model call does not automatically make a system more capable. Each additional agent introduces another prompt, another opportunity for disagreement, more tokens and latency, and another boundary where context can be lost or misinterpreted. Begin with a single-agent or deterministic workflow; add delegation only when a measurable task decomposition benefits from it.

A good agent boundary resembles a software interface: a clear purpose, constrained inputs, structured outputs, and a defined failure path. The planner might produce a list of research questions; search workers produce evidence with source identifiers; a synthesis step composes a response. If a worker's output is just unconstrained prose, downstream steps may not know what it means or whether it is complete. Define schemas and provenance early.

## Supervisor and specialists

A **supervisor** receives the task, chooses a specialist, examines its result, and decides whether to delegate again or finish. In a graph, the supervisor can be a node that updates a route or a conditional edge that routes to specialist subgraphs. This pattern centralizes coordination and is useful when there is a meaningful choice of specialist or when results need to be reconciled.

The supervisor also becomes a bottleneck and a source of error. It must know when to delegate and how to judge outputs; a model can repeatedly choose the same worker or fail to notice missing evidence. Bound the number of delegations, validate task assignments, and maintain a shared budget. Keep a stable task ID so results can be correlated. A supervisor should not grant a specialist more permissions than the request has.

## Handoff and routing

A **handoff** passes control from one specialist to another, sometimes with a focused context window. It can reduce irrelevant prompt context and make domain-specific tools easier to govern. Unlike a supervisor that returns after each unit of work, a handoff may transfer the conversation or responsibility and then let the receiving agent continue. In LangGraph, this can be encoded as routing between nodes, a `Command` returned by a node, or transitions between subgraphs, depending on whether state needs to be transformed.

Handoffs need explicit ownership. Record which agent currently owns the task, what context has been passed, and whether the prior specialist is expected to resume. Avoid losing constraints during context transfer: pass the original objective, relevant findings, policy constraints, and a compact summary, not merely the previous agent's last sentence. An agent handoff is not authorization to access another tool namespace.

## Subgraphs as reusable components

A compiled graph can be used as a node in a parent graph. If parent and child share state keys, the compiled subgraph can often be added directly as a node. If their schemas differ, call the subgraph inside a wrapper node and explicitly map parent input to child input and child output back to parent state. This isolates agent-specific message histories, supports reuse, and lets different teams evolve a component behind a stable interface.

Subgraphs have costs. They add a second state boundary and can make execution traces more nested. Parent and child checkpointer namespaces and state visibility need deliberate configuration. If the child has its own memory, decide what survives between parent runs. Avoid copying entire parent state into a child prompt or checkpoint; pass the smallest useful contract. If a subgraph updates a shared parent key, its reducer semantics must be clear.

## Complete worked pattern: supervisor with specialist subgraphs

The following complete graph uses two specialist nodes and a supervisor router. The specialists are deterministic stubs; replace their internal functions with real specialist graphs or model calls after defining reliable inputs and outputs. This example routes by a constrained topic and ends after one specialist rather than claiming autonomous negotiation.

```python
from typing import Literal
from typing_extensions import TypedDict
from langgraph.graph import END, START, StateGraph

class TeamState(TypedDict):
    task: str
    specialist: str
    result: str

def supervisor(state: TeamState) -> dict:
    task = state["task"].lower()
    specialist = "research" if "source" in task or "evidence" in task else "writer"
    return {"specialist": specialist}

def route(state: TeamState) -> Literal["research", "writer"]:
    return state["specialist"] if state["specialist"] in {"research", "writer"} else "writer"

def research(state: TeamState) -> dict:
    return {"result": f"Research specialist received: {state['task']}"}

def writer(state: TeamState) -> dict:
    return {"result": f"Writing specialist received: {state['task']}"}

builder = StateGraph(TeamState)
builder.add_node("supervisor", supervisor)
builder.add_node("research", research)
builder.add_node("writer", writer)
builder.add_edge(START, "supervisor")
builder.add_conditional_edges(
    "supervisor", route,
    {"research": "research", "writer": "writer"},
)
builder.add_edge("research", END)
builder.add_edge("writer", END)
team = builder.compile()

result = team.invoke({"task": "Find evidence for this claim", "specialist": "", "result": ""})
assert result["specialist"] == "research"
assert result["result"].startswith("Research specialist")
```

To make a specialist a subgraph, create a `StateGraph` with a narrower state contract, compile it, and register the compiled graph as the parent's node. A wrapper can map `task` into a child field and return only a validated `result` and provenance. This boundary is more explicit than passing an unstructured conversation transcript among agents. Add a supervisor loop only if the product needs iterative delegation, and then add an iteration cap and explicit finish criteria.

## When multiple agents help—and when they don't

Parallel specialists are useful when work can be decomposed independently, such as checking separate source collections or running distinct validators. Their results can be merged and synthesized. But parallelism can increase model calls, token usage, rate-limit pressure, and coordination complexity. It may also produce correlated errors if all agents share the same model, prompt assumptions, and incomplete evidence. It is not a substitute for independent verification.

Sequential specialist handoffs may add latency but provide focused reasoning. A single well-prompted agent with tools may be cheaper and easier to debug for simple tasks. Deterministic code may be better for routing, arithmetic, access control, and schema validation. Measure success on representative tasks and compare against the simpler baseline before adding agents.

## Common mistakes

- **Creating agents because the architecture sounds advanced.** Start with task decomposition and a single-agent baseline.
- **Passing entire state between specialists.** Share only necessary context and preserve provenance.
- **No delegation limit.** Give the supervisor a maximum number of hops and explicit stop conditions.
- **Unstructured handoffs.** Define input and output schemas, error states, and ownership.
- **Ignoring permission boundaries.** Each specialist must use only tools and data authorized for the request.

## Production notes

Trace every handoff with a task ID, agent role, route reason, input/output schema version, and terminal result. Keep raw prompts and private evidence under appropriate redaction and retention controls. Monitor the total number of model calls per request and evaluate answer quality, latency, and operational failures against a simpler workflow. The useful question is not “how many agents?” but “what necessary responsibility is isolated, and what evidence shows the boundary improves outcomes?”
