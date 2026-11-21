# Sequential and Hierarchical Processes

A process decides **who runs what, in which order**. CrewAI implements two: `Process.sequential` and `Process.hierarchical`. That is the entire scheduling vocabulary. There is no parallel process, no conditional process and no cycle; earlier releases advertised a consensual process that no longer appears in the documentation. If a workflow needs any of those shapes, the answer is a Flow or your own code around the crew, not a third `Process` value.

```python
crew = Crew(
    agents=[researcher, analyst, writer],
    tasks=[research, analyse, write],
    process=Process.sequential,
)
```

## Sequential: a for loop with prompts

Sequential execution walks the task list in order. Each task's agent runs its own loop — think, optionally call a tool, observe, repeat up to `max_iter` — and the resulting text is threaded into the next task's prompt. The final task's output is the crew's output.

The call profile is predictable and worth memorising, because it is the baseline every other design is measured against:

```
task 1 (research)  → 1 planning call? + k tool calls + 1 final answer
task 2 (analyse)   → 1 call (+ context from task 1 in the prompt)
task 3 (write)     → 1 call (+ context from tasks 1-2 in the prompt)
```

For a three-task crew with a research step that makes four searches, that is roughly seven to nine model calls and a prompt that grows at each step. Sequential is deterministic in *order*, not in *output*: the same inputs can produce different text, different tool choices and different costs on consecutive runs.

Its virtues are real. Order is obvious from the code. A failure is localisable to one task, one agent, one prompt. Cost is roughly linear in the number of tasks plus tool calls. Reviewers can diff a task list.

## Hierarchical: a manager in the loop

Hierarchical mode inserts a manager agent. You supply either `manager_llm` — a model identifier from which CrewAI constructs a manager — or `manager_agent`, a fully defined agent you control.

```python
crew = Crew(
    agents=[researcher, analyst, writer],
    tasks=[research, analyse, write],
    process=Process.hierarchical,
    manager_llm="openai/gpt-4o",     # or manager_agent=lead
)
```

The manager plans, delegates each step to whichever agent it judges suitable, reviews what comes back, and can re-delegate. Per the documentation, tasks are not pre-assigned in this mode: the manager allocates them. A task's `agent` field is therefore at most a hint, and the quality of the routing depends on how well the manager can tell your agents apart from their descriptions.

That last point is the practical heart of hierarchy. The manager's prompt contains each agent's role, goal and backstory, and nothing else about them — not their tools' reliability, not their failure history, not their cost. If three agents all describe themselves as "analyst", routing is a coin flip with a plausible explanation attached. Hierarchy is only as good as the distinctness of your agent definitions.

| Property | Sequential | Hierarchical |
|---|---|---|
| Who assigns tasks | You, by list order | A manager model |
| Determinism of order | Exact | Approximate |
| Model calls | ~1 per task + tools | Several per step: plan, delegate, review, possibly re-delegate |
| Adaptivity | None | Reassignment, review, extra attempts |
| Debuggability | High — failure points at a task | Lower — failure may be routing, review or delegation |
| Cost predictability | Good | Poor |
| Best fit | Known pipeline, fixed roles | Overlapping skills, unclear assignment, need for a review gate |

## What hierarchy costs

A hierarchical crew is not a sequential crew with a supervisor bolted on for free. The manager typically adds a planning call and a validation call around each delegated step, and re-delegation multiplies both. In practice that means several times the model calls of the equivalent sequential crew, plus a manager whose context must hold the accumulating outputs of every agent it supervises.

That last constraint is structural: the manager is a bottleneck for context. With four workers producing 800 words each, the manager is reading 3,000+ words per decision, and `respect_context_window` will start summarising exactly the details that made the outputs worth reviewing. Hierarchical crews degrade as they grow, in a way sequential crews do not.

The manager can also do the work itself instead of delegating — a common and expensive surprise. It has tools, it has the task, and delegation is effortful. Constrain its instructions if this matters, keep its tool set minimal, and check the trace rather than the summary to see who actually produced each artefact.

## Choosing

Choose **sequential** when the pipeline is known, each step has a clear owner, and the value is in doing the steps well rather than in deciding which step comes next. That covers most useful crews. Choose **hierarchical** when task-to-agent assignment is genuinely uncertain — many overlapping specialists, a queue of heterogeneous requests, a need for an independent review pass — and you can afford the extra calls and the reduced predictability.

Do not choose hierarchical to "add oversight". A manager model reviewing another model's output is a weak check: it sees the text, not the tool calls, and it shares the same blind spots. If oversight is the requirement, a guardrail with a deterministic assertion, or a human approval step, is cheaper and stronger.

## A custom manager agent

`manager_agent` exists for the cases where the default manager is too thin. Because it is an ordinary agent, you can give it a stronger model than the workers, a backstory that encodes your routing policy, and its own tools:

```python
lead = Agent(
    role="Delivery lead",
    goal=(
        "Assign each task to the agent whose stated expertise matches it most closely. "
        "Reject any output that lacks the required evidence fields and re-delegate once. "
        "Never produce the deliverable yourself."
    ),
    backstory="You are judged on the accuracy of the final pack and on how little you write.",
    llm="openai/gpt-4o",
    allow_delegation=True,
)
```

The interesting part is the last sentence of the goal and the backstory. Both are attempts to suppress the manager's tendency to answer rather than delegate — which tells you how much of process design in this framework is persuasion rather than configuration.

## Common mistakes

- **Hierarchical for a fixed pipeline.** You pay for planning and review calls that always reach the same conclusion.
- **Indistinguishable agents under a manager.** Routing becomes arbitrary; the trace shows a plausible rationale, which makes it worse, not better.
- **Assuming tasks cannot be skipped.** The manager decides what to run; a task you expected to execute may be merged or omitted, and the final output may not reveal it.
- **Reading only the final output.** In hierarchical mode the interesting information is in which agent ran what, and how many times.
- **Expecting retries.** Neither process retries a failed task. Guardrails retry within a task; a crash ends the run.

## Production notes

Log the process type, task order, agent assignment and per-task call counts with every run; without that, a cost spike in a hierarchical crew is unattributable. Keep worker `max_iter` low in hierarchical mode so a confused worker cannot burn the budget before the manager notices. Use a cheap model for workers and an expensive one for the manager, not the reverse. If you find yourself writing manager instructions that enumerate specific task-to-agent mappings, you have reimplemented sequential execution with extra calls — write the mapping in code instead, and keep the crew sequential.
