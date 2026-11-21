# What an Agent Is — Loop, State, Tools

Strip away the branding and an agent is a small, well-understood program: a loop that asks a model what to do, does it, records what happened, and asks again. Everything interesting — and everything that breaks in production — follows from the four parts of that loop and from the decision to use one at all.

## The four parts

**A model call.** The model receives a conversation-shaped input: a system prompt, a task, a history of prior actions and their results, and a list of tool definitions. It returns either a final answer or a request to call a tool.

**A state object.** Something outside the model records the task, the steps taken, the observations returned, any artefacts produced, and the budget consumed. If this lives only in the message list, it is still state — just unstructured, unbounded, and impossible to inspect without reading prose.

**A tool interface.** A typed set of functions with descriptions, argument schemas, and defined error behaviour. This is the agent's entire action space. A model that cannot call anything is a chatbot; the tool surface is what turns text into effects.

**A stopping rule.** The loop ends on a final answer, on a step limit, on a token or time budget, or on a human interrupt. Every agent needs all four kinds, not one, because a final answer that never arrives is indistinguishable from a bug.

```python
state = {"task": task, "steps": [], "tokens": 0}

for step in range(max_steps):
    reply = model.complete(system, state["steps"], tools=TOOLS)
    state["tokens"] += reply.usage.total

    if reply.tool_calls:
        for call in reply.tool_calls:
            result = run_tool(call)          # validated, authorised, timed out
            state["steps"].append({"call": call, "result": result})
        continue

    if reply.final:
        return reply.final                   # outcome checked by caller, not trusted blindly

raise StepLimitExceeded(state)               # an outcome, not an exception to swallow
```

That is a complete agent. Frameworks add persistence, streaming, parallel tool execution, retries, and human interrupts around this shape; they do not change it.

## Agent, pipeline, and workflow

A **pipeline** is a fixed sequence of model calls with typed inputs and outputs: extract fields, classify, draft, render. The control flow is written by an engineer. A **workflow** adds branching and loops, but the branches are conditions you wrote — if confidence is below a threshold, send for review.

An **agent** differs in exactly one respect: the model chooses the next action at runtime. Not "the model produces content that a graph routes on" — that is a workflow with an LLM classifier. The model's own selection among tools determines the path.

| Property | Pipeline | Agent |
|---|---|---|
| Who chooses the next step | Code | Model |
| Cost per request | Predictable | Long-tailed |
| Failure mode | Wrong output | Wrong output, or no output, or 40 steps of thrash |
| Reproducibility | Same input, same path | Same input, different path |
| Debugging | Read the code | Read the trace |
| Test strategy | Unit tests per stage | Trajectory and outcome evals |
| Change cost | Edit a prompt or a branch | Edit a prompt and re-measure a distribution |

The table is the argument. Agents buy coverage of branch structures you could not enumerate; they pay in every other column. Note that "the model chose the path" is only valuable if the path really is unpredictable — if eighty percent of requests take the same three steps, you have written an expensive pipeline.

## When an agent is the wrong choice

Be concrete about the disqualifiers, because agent projects usually fail at the design stage rather than the model stage.

**The task is bounded.** If you can write the steps on a whiteboard and they hold for most inputs, write them in code. A pipeline with three LLM calls over typed data is cheaper, testable, and cannot loop.

**Errors are expensive and irreversible.** Sending a customer email, mutating a production table, issuing a refund, or deleting a file are not tasks for an autonomous loop. Either the action is behind an approval gate (chapter 6) or it should not be tool-callable at all.

**The tool surface is enormous and uncurated.** An agent given two hundred tools chooses badly; selection accuracy degrades as the menu grows and descriptions overlap. If you cannot get to roughly a dozen well-differentiated tools per decision point, the problem is retrieval of tools, not agency.

**Latency budget is tight.** Every step is a round trip with a model call. A three-step agent on a p95 budget of 800 ms is not achievable; interactive agents usually need sub-second first tokens and a UI that shows progress.

**You cannot evaluate it.** If nobody can say whether a run was good, an agent is unfalsifiable — you will ship regressions and learn about them from users. Chapter 7 is a prerequisite, not a follow-up.

**The information is missing, not the reasoning.** Many "agent" requests are really retrieval problems. If the model needs the right document rather than the right sequence of actions, fix retrieval and use one call.

## Where agents earn their cost

The pattern that survives contact with production is the **agentic step inside a deterministic frame**: a workflow where one node is allowed to iterate. A support system might deterministically authenticate, load the account, then hand a research node a budget of six tool calls to decide between three dispositions, then deterministically route the disposition through approval. The frame gives you auditability; the node gives you coverage.

The second durable pattern is **long-horizon work with checkpointing**: a coding or data-reconciliation agent that runs for minutes, may be interrupted, and must resume. Here the value is not intelligence but persistence, and the engineering is all in state (chapters 5 and 10).

## Common mistakes

- Calling a chain of prompts an agent, then being surprised that adding a step changed nothing about reliability. If the model never chooses a path, you have a pipeline and should test it like one.
- Letting the message history *be* the state. You then cannot answer "what did it try?" without parsing prose, cannot resume, and cannot enforce a budget.
- No step limit, or a step limit so high it never fires. A loop cap of fifty on a task that needs four is a budget failure disguised as safety.
- Treating the model's final message as ground truth. The loop returns a claim; the caller validates it against the world.
- Adding tools to fix reasoning failures. Most "the agent is dumb" incidents are missing context or a bad observation format, not a missing capability.
- Building multi-agent topologies before a single agent works. Two unreliable reasoners talking to each other are not more reliable.

## Production notes

Log every step as structured data: step index, tool name, arguments hash, result size, latency, tokens in and out, and stop reason. That record is the only way to reconstruct a bad run, and it is what evaluation reads. Put the loop behind a queue for anything over a few seconds; an HTTP request is not a durable execution environment. Set three limits — steps, wall clock, and tokens — and decide in advance which one fires first, because the failure message users see should name the budget that ran out. Finally, make the agent's stop reasons enumerable (`answered`, `step_limit`, `budget`, `refused`, `needs_human`, `tool_error`) and count them in a dashboard. A rising `step_limit` rate is the earliest signal that a prompt or tool change made the agent worse.
