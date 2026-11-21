# Planning Patterns and How They Fail

A bare loop picks the next action from what it sees now. It works for short tasks and degrades on long ones, because nothing is responsible for the shape of the whole. Planning patterns impose that shape — and each brings its own characteristic failure.

## Why plan at all

Greedy stepping has two structural weaknesses. It has no notion of *coverage* — nothing ensures all parts of a request get addressed — and no notion of *commitment*: each step is chosen as if the task started there. On a task like "compare the three vendors' SLAs and tell me which breaches our requirements", a greedy agent often answers the first sub-question well and forgets the third.

Planning inserts an explicit artefact — a plan, a critique, a scratchpad — between perception and action. That artefact is inspectable, which matters as much as any accuracy gain: you can log it, diff it between prompt versions, and show it to a reviewer. The cost is more steps, and steps compound error. If each step succeeds with probability *p*, a task requiring *n* sequential correct steps succeeds roughly *p^n*: 0.95 per step over ten steps is about 0.60; over twenty steps, about 0.36. Raising per-step reliability from 0.95 to 0.99 lifts a thirty-step task from roughly 0.21 to 0.74. This arithmetic, not any benchmark, is the strongest argument for shorter trajectories and for making steps verifiable.

## ReAct: reason and act, interleaved

ReAct (Yao et al., 2022) alternates a short reasoning trace with an action and its observation. The model writes a thought, calls a tool, reads the result, thinks again. The pattern's value is that each thought is conditioned on real observations rather than on the model's memory of the world, and each action is justified by the thought immediately before it.

```text
Thought: The user asks which plan includes SSO. I need the pricing page, not the docs index.
Action: fetch_page(url="https://vendor.example/pricing")
Observation: [page text … "Enterprise: SSO, SCIM, audit log"]
Thought: SSO appears only under Enterprise. I still need the per-seat price.
Action: fetch_page(url="https://vendor.example/pricing#enterprise")
...
```

What it buys: adaptivity with grounding, plus a readable trace and a cheap place to inject nudges ("check whether the value is a percentage before comparing").

**Failure modes, in the order they appear in practice:**

- *Loops.* The agent repeats a search with slightly different wording because the observation did not answer the question and it has no rule for giving up. Cap identical calls by argument hash, not just total steps.
- *Thought–action drift.* The reasoning says one thing and the action does another — usually a hallucinated argument (a URL that appears nowhere in the observation). Validate arguments against schemas.
- *Unverified reasoning.* A confident thought ("the API returns a list of orders") becomes the premise for the next three steps. Thoughts are not evidence; only observations are.
- *Context and cost growth.* Every thought, action, and observation accumulates, and a chatty trace on a twenty-step task both buries the decisive early observation and dominates the bill (chapter 3).

## Plan-and-execute

The other family separates planning from acting. A planner decomposes the task into an ordered list of steps with explicit inputs and outputs; an executor carries out one step at a time with a smaller context and narrower tool set; a re-planner revises the list when a result invalidates an assumption. Plan-and-Solve prompting (Wang et al., 2023) is the cheap version: instruct the model to write a plan, then execute it in the same call.

What it buys:

- *Coherence on long tasks.* The plan is a checklist, so missing sub-goals are visible.
- *Cheaper execution.* Executor calls see one step, not the whole history, so they can use a smaller, cheaper model.
- *Inspectability and control.* A plan can be shown to a user, edited, capped, or rejected before anything runs — the natural insertion point for approval gates. Independent steps can also run concurrently, which a greedy loop cannot do.

**Failure modes:**

- *Stale plans.* Step 1 reveals the account is closed; steps 2 through 7 assume it is open. Without a re-plan trigger the executor obediently does nonsense. Define the trigger (a step fails twice, an observation contradicts a stated assumption) rather than re-planning every step, which doubles cost and produces churn.
- *Fantasy decomposition.* The planner writes steps no tool can perform ("cross-reference the CRM with billing") and the executor improvises. Validate the plan against the tool catalogue before execution.
- *Over-decomposition.* Twelve steps where three would do: each is another call, another failure chance, another thing to log. Cap plan length.
- *Executor drift.* The plan said "look up the invoice" but not which account, so the executor guesses. Pass explicit inputs between steps instead of relying on inherited chat history.
- *Capability mismatch.* A strong planner with a weak executor produces plans that are correct in principle and unachievable in practice, and the failure looks like an executor bug.

## Reflection and self-critique

Reflection adds a third role: after attempting, the model critiques the attempt and retries with the critique in context. Reflexion (Shinn et al., 2023) formalises this as verbal reinforcement — store a short lesson from a failed attempt and carry it into the next one, without weight updates.

Reflection is powerful when the critique is grounded in an external signal: a failing test, a compiler error, a validator message, a 400 from an API. In coding agents this is the dominant loop — run the tests, read the failure, fix it — and it works because the feedback is not the model's opinion of itself. It is close to useless when the model must judge its own output with no new information: a model that just produced the answer has no independent evidence and tends to agree with itself, or to invent plausible-sounding objections unrelated to the actual error. Two failure shapes follow: *self-approval* (critique says "looks good" on a wrong answer) and *thrash* (each round invents a new concern and the output oscillates without converging).

Practical rules: spend reflection budget only where a verifier exists; cap iterations at two or three; keep the critique and the original attempt in the same context so the revision is a diff rather than a rewrite; and log whether a round actually changed the output. If most rounds change nothing, you are paying for a ritual.

| Pattern | Structure | Best for | Characteristic failure |
|---|---|---|---|
| ReAct | Thought → action → observation, repeated | Short, tool-heavy, investigative tasks | Loops; drift between reasoning and arguments |
| Plan-and-execute | Plan once, execute steps, re-plan on trigger | Long tasks with clear sub-goals | Stale plan after a surprising observation |
| Reflection | Attempt → critique → revise | Tasks with a verifier (tests, schemas) | Self-approval when no external signal |

## Choosing, and the hybrid that survives

Ask three questions. Is the task short enough that a greedy loop will not lose the thread? Is there a verifier I can hand the critique? Is any single step expensive enough to need human review? Short and tool-heavy: ReAct. Long with clear sub-goals: plan-and-execute. A verifier exists: reflection around it — otherwise skip reflection. In production the answer is usually the hybrid: a plan the system owns with a budgeted agentic node inside each step.

## Common mistakes

- Assuming a longer reasoning trace means a better answer; unbounded "think harder" prompts mostly buy tokens.
- Letting the planner see no tool list, then blaming the executor for improvising.
- Reflecting without a verifier and treating the self-critique as ground truth.
- Measuring only final answers, which hides a fivefold increase in steps for the same quality.

## Production notes

Store the plan as structured data — step id, description, inputs, expected output, status — not as prose, so a resumer can pick up mid-plan and a reviewer can approve step four only. Log plan revisions with the observation that triggered them; a high revision rate means the planner's world model is wrong. Budget per step and per plan: a step that exceeds its token allowance should fail and hand back its partial result, not silently consume the run's budget. Keep the plan format stable across prompt versions, or every downstream consumer — UI, approvals, metrics — breaks when you tune the planner.
