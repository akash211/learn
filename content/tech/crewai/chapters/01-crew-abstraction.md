# The Crew Abstraction: Agents, Tasks and Process

CrewAI has three nouns and one verb. **Agents** are specialists with a role, a goal and a backstory. **Tasks** are assignments with a description and an expected output. A **Crew** binds agents to tasks and runs them under a **process** when you call `kickoff()`. Everything else — tools, memory, delegation, guardrails — elaborates one of those ideas.

The abstraction is not a thin wrapper over an LLM call. It is a *team metaphor* that determines what the framework can express cheaply and what it cannot express at all. Teams that miss the metaphor's limits end up fighting the framework exactly where the requirements become interesting.

## A minimal crew

```python
from crewai import Agent, Crew, Process, Task

researcher = Agent(
    role="Market researcher",
    goal="Find primary-source evidence about {topic} and state what remains uncertain",
    backstory=(
        "You have spent a decade reading filings, datasheets and technical documentation. "
        "You prefer a cited number to a confident adjective."
    ),
)

writer = Agent(
    role="Technical writer",
    goal="Turn verified findings into a one-page brief for engineers",
    backstory="You write for people who will act on the text, not admire it.",
)

research = Task(
    description=(
        "Collect evidence about {topic}. Use the search tool. Record the source URL, "
        "the publication date and a note on how directly the source supports the claim."
    ),
    expected_output=(
        "A bullet list of 5-10 findings. Each line: claim, source URL, date, confidence "
        "(high/medium/low). No finding without a URL."
    ),
    agent=researcher,
)

brief = Task(
    description=(
        "Write the brief using only the findings from the research task. If a claim lacks "
        "a source, drop it rather than soften it."
    ),
    expected_output=(
        "A markdown brief of at most 400 words with two sections: 'What we know' and "
        "'What is unclear'. No fenced code blocks."
    ),
    agent=writer,
    context=[research],
)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research, brief],
    process=Process.sequential,
    verbose=True,
)

result = crew.kickoff(inputs={"topic": "grid-scale battery storage"})
print(result.raw)
```

That is runnable modulo an API key. Read it as a specification: the researcher gathers cited evidence, the writer turns it into a brief, and the second task receives the first task's output as context. `{topic}` is interpolated from `inputs` at kickoff.

## What each noun actually buys you

An **agent** is a prompt bundle plus a configuration record. Its role, goal and backstory become system-level instructions; its `tools` list becomes the callable set; its `llm` selects the model; `max_iter` bounds its internal tool loop. Because each agent carries its own model and tool set, agents cheaply separate *capability*: a small model for extraction, a strong one for synthesis, search tools for one agent and a database tool for another.

A **task** is the only place in the framework where a contract exists. `expected_output` is not a comment; it is injected into the prompt as the definition of done, and it is the closest thing CrewAI has to a schema unless you attach `output_pydantic`. `context=[...]` declares an explicit data dependency, which matters more than it looks: without it, a task sees only what the process hands it.

A **process** is a scheduler with two implemented modes. `Process.sequential` runs tasks in list order. `Process.hierarchical` inserts a manager agent that assigns and reviews work. There is no `Process.parallel` and no cycle construct; earlier releases advertised a consensual process that no longer appears in the documentation.

## What the abstraction optimises for

CrewAI optimises for **authoring speed on a sequence of specialists**. A team can describe a workflow in the vocabulary they already use in planning meetings and get code that matches closely enough to review. Role text doubles as documentation; task boundaries double as log boundaries.

It does not optimise for state, branching, resumption or determinism; those are what you trade away for the short definition.

| Concern | Plain functions | Single agent | CrewAI crew | LangGraph |
|---|---|---|---|---|
| Unit of composition | A function | A prompt + tool loop | Role + task | Node + edge |
| Shared state | Function arguments | Conversation | Task outputs threaded by the process | Explicit typed channels |
| Branching | `if` | Model decides | None (both processes are fixed shapes) | Conditional edges |
| Cycles | `while` | Tool loop bounded by `max_iter` | None between tasks | Explicit, with a recursion limit |
| Resumption | Your code | Your code | Flow persistence | Checkpointer |
| Fastest to write | Slow for LLM steps | Fast | Fastest for multi-role | Slowest |
| Easiest to reason about | High | Medium | Low–medium | High |

The honest reading of that table: a crew is a *narrative* structure, and narratives are linear. The moment your process needs "if the reviewer rejects, go back to drafting", you are outside what a crew expresses, and you either wrap the crew in a Flow or move the control flow into your own code.

## Where the metaphor leaks

**Ordering is positional.** Tasks run in list order, not in an order declared by dependencies. `context` tells a task what to read; it does not reorder execution, so inserting a task silently changes semantics.

**State is the transcript.** The framework passes prior task output into later prompts as text. Cost per task therefore grows with the number of preceding tasks, so total tokens grow faster than linearly in the number of steps — a six-task crew is not six times a one-task crew, it is closer to twenty-one. Long crews also hit context limits, and the framework's response is summarisation (`respect_context_window`), which is lossy exactly where you most want fidelity.

**Everything is prompt.** "Each finding must have a URL" is a sentence in a prompt. A model that omits URLs has not violated a contract; it has produced a slightly worse answer, and the crew will carry on. Only `guardrail` functions and `output_pydantic` validation turn a sentence into an enforced rule.

**Role is not permission.** There is no capability boundary between agents. If two agents share a crew, they share the tool objects and the same credentials; `role="Junior analyst"` restricts style and framing, not access. Any real restriction has to live inside the tool.

**Hierarchy is not a workflow engine.** The hierarchical process adds a manager loop on top of the same linear task list. It buys adaptive assignment and review, not retries, compensation or branch-and-merge.

## A crew is not a state machine

Consider the natural next requirement: the writer's brief should be reviewed, and rejected drafts should go back for revision. CrewAI's answer is not an edge back to the writing task. Within a single task, an agent can iterate — it can call a tool, read the result and try again, up to `max_iter`. Between tasks, execution moves forward only.

The three workable patterns are: add a reviewer task whose `expected_output` includes a verdict and let a human read it; put the crew inside a Flow whose router sends rejected output back to a second kickoff; or move the loop into LangGraph, where a cycle is a first-class edge. Choosing among those is a design decision, not a configuration detail, and it is the decision this module returns to in the last chapter.

## Common mistakes

- **One agent per sentence of the brief.** Six agents with six-sentence backstories cost six system prompts per task and coordinate worse than two agents with clear tasks.
- **Assuming conversation memory between tasks.** Tasks do not share a chat history; they share whatever the process threads forward.
- **Treating `verbose=True` as observability.** It prints to stdout. It is not a trace store, and it does not survive a container.
- **Leaving `allow_delegation` on everywhere.** Delegation tools invite agents to hand work sideways instead of doing it.
- **Calling `kickoff()` in a request path** without a latency and token budget.

## Production notes

Generate the project with `crewai create crew <name>`. Current releases scaffold a JSON-first layout (`crew.jsonc` plus `agents/*.jsonc`); the older YAML `agents.yaml` / `tasks.yaml` layout is still available with `--classic`, and both are just configuration that constructs the same objects. Pin the `crewai` version and the model identifier together — provider-side model aliases move, and a silent model change is a behaviour change. Set `max_iter`, `max_rpm` and `max_execution_time` explicitly rather than accepting defaults, validate `inputs` before interpolation, and persist each `TaskOutput` somewhere durable if the result will be audited. 
