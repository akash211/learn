# Checkpointing, Persistence, and Resuming

A checkpointer saves graph state as execution advances. When a graph is compiled with a checkpointer, each run is associated with a **thread**, identified by a `thread_id` passed in the `configurable` portion of the invocation config. This lets an application recover state across requests and supports interrupts, history inspection, and time-travel-style replay. A checkpoint records more than a chat transcript: it captures the graph's state at a point in execution, including enough runtime bookkeeping to continue the workflow.

```python
from langgraph.checkpoint.memory import InMemorySaver

checkpointer = InMemorySaver()  # useful for examples and tests, not durable across process restarts
graph = builder.compile(checkpointer=checkpointer)
config = {"configurable": {"thread_id": "case-1842"}}
result = graph.invoke(input_state, config)
```

The `thread_id` is a durable cursor, not an authentication token. Reusing it connects new work to the same thread's saved state; a new identifier starts a distinct history. It should be generated and scoped by the application, checked against the caller's authorization, and never treated as proof that a user may access the thread. Avoid embedding private data in IDs. Some database-backed checkpointers impose storage constraints on identifier length, so use stable bounded identifiers such as UUIDs.

## Checkpointer versus long-term store

A checkpointer stores graph snapshots for a particular thread. It is suited to short-term workflow memory, recovery, and human-in-the-loop continuation. A LangGraph store is a separate abstraction for application-defined data that should be shared across threads, such as a user preference or durable fact. A checkpoint is not automatically a good knowledge base, and a store is not a substitute for the exact execution position needed to resume a paused graph. An application may use both, with clear ownership and retention policies.

`InMemorySaver` is convenient in unit tests and local exploration, but its state disappears when its process exits. A production deployment should select a durable checkpointer appropriate to its database and operating model, initialize it as required by that implementation, secure it, back it up, monitor storage, and define retention. If using an agent server that manages persistence for you, follow its supported configuration rather than creating a second competing persistence layer.

## Starting new work, continuing, and resuming

Invocation behavior depends on both the input and the thread state. A plain input mapping is a new graph input applied to that thread and begins work from the graph entry point. `Command(resume=...)` supplies an answer to an outstanding `interrupt()` call; it is not the generic way to send a later user message. Reusing a completed thread with a resume command can return the saved result without doing new work. For a conversational graph, submit the new message in the graph's expected input schema. For a new independent workflow, use a new thread ID.

After a failure, the appropriate continuation depends on where and how the graph stopped. A checkpointer can recover saved progress, but application code must still decide whether a failed node is safe to run again. Successful parallel node writes may be retained as pending writes, reducing unnecessary repetition when resuming, but an external side effect can have completed even when the graph did not save its result. Design effect nodes with idempotency and reconciliation in mind.

## Time travel and branching

A checkpoint history can help explain how state evolved or reproduce a decision. `get_state(config)` inspects the current snapshot; `get_state_history(config)` exposes prior snapshots. A selected snapshot's configuration can be used to replay from that point, or a new execution can be forked from a prior state for controlled experimentation. This is useful for debugging a bad route, comparing prompt versions, or exploring what would happen if a reviewer supplied a different decision.

Time travel is not a magic rollback of the outside world. Replaying graph steps may invoke tools and external APIs again, so do not replay effectful nodes against live systems without a safe test environment, idempotency protections, or a deliberate replay mode. Treat history as sensitive operational data. If it contains customer messages or retrieved documents, the same access-control, deletion, and privacy rules apply as to the underlying records.

## Worked example: persistent approval thread

This complete example creates a graph that pauses before finalizing a low-impact action. It uses `InMemorySaver` so it can run locally, but the saved state will not survive process restart. The same graph structure can be compiled with a durable checkpointer in a production service.

```python
from typing_extensions import TypedDict
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

class ApprovalState(TypedDict):
    proposal: str
    approved: bool
    outcome: str

def request_approval(state: ApprovalState) -> dict:
    decision = interrupt({"proposal": state["proposal"], "question": "Approve this proposal?"})
    return {"approved": bool(decision)}

def apply_decision(state: ApprovalState) -> dict:
    outcome = "approved" if state["approved"] else "rejected"
    return {"outcome": outcome}

builder = StateGraph(ApprovalState)
builder.add_node("approval", request_approval)
builder.add_node("apply", apply_decision)
builder.add_edge(START, "approval")
builder.add_edge("approval", "apply")
builder.add_edge("apply", END)
graph = builder.compile(checkpointer=InMemorySaver())
config = {"configurable": {"thread_id": "proposal-001"}}

paused = graph.invoke(
    {"proposal": "Create a draft report", "approved": False, "outcome": "pending"},
    config,
)
assert paused["__interrupt__"]

finished = graph.invoke(Command(resume=True), config)
assert finished["approved"] is True
assert finished["outcome"] == "approved"
```

The first invocation returns an interrupt payload rather than reaching the normal final state. The caller should present that payload to an authorized reviewer and persist the relationship between reviewer, proposal, and thread. The second invocation uses the same `thread_id`, and `Command(resume=True)` becomes the return value of `interrupt()` inside the node. The downstream node applies the decision. A real application must validate who may answer, what response shape is accepted, and whether a stale proposal is still eligible for approval.

When resuming, LangGraph restarts the node containing the interrupt from its beginning. Any code before `interrupt()` may run again. Place the interrupt before side effects, and make pre-interrupt calculations cheap and repeatable. Never perform a payment or send a message before an approval interrupt and assume it will not be repeated.

## Common mistakes

- **Using the same thread ID for unrelated users or cases.** Thread IDs must be scoped and authorized by application logic.
- **Expecting in-memory state to survive a restart.** Use a durable checkpointer when recovery across process restarts is required.
- **Confusing a new message with interrupt resumption.** Use plain input for new work and `Command(resume=...)` for the paused interrupt.
- **Treating replay as rollback.** External actions are not undone by moving to an old checkpoint.
- **Allowing checkpoint history to grow indefinitely.** Set retention and state-size limits appropriate to the application.

## Production notes

For durable threads, test restart-and-resume against the actual selected checkpointer, not only an in-memory saver. Confirm connection pooling, migrations/setup, backup, retention, and authorization behavior. Monitor checkpoint volume and size. Keep schema changes compatible with the active threads that can resume; paused work may be waiting on a node name or state key that a new deployment changes. See the production chapter for rollout strategies and concurrency considerations.
