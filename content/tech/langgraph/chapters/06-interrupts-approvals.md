# Human-in-the-Loop Interrupts and Approvals

Human-in-the-loop (HITL) is a workflow requirement, not a pause button added at the end. A reviewer must see a meaningful request, possess authority to decide, respond through a trusted channel, and leave an auditable decision. LangGraph's `interrupt()` lets a node pause execution and expose a JSON-serializable payload to the caller. A checkpointer stores the graph state; later, the application invokes the graph with `Command(resume=value)` and the same `thread_id`. The resume value becomes the return value from the suspended `interrupt()` call.

This creates an explicit approval boundary. A node can prepare an action, pause with a structured description, and only proceed to an effect node if the returned decision validates. The graph makes the path visible, but it does not authenticate the reviewer or enforce a business policy automatically. The surrounding service must bind the request to a case and reviewer, authorize access, validate the response, and ensure the approval is still current when applied.

## Design the interrupt contract

An interrupt payload should be complete enough for the human to make the decision. Include a stable action identifier, a plain-language explanation, relevant inputs and consequences, and allowed choices. Do not simply ask “Approve?” when the reviewer cannot tell what will happen. If the payload exposes sensitive information, apply the same authorization and redaction controls as any API response. Keep payloads JSON serializable; do not include database handles, model objects, or executable code.

On resume, validate the response shape and semantics. `bool(resume_value)` is often too permissive: strings such as `"no"` are truthy in Python. Prefer a strict schema or explicit comparison, and record reviewer identity and timestamp in an authoritative audit log. The approval itself should not be trusted merely because it arrived through a graph invocation; the API layer has to verify the actor.

Interrupt ordering matters. On resume, the node containing `interrupt()` starts executing again from its beginning. Code before the interrupt can therefore run again. Keep pre-interrupt work read-only and repeatable. Put the interrupt before external side effects, and use idempotency keys if an action might be retried after approval. If an action is based on mutable data, re-check its preconditions at execution time; approval of yesterday's price or account state may not authorize today's changed action.

## Resume as a deliberate operation

A common pattern is: invoke the graph, detect the pending interrupt, display its payload to the authorized reviewer, then invoke again using `Command(resume=decision)` and the original thread configuration. The graph cannot resume without the relevant checkpointer state and thread. Store a reference to the thread and its status in the application's own case management layer so users do not guess IDs or resume the wrong workflow.

An interrupt can remain paused for a long time. Define expiry, cancellation, escalation, and duplicate-submission behavior. If an approval is rejected, route to a safe terminal state or request revisions; do not let the graph continue to the effect node with a falsey-looking but invalid response. If a reviewer submits twice, the application should return a stable outcome rather than apply the action twice.

## Approval pattern with routing

For complex approval responses, make the interrupt a separate node and route based on its validated result. This avoids mixing the human boundary with the effect. The following structure is conceptual code; the state transition itself is ordinary graph logic:

```python
from typing import Literal
from typing_extensions import TypedDict
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

class ActionState(TypedDict):
    action: str
    decision: str
    status: str

def approval(state: ActionState) -> dict:
    answer = interrupt({"action": state["action"], "choices": ["approve", "reject"]})
    if answer not in ("approve", "reject"):
        return {"decision": "invalid", "status": "needs_review"}
    return {"decision": answer}

def apply(state: ActionState) -> dict:
    # The real action must re-check authorization and use an idempotency key.
    return {"status": "applied"}

def reject(state: ActionState) -> dict:
    return {"status": "rejected"}

def route(state: ActionState) -> Literal["apply", "reject"]:
    return "apply" if state["decision"] == "approve" else "reject"

builder = StateGraph(ActionState)
builder.add_node("approval", approval)
builder.add_node("apply", apply)
builder.add_node("reject", reject)
builder.add_edge(START, "approval")
builder.add_conditional_edges("approval", route, {"apply": "apply", "reject": "reject"})
builder.add_edge("apply", END)
builder.add_edge("reject", END)
# Compile with a checkpointer in order to use interrupt and resume.
```

The snippet emphasizes the graph route but intentionally does not claim that the node itself establishes reviewer identity. The caller should supply a response only after verifying the person. A more complex system can use a typed response schema where supported by the deployed LangGraph version, but server-side validation should remain explicit, and the API should reject mismatched or stale decisions.

## Approval is not authorization

Approval and authorization answer different questions. Approval is a business decision about a particular proposed action. Authorization determines whether a particular actor is allowed to approve that action. A malicious or compromised client may call a resume endpoint directly; never expose a raw `thread_id` as sufficient access. Tie it to a principal and check tenant, role, case status, and action scope on every read and resume.

For high-impact operations, use a policy engine or deterministic rules to constrain what can be approved. The graph should show the boundary but not be the sole control. For example, a human may approve a refund, but a deterministic service still enforces the maximum refund amount and verifies the underlying order. A model can prepare the proposal; it should not be able to broaden the authorized amount by changing state.

## Observability, privacy, and audit

Record the interrupt event, payload reference, reviewer identity, response, and subsequent effect result. The durable audit record may live outside the graph state to satisfy retention or compliance requirements. Keep trace payloads minimal: traces are valuable for debugging but can contain personal data or confidential documents. Define redaction and access policy before enabling broad trace collection.

If there is no response before expiry, do not treat silence as consent. Route to a timeout or escalation path, or leave the workflow in a clearly marked waiting state. If a proposal is edited after approval, require a new approval or compare a content hash that binds the approval to the exact proposal. This prevents a time-of-check/time-of-use gap where a reviewer approves one payload but a different one is applied.

## Common mistakes

- **Calling `interrupt()` without a checkpointer and thread ID.** The pause cannot be durably resumed as intended.
- **Using truthiness for approval.** Validate an explicit enum or typed decision.
- **Performing a side effect before pausing.** The node may restart from its beginning when resumed.
- **Trusting the thread ID as access control.** Authorize each reviewer and each resume request.
- **Treating timeout or missing response as approval.** Fail closed or escalate.

## Production notes

Exercise the full lifecycle: pause, inspect payload, resume with approval, resume with rejection, send an invalid response, duplicate a resume request, restart the worker, and expire a pending task. Verify the external action happens at most once through its own idempotency mechanism. Include a correlation ID for the business case and preserve an audit record independent of model traces. A robust HITL workflow makes waiting, rejection, expiry, and retry ordinary states rather than exceptional surprises.
