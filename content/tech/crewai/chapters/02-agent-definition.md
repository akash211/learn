# Defining Agents: Role, Goal, Backstory

An agent in CrewAI looks like an object with behaviour. It is closer to a **prompt constructor with a budget**. Three string fields — `role`, `goal`, `backstory` — become the system portion of every prompt that agent receives; the task description and expected output are appended per assignment; tool descriptions are appended when tools exist. Nothing else about the agent is autonomous. Understanding the mapping from fields to prompt text is most of what "agent design" means here.

## What the three fields actually do

| Field | What it controls | Typical failure |
|---|---|---|
| `role` | Domain, stance, vocabulary, level of assumed expertise | Generic role yields generic output; role implies authority the agent does not have |
| `goal` | How ambiguity inside a task gets resolved; what to optimise | Vague goal ("do a good job") leaves every trade-off to chance |
| `backstory` | Register, priors, implicit standards, tone | Treated as a knowledge base; bloats every call; invents credentials |

```python
analyst = Agent(
    role="Regulatory filing analyst",
    goal=(
        "Extract only what the filing states about capital expenditure, quantify it in the "
        "filing's own units, and mark anything inferred as an inference. If a figure is "
        "missing, say so rather than estimating."
    ),
    backstory=(
        "You have read thousands of quarterly filings and you distrust summaries. "
        "You quote the sentence you relied on before you state a number."
    ),
    llm="openai/gpt-4o-mini",
    max_iter=8,
    allow_delegation=False,
)
```

The `role` is a noun phrase with a domain and a stance. "Regulatory filing analyst" tells the model which register of language to use, which distinctions matter, and roughly how much hedging is appropriate. "AI assistant" tells it nothing, and the output regresses to the average of the training distribution — helpful, fluent, and useless for a task that requires a specific standard.

The `goal` is where ambiguity gets resolved. A task says *what* to produce; the goal says what to prefer when the task is underspecified. "Extract capex and quantify it" leaves open what to do with a range, a restatement, or a missing figure. The version above answers all three: use the filing's units, mark inferences, refuse to estimate. That is not politeness — it is the difference between an output you can check and one you cannot.

The `backstory` is the field people over-invest in. It is the cheapest way to set register and implicit standards ("you quote the sentence before you state a number") and the most expensive way to smuggle in facts. It is **not memory**: it is static text re-sent on every model call for every task that agent performs. A 400-word backstory is not a one-time cost; multiply it by tasks, by iterations, by retries.

## The consequences for prompt design

**Persona is a per-call tax.** Each agent's role, goal and backstory are prepended to every prompt that agent sees. A five-agent crew where each agent has a 300-word backstory pays for 1,500 words of persona on the first task and again on every subsequent one. The same budget spent on `expected_output` detail usually buys more reliability, because output shape is where models actually drift.

**Constraints need one home.** When the role says "be concise" and the task says "provide a full appendix", the model picks — and it picks differently across runs. Put hard requirements in `expected_output` or a guardrail, soft style in the role, and never restate the same rule in two places with different wording.

**Specificity beats adjectives.** "Meticulous senior analyst with 15 years of experience" changes tone slightly. "Every claim carries a source URL and a date" changes behaviour. If you can only afford one sentence, make it a checkable rule.

**Interpolation is an input channel.** `{topic}` in a role or goal is filled from `kickoff(inputs=...)`. That means user-supplied text can land in the system prompt. Validate inputs, keep them out of `role` where possible, and prefer passing untrusted content through task data or a tool result, where it is clearly framed as material to process rather than instruction to follow.

**Later text wins, in practice.** When the task description conflicts with the backstory, the task usually prevails because it is more specific and closer to the instruction. Do not design around this. Treat a conflict as a bug.

**The fields you did not write often matter more.** `llm` decides capability and cost. `tools` decides what the agent can do at all. `max_iter` bounds the internal loop — default 20, which is generous for a task that should need three tool calls. `allow_delegation` defaults to `False` and should stay there unless you have designed for it. `respect_context_window` silently summarises when history grows; the summary is where fidelity dies quietly.

## Two definitions of the same job

Weak:

```python
Agent(
    role="Research Assistant",
    goal="Help with research tasks",
    backstory="You are a helpful AI assistant with expertise in many areas.",
)
```

Strong:

```python
Agent(
    role="Primary-source researcher",
    goal=(
        "Answer the assigned question from primary sources only. For each claim, record "
        "the URL, publication date and one sentence of supporting text. If two sources "
        "disagree, report both and say which is more recent."
    ),
    backstory=(
        "You have been burned by secondary summaries that dropped a caveat. You would "
        "rather return four verified findings than twelve plausible ones."
    ),
    tools=[search_tool, fetch_tool],
    max_iter=10,
)
```

The strong version differs in three ways that matter: it names a standard (primary sources), it specifies the evidence payload per claim, and it sets a preference for precision over volume. The backstory is doing the last part — it gives the model a reason to stop early, which is otherwise a hard behaviour to obtain from a task description alone.

## Reasoning, caching and the rest

`reasoning=True` adds a planning step before the agent acts, which costs extra calls and helps mainly on tasks with several plausible strategies. `cache=True` (the default) caches tool results, so repeated identical searches are cheap — but it also means a stale result can be reused within and across runs, which is wrong for anything time-sensitive. `inject_date=True` adds the current date to the prompt; without it, models routinely assume their training cutoff is "now". `function_calling_llm` lets you route tool-choice decisions to a cheaper model than the one that writes the final answer, a useful cost lever when the tool set is small.

These flags are more honest levers than persona wording. If an agent keeps choosing the wrong tool, the fix is a better tool description or a smaller tool set, not a stronger adjective in the backstory.

## Common mistakes

- **Backstory as knowledge base.** Dumping product facts into the backstory guarantees they are stale and paid for on every call. Use knowledge sources, a retrieval tool, or task context.
- **Contradictory fields.** A "concise" role with a "comprehensive" task produces output that is neither.
- **Invented credentials.** "You are a licensed financial adviser" is a compliance problem, not a prompt trick.
- **One agent for everything.** A single generalist with ten tools chooses worse than three specialists with three tools each.
- **Believing the role is a sandbox.** Role text constrains style, not permissions.

## Production notes

Keep agent definitions in version control — the generated `agents/*.jsonc` files in a current project scaffold, or `agents.yaml` in a classic layout — and review role changes with the same rigour as prompt changes in application code. Treat the definition as a schema: required fields, no user-controlled interpolation into `role`, and a fixed model identifier per agent. Write a small evaluation set of ten to twenty inputs with known-good answers and re-run it whenever a role, goal, backstory or model changes; without that, "the agent got worse" is an unfalsifiable complaint. Finally, prune. Every sentence in an agent definition should be there because removing it changed an output you measured.
