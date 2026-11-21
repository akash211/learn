# The Graph Mental Model: Nodes, Edges, and State

LangGraph models an application as a stateful computation whose control flow is explicit. Three pieces are enough to reason about a graph: **state** is the information currently available, **nodes** read that state and perform work, and **edges** determine the next node or nodes. Build these pieces with `StateGraph`, then call `compile()` before `invoke()` or `stream()`. The compiled object is a runnable graph, not merely a drawing.

A useful mental picture is a small workflow engine. A node is a named step, not necessarily an LLM call. It may validate input, call a model, query a database, run a tool, or invoke a compiled subgraph. Edges connect these steps. A fixed edge always schedules its target; a conditional edge chooses based on state or other available context. State is carried between steps as named channels. Nodes normally return partial updates, and each channel has its own update rule.

## How it differs from a chain

A chain usually communicates a sequence: A feeds B, B feeds C. That is clear and compact when every run follows the same path. A graph still supports sequences, but it also makes branches and cycles explicit. It can represent “classify, then retrieve or answer directly,” “ask a tool, inspect the result, then decide whether another tool is needed,” or “draft, ask for approval, and resume.” The control-flow edges are visible rather than encoded in one large function.

| Concern | Fixed chain | StateGraph |
|---|---|---|
| Main shape | Ordered composition | Sequence, branch, fan-out, or cycle |
| Shared data | Often passed as values between calls | Named shared state channels |
| Routing | Often hidden in application code | Explicit edges or `Command` routing |
| Pause and resume | Requires custom persistence glue | Checkpointer plus thread and interrupt APIs |
| Best fit | Small, linear transformations | Stateful workflows with explicit control flow |

This is not a claim that graphs are always superior. A three-step deterministic pipeline may be clearer as ordinary functions or a chain. A graph becomes worthwhile when control flow, shared state, resumability, or step-level observability is a real requirement. Avoid using nodes as a way to make every line of code look architectural.

## State, nodes, and execution steps

State is usually declared with `TypedDict`, though dataclasses and Pydantic models can also be used for graph state in suitable cases. A node receives the current state and returns a mapping containing only fields it updates. For a key without a reducer, that update replaces the prior value; untouched keys remain unchanged. This partial-update rule means a node does not have to reconstruct the entire state object.

Execution proceeds in super-steps. Nodes scheduled together can run in the same step, and their updates are merged by the reducers configured for each channel. A later edge can schedule another step. The runtime finishes when no nodes remain to execute and no messages are in flight, or raises if an error or recursion limit interrupts the run. Thinking in steps helps reason about parallel work and checkpoint boundaries: a transition is not necessarily equivalent to a single Python function call.

Graph construction is a separate phase from graph execution. Register nodes and edges, provide a path from `START`, and compile. Compilation checks graph structure and allows runtime facilities such as a checkpointer to be attached. The graph can then be invoked with an initial state mapping. It is good practice to keep builder construction near application setup, while keeping node functions small and testable.

## Complete worked example: support-request triage

The following graph classifies a request using deterministic Python logic, routes urgent requests to escalation, and sends ordinary requests to a drafting node. It is complete and does not require an LLM provider. The small classifier is a stand-in for a model-backed classifier; the graph contract remains the same if that node later calls a model.

```python
from typing import Literal
from typing_extensions import TypedDict
from langgraph.graph import END, START, StateGraph

class SupportState(TypedDict):
    request: str
    priority: str
    response: str

def classify(state: SupportState) -> dict:
    text = state["request"].lower()
    priority = "urgent" if "outage" in text or "locked out" in text else "normal"
    return {"priority": priority}

def draft_reply(state: SupportState) -> dict:
    return {"response": f"We received your request: {state['request']}"}

def escalate(state: SupportState) -> dict:
    return {"response": "A support specialist will review this urgently."}

def route(state: SupportState) -> Literal["escalate", "draft"]:
    return "escalate" if state["priority"] == "urgent" else "draft"

builder = StateGraph(SupportState)
builder.add_node("classify", classify)
builder.add_node("draft", draft_reply)
builder.add_node("escalate", escalate)
builder.add_edge(START, "classify")
builder.add_conditional_edges(
    "classify",
    route,
    {"escalate": "escalate", "draft": "draft"},
)
builder.add_edge("draft", END)
builder.add_edge("escalate", END)
graph = builder.compile()

result = graph.invoke({"request": "Our service is in an outage", "priority": "", "response": ""})
assert result["priority"] == "urgent"
assert "urgently" in result["response"]
```

Read the example in graph terms. `SupportState` describes the data contract, while each function updates only what it owns. `START` schedules classification. The conditional edge evaluates after the classifier has updated the priority and selects one branch. Both branches terminate at `END`, so there is no accidental fall-through. The mapping makes the router's return values explicit; the `Literal` annotation also documents the allowed destinations for readers and tooling.

The string check is intentionally simplistic. Real systems should make routing decisions from validated outputs, and should not allow an untrusted model to invent arbitrary graph node names. If a model supplies an intent, parse it into a constrained enum, validate it, and route by that enum. Keep authorization and hard safety checks in deterministic code rather than delegating them to a language model.

## Graph boundaries and responsibilities

A well-shaped graph separates decisions from effects. A routing function should generally be quick and deterministic; it chooses the next step without performing a costly external action. A node that sends an email or charges a card should have a clear contract, idempotency strategy, and possibly a human approval step. That separation makes it possible to test decisions independently from external systems.

The graph is also not a replacement for application boundaries. Authentication, request validation, tenant isolation, secrets management, and HTTP response handling usually belong in the surrounding service. Put durable workflow information in state; pass configuration or dependencies through runtime context rather than serializing database handles or credentials into state. The graph should know enough to make progress, not become an unbounded dumping ground for every request object.

## Common mistakes

- **Treating LangGraph as a prompt framework.** Its value is orchestration, state updates, and execution semantics; a node may contain no prompt at all.
- **Returning a full mutated state without knowing merge rules.** Prefer explicit partial updates and configure reducers where values should combine.
- **Using a graph for every linear sequence.** The additional structure has a cost; use it where branching, persistence, or visibility matters.
- **Letting model text dictate arbitrary routing.** Constrain and validate routing labels before mapping them to known nodes.
- **Confusing a graph diagram with proof of safety.** A visible edge does not guarantee its target is authorized or its action is idempotent.

## Production notes

A graph's state schema and node names become operational interfaces once checkpoints are persisted. Give keys meaningful names, document reducers, and version code alongside saved state. Build and compile the graph once per process configuration when appropriate, rather than reconstructing it for every request without reason. Test not just the happy path but every route, terminal condition, and unexpected classifier value. In later chapters, checkpointing and interrupts add durable thread semantics; the same simple graph vocabulary continues to apply.
