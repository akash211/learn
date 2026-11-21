# Cycles, Retries, and Bounded Loops

Graphs can contain cycles. A cycle is a path that intentionally returns to an earlier node, such as `model → tool → model` or `draft → critique → revise`. The graph runtime does not infer when a loop is useful; the state and routing policy must provide a stop condition. This is one reason to model an agent as a workflow rather than as an unconstrained “think until done” instruction. Every cycle needs a measurable progress signal, a maximum budget, and a behavior when that budget is exhausted.

A common pattern is to keep an integer such as `attempts` or `revision_count` in state. A critique node updates the quality or validation result; a router either terminates, loops to revision, or stops with an explicit failure result. The condition should be based on validated state, not on a model repeatedly claiming that its answer is now perfect. A maximum number of iterations is a guardrail, not evidence of convergence.

## Three different kinds of repetition

It helps to distinguish a **workflow loop**, a **node retry**, and a **new application invocation**. A workflow loop is part of the graph topology: successful node execution returns to another node by an edge. A retry policy is attached to a node and handles certain exceptions by attempting that node again. A new invocation is initiated by application code, perhaps after an error or user input. These mechanisms solve different problems and should not be conflated.

A retry is appropriate for transient failures—temporary network reset, rate limiting under a controlled backoff policy, or a short-lived upstream error—when repeating the operation is safe. A loop is appropriate when a successful step produces a new result that determines the next workflow action, such as a tool result being fed back to a model. A retry policy cannot fix a logical loop, and a loop should not be used to repeatedly hammer an unavailable service.

LangGraph provides node retry configuration through `RetryPolicy`. The policy can specify retry count and timing behavior; select it according to the actual dependency's error semantics and avoid retrying permanent validation failures. Retried operations can still have side effects. If an external request may succeed while its response is lost, a retry can duplicate the effect unless the external operation is idempotent or protected by a stable idempotency key.

## Why unbounded agent loops fail

An unbounded loop can keep generating model calls, tool requests, and state updates without making useful progress. It can increase latency and cost, repeatedly mutate external systems, fill checkpoint storage, or continue in a bad state long after a useful answer is available. A model's confidence statement is not a reliable stopping test. Even with a recursion limit, allowing the runtime default to be the sole product-level budget gives poor user experience: the graph may stop with an exception rather than return a deliberate partial result.

Bound multiple resources independently where appropriate. A maximum loop count bounds reasoning rounds; a tool-call budget bounds external work; a wall-clock timeout bounds elapsed time; a token or monetary budget bounds model usage. None of these implies the others. An invocation config can set a recursion limit as a final runtime safeguard, but application logic should impose task-specific limits and handle exhaustion explicitly.

A good exhausted state tells the caller what happened. It might return a partial answer marked incomplete, ask a person to continue, or fail with a recoverable status. It should not silently claim success. Record the limit and the reason, not just a generic “done” flag.

## Complete worked graph: bounded draft and review loop

This full example runs a deterministic draft-review-revise cycle. The reviewer accepts a draft containing the word `complete`; otherwise the revise node adds that marker. The simple rule stands in for a structured evaluator and makes the loop behavior testable without a model key. The `max_revisions` field is part of input state so callers can choose a task-appropriate bound.

```python
from typing import Literal
from typing_extensions import TypedDict
from langgraph.graph import END, START, StateGraph

class ReviewState(TypedDict):
    request: str
    draft: str
    feedback: str
    revisions: int
    max_revisions: int
    status: str

def draft(state: ReviewState) -> dict:
    return {"draft": f"Draft response for: {state['request']}"}

def review(state: ReviewState) -> dict:
    if "complete" in state["draft"].lower():
        return {"feedback": "accepted", "status": "accepted"}
    return {"feedback": "Include the completion marker.", "status": "needs_revision"}

def revise(state: ReviewState) -> dict:
    return {
        "draft": state["draft"] + " Complete.",
        "revisions": state["revisions"] + 1,
    }

def route(state: ReviewState) -> Literal["revise", "finish", "exhausted"]:
    if state["status"] == "accepted":
        return "finish"
    if state["revisions"] < state["max_revisions"]:
        return "revise"
    return "exhausted"

def mark_exhausted(state: ReviewState) -> dict:
    return {"status": "incomplete: revision budget exhausted"}

builder = StateGraph(ReviewState)
for name, fn in [("draft", draft), ("review", review), ("revise", revise), ("exhausted", mark_exhausted)]:
    builder.add_node(name, fn)
builder.add_edge(START, "draft")
builder.add_edge("draft", "review")
builder.add_conditional_edges(
    "review", route,
    {"revise": "revise", "finish": END, "exhausted": "exhausted"},
)
builder.add_edge("revise", "review")
builder.add_edge("exhausted", END)
graph = builder.compile()

result = graph.invoke({
    "request": "Explain the service", "draft": "", "feedback": "",
    "revisions": 0, "max_revisions": 2, "status": "started",
})
assert result["status"] == "accepted"
assert result["revisions"] == 1
```

This loop performs one revision and then terminates. If the evaluator never accepts, the graph reaches the exhausted node once the revision budget is consumed. A real review node should return structured findings and a validated pass/fail signal; the revision node should use that feedback rather than blindly append text. Keep the counter update in the node that actually spends a revision so the accounting has one clear owner.

Notice the edge from `revise` to `review`: it is a successful workflow transition, not a retry. If `review` itself errors while calling a model, a retry policy may be suitable for a transient failure. The code's small loop count and termination status are still needed independently.

## Idempotency and external side effects

Loops and retries can both repeat nodes. If a node writes a record, sends a message, or issues a payment, define idempotency at the system boundary. Generate a stable operation key before the side effect and store its outcome in a durable system. Retrying a node should not create a second charge just because the response timed out. Also consider whether a resumed graph will re-enter a node; do not assume that a checkpoint guarantees an external call has exactly-once semantics.

Pure transformations are easiest to retry because repeating them has no external consequence. Separate external effects from model reasoning when possible, and make effect nodes narrow, auditable, and protected by authorization checks. State may record the intended action, but an authoritative system should decide whether it has already been applied.

## Common mistakes

- **No explicit stopping criterion.** Define pass, failure, and budget-exhaustion routes.
- **Using a large recursion limit as the only loop bound.** It is an emergency cap, not product logic.
- **Retrying every exception.** Validation, permission, and malformed-input failures are normally permanent.
- **Assuming a timed-out side effect did not happen.** Use idempotency keys and reconciliation.
- **Treating repeated model calls as progress.** Track observable revisions or evidence changes, not merely iteration count.

## Production notes

Set a task-level iteration budget, wall-clock deadline, and any relevant model/tool budgets. Add a regression test for the accepted route, the final allowed revision, the zero-budget case, and evaluator failure. If you configure retries, test the dependency's exception classes and ensure retry delays fit the request deadline. Surface exhaustion in traces and application responses so it can be improved rather than disguised as a successful answer.
