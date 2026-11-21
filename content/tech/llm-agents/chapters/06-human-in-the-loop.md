# Human-in-the-Loop and Approval Gates

Confidence is not authority. A model can be 97% sure that a refund is correct and still be the wrong party to authorise it — because the cost of the 3% is a chargeback, a compliance finding, or a customer who never agreed. Human-in-the-loop design is about placing the smallest possible human decision at the point where autonomy stops being cheap.

## What a gate is for

Three reasons to involve a person, each needing a different mechanism:

**Authority.** The action requires a role the agent does not have — approving a refund above a threshold, sending a legal notice, deleting an account. The human is not a better model; they are the accountable party.

**Ambiguity.** The request is under-specified and only the user knows what they meant. This is a *clarifying question*, not an approval, and it should be asked early rather than after a plan has been executed.

**Risk.** The action is irreversible or expensive and the agent's error rate on this class is non-trivial. Here the human is a control, and the control should be measured — an approval gate that is approved 99.8% of the time without edits is not a control, it is latency.

Which one you are doing determines the design. Authority gates need audit records and role checks. Ambiguity needs a fast, cheap round trip. Risk needs sampling, thresholds, and a periodic review of whether the gate still earns its cost.

## Where to put the gate

The rule: gate immediately before the effect, on the smallest unit that is still meaningful. Not before the plan ("approve this 7-step plan" gives the reviewer nothing to check), and not after the effect (that is an incident review). Before the specific tool call, with the exact arguments that will be sent.

Gate decisions, not prose. "Approve refund of $84.00 to order 4471, reason: duplicate charge" is reviewable in seconds. "Approve the agent's plan to help the customer" is not.

Also gate the *first* occurrence per class, not every occurrence. A workflow that asks for approval on each of forty line-item adjustments gets rubber-stamped by the second one; a workflow that asks once per batch, with a sample, gets read.

## Mechanics

The run must pause durably rather than block a thread. In practice: persist the pending action and its arguments, mark the run `awaiting_approval`, return control, and resume when a decision arrives. LangGraph expresses this as an interrupt before a node plus a checkpointer; queues with a callback work equally well. What matters is that the pause survives a deploy, and that resumption starts from the stored state rather than re-deriving the request.

```python
def refund_node(state: AgentState) -> dict:
    action = build_refund(state)                     # amount, order, reason
    decision = interrupt({                            # pauses the run, persists state
        "action": "refund_order",
        "payload": action,                            # exact arguments, not a summary
        "evidence": state["evidence"][:5],            # sources the agent relied on
        "proposed_effect": "Refund $84.00 to card ending 4242",
    })
    if decision["type"] == "reject":
        return {"status": "rejected", "note": decision.get("note", "")}
    if decision["type"] == "edit":
        action = decision["payload"]                  # reviewer's version wins
    return execute_refund(action)
```

Three details make this safe. The reviewer sees the **payload**, not the agent's description of the payload — the two diverge, and reviewers who read only the summary approve things they did not intend. The **decision is bound to the payload hash**: if the state changes between approval and execution, the approval is void and must be re-obtained. And an **edit** produces a new payload that must pass the same validators as an agent-generated one.

## What the reviewer needs to see

An approval screen is a UI for a decision under time pressure. It should show: the concrete action and its arguments; the effect in plain language with units and currency; the evidence the agent used, with links; what happens on approve, including whether it is reversible; and what the alternatives are (reject with a reason, edit the payload, escalate).

It should not show: the model's chain of thought as the primary artefact (it is persuasive and unverified), a wall of raw JSON, or an "approve all" button next to a single item.

Reviewer behaviour is the actual control, so measure it. Track **override rate** (rejections and edits as a share of approvals), **time to decide**, and **payload change rate**. An override rate near zero with sub-second decisions means the gate is theatre. A sudden spike in edits means the agent's context or prompt changed in a way the reviewer is silently compensating for — that is a regression signal, not a UI problem.

## Authority, separation, and audit

Approvals must be checked server-side against the approver's role and scope: the review UI is a client, not an authority. If the agent's own service account can call the tool, approval is a suggestion — the executor must require a signed, single-use approval token bound to the payload hash and the approver's identity.

For high-value actions, require two distinct approvers, or a different approver than the requester. For actions where the requester *is* the approver (an analyst using their own agent), make the risk explicit rather than pretending the flow is controlled: an agent that can prepare and execute the same action has no separation of duties, and for regulated actions that is usually disqualifying.

Audit records should be append-only and answer, without reading chat transcripts: who approved, when, what exact payload, on what evidence, and what the outcome was. Store the model version and prompt version too — an audit that cannot say which policy was executing is not an audit.

## Handling the wait

Approval latency is often hours, so the design must tolerate it. Send notifications out-of-band (email, Slack, ticketing) rather than holding a session open. Expire stale requests with an explicit reason (`approval_expired`) rather than leaving runs in limbo. Let the user's original request fail gracefully: "we need approval for the refund; here is what we proposed" is a good outcome, and a run that hangs silently is not.

Resuming is a state transition, not a re-run: the decision enters state, the graph continues from the checkpoint, and every side effect after the gate is idempotent (chapter 4), because a resumed node can execute twice.

## Risk tiering instead of blanket gating

A single policy — "approve everything" — destroys the product; "approve nothing" destroys the control. Tier by amount, reversibility, data sensitivity, and the model's own confidence signal:

| Tier | Example | Control |
|---|---|---|
| Low | Read-only lookups, draft replies | None; log and sample-audit |
| Medium | Address change under a threshold | Post-hoc sample review, undo window |
| High | Refund above threshold, plan change | Pre-execution approval, one approver |
| Critical | Account deletion, payouts, legal notices | Dual approval, no auto-execution path |

Confidence can tier an action but should not authorise it: a model's self-reported confidence is weakly calibrated, so use it to route *toward* review, never to skip it for a class that requires review.

## Common mistakes

- Gating a plan instead of a payload, so the reviewer approves an intention and the agent chooses the details.
- Re-prompting the model after approval, letting it regenerate arguments that were never reviewed.
- A modal "are you sure?" in the product UI presented as human oversight.
- Approvals executed by the same service identity the agent uses, so the gate is bypassable by any tool path.
- No expiry, leaving runs paused forever and users without an answer.
- Counting approval events as evidence of oversight without measuring override or edit rates.
- Showing the agent's reasoning and calling it evidence.

## Production notes

Give every approval a stable id, and make the decision endpoint idempotent — approvers double-click. Rate-limit and authenticate the decision endpoint like any privileged API, and alert on approvals arriving from unexpected sources or at abnormal rates. Emit metrics for gate volume, latency percentiles, override rate, and expiry rate; a rising expiry rate usually means the notification path broke, not that approvers are slow. Finally, review the gates themselves quarterly: for each one, state what it prevents, what it costs in latency and staff time, and what the measured catch rate is. A gate nobody can justify should be removed or automated, because an unread approval queue trains people to approve without reading — and that habit spreads to the gates that matter.
