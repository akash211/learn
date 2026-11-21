# When a Crew Is Overkill

The hardest CrewAI skill is not building a crew. It is deciding not to. A crew adds agents, prompts, a process, coordination tokens and a debugging surface — and it adds them *before* you know whether the task needs any of it. This chapter is a decision procedure, not a prohibition.

## Four questions before you write `Agent(`

**Does the work genuinely decompose into roles that need different things?** Not different *tones* — different tools, different permissions, different context, or mutually exclusive instructions. "You are a researcher and you are a writer" is a decomposition only if the researcher needs a search tool the writer must not have, or if a single prompt containing both instruction sets produces worse output than two prompts. If the answer is "it feels tidier", you are buying coordination cost for aesthetics.

**Is the sequence known?** A crew is a linear pipeline with role labels. If you can write the steps as a numbered list before the model runs, a crew fits. If the next step depends on what was found, you want a Flow or a graph.

**Does anything need to branch, retry, resume or wait for a human?** Crews do none of these between tasks. One rejected draft and you are outside the abstraction.

**Can you tell whether it is better?** If there is no fixture set and no measurable outcome, a crew is unfalsifiable — you will not know whether the extra agents helped, and you will not be able to defend the cost.

## The decision table

| Situation | Use | Why |
|---|---|---|
| One input, one output, one format | A single model call | No state, no tools, no coordination |
| Fixed 3-step pipeline, no tools | Three functions | Testable, cheap, no framework |
| One agent with 3-5 tools, loop needed | Single agent | The loop is the only agentic part |
| Two or three roles with different tools or permissions, known order | Sequential crew | Role separation is real; order is fixed |
| Many specialists, assignment genuinely unclear | Hierarchical crew, or a router in code | Manager buys assignment, at several times the cost |
| Branching, approvals, retries, resumption | Flow (crews as steps) | Control flow must be explicit |
| Typed state, interrupts, checkpointed threads across requests | LangGraph | State and resumption are first-class |
| Scheduled or durable multi-service work | An orchestrator plus a Flow or crew step | Crews are not schedulers |
| Compliance logic, arithmetic, authorization | Plain code | A model must not be the decision |

The rows are ordered by increasing coordination cost, and the correct default is to start one row higher than you think you need. Moving down is easy when you have measurements; moving up after shipping is a rewrite.

## What a crew actually costs

Take a four-agent sequential crew against the same work as one agent with four tools:

- **Four system prompts instead of one.** Each role, goal and backstory is re-sent on every task that agent performs.
- **Lossy interfaces.** Agents exchange text, not typed objects. Each hop is an opportunity to drop a caveat, a unit or a qualifier that the next agent needed.
- **Accumulating context.** Task four sees tasks one to three; its prompt is the largest and its cost the highest.
- **A bigger evaluation surface.** Four prompts and a process to regress-test, not one.
- **Attribution difficulty.** When output is wrong, the cause may be the task, the role, the context passed, or the process — and the framework's logs describe all four in prose.

None of that is an argument against crews. It is an argument for knowing which of those costs you are paying for a reason. If the reason is "a reviewer agent catches errors a single agent misses", test that claim: run both variants on the fixture set and compare error rates. Frequently the reviewer agent mainly rewrites the output in a more confident register.

## The same task, two ways

Crew version:

```python
research = Task(description="...", expected_output="...", agent=researcher)
brief = Task(description="...", expected_output="...", agent=writer, context=[research])
crew = Crew(agents=[researcher, writer], tasks=[research, brief], process=Process.sequential)
result = crew.kickoff(inputs={"topic": topic})
```

Plain version:

```python
findings = research(topic)                  # returns ResearchPacket
brief = write_brief(findings)               # raises if findings.gaps is too large
```

The plain version is shorter, typed, unit-testable, and has no framework between the steps. The crew version is justified only if `research()` and `write_brief()` need different tools, different models, different permissions, or genuinely conflicting instructions that a single prompt cannot hold. Those are real conditions — a search-enabled researcher and a citation-checking editor are a legitimate pair — but they are specific conditions, not a default.

## Crew or LangGraph

Both coordinate multi-agent work; they optimise for different things.

| Concern | CrewAI | LangGraph |
|---|---|---|
| Primary metaphor | A team with roles and tasks | A state machine with nodes and edges |
| Control flow | Implicit in the process; linear | Explicit; branches and cycles are edges |
| State | Task outputs threaded as text | Typed channels with reducers |
| Resumption | Flow persistence by state ID | Checkpointer per thread |
| Human approval | Flow `@human_feedback` | `interrupt()` and resume |
| Time to first working prototype | Very fast | Slower |
| Time to a debuggable production system | Depends on how much control flow you add | Faster once the graph is drawn |
| Failure mode | Prompt soup: behaviour encoded in prose | Graph sprawl: nodes for everything |

The honest summary: CrewAI is faster when the system really is a sequence of specialists; LangGraph is better when the control flow is the interesting part. Neither makes a model reliable, and neither substitutes for evaluation.

## When a crew is the wrong tool entirely

- **The task has a correct answer that code can compute.** Totals, eligibility rules, date arithmetic, permission checks. A model may *phrase* the result; it must not *decide* it.
- **Latency budget is sub-second.** Each agent hop is at least one model call.
- **The output must be byte-identical across runs.** Use deterministic code and templates; a crew cannot promise this.
- **You need exactly-once side effects.** Use a system with transactional semantics and idempotency keys, and let the crew propose rather than commit.
- **The requirement is a dashboard, a form or a fixed report.** Nobody needs a persona for a query.

## Common mistakes

- **Starting with five agents.** Start with one and add a role only when a specific tool, permission or instruction conflict forces it.
- **Using a crew to look sophisticated.** Reviewers read the trace, not the architecture diagram.
- **Never collapsing a crew that should be one agent.** If every task uses the same agent's voice, the roles are decoration.
- **Choosing LangGraph for prestige or CrewAI for speed without measuring.** Both are cheap to prototype and expensive to migrate.
- **No exit criterion.** Decide in advance what evidence would make you collapse the design.

## Production notes

Prototype in the cheapest structure that could possibly work, instrument it, then let the fixture set decide. Keep the boundary thin: put the crew behind a function with a typed input and output, so replacing it with a single agent, a Flow or a graph is a local change rather than an application rewrite. Keep prompts in your repository and versioned with the code, not in a vendor console. And write down, in the README, why each agent exists — the reason is usually one of three: different tools, different permissions, or instructions that conflict in one prompt. If a role has none of those, it is a paragraph, not an agent.
