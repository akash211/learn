# Tasks, Expected Outputs and Structured Results

A task is where CrewAI stops being a metaphor and starts being a contract. The agent is a reusable persona; the crew is a container; the **task** is the only object that says what "done" means for a specific piece of work. Most crew quality problems are task problems wearing an agent costume.

```python
from pydantic import BaseModel, Field

class Finding(BaseModel):
    claim: str = Field(description="One sentence, no hedging")
    source_url: str
    published: str = Field(description="ISO date, or 'unknown'")
    confidence: str = Field(description="high | medium | low")

class Research(BaseModel):
    findings: list[Finding]
    gaps: list[str]

research = Task(
    description=(
        "Answer the question in {question} using the search tool. One search per "
        "distinct sub-question, at most six searches. Record the URL you actually "
        "opened, not a search-result snippet. If a sub-question cannot be answered "
        "from a source you opened, add it to gaps instead of guessing."
    ),
    expected_output=(
        "A JSON object with 'findings' (3-8 items, each with claim, source_url, "
        "published, confidence) and 'gaps' (list of unanswered sub-questions). "
        "No finding may have an empty source_url."
    ),
    agent=researcher,
    output_pydantic=Research,
)
```

## Description versus expected output

These two fields are often written as though they were the same document. They do different jobs.

The **description** is instructions: what to do, in what order, with which tools, and what to do when the obvious path fails. It should be self-contained, because a task may run with only the context the process hands it. Write it imperatively and include the awkward cases — the missing field, the ambiguous request, the source that contradicts the last one.

The **expected output** is the definition of done, and it is the stronger of the two. Models optimise toward what they can see being checked. "A summary of the findings" is unfalsifiable; "3-8 items, each with a URL, no empty source_url" is a target. When output quality disappoints, sharpening `expected_output` usually moves the result more than rewriting the description, because it changes what the model believes success looks like.

A practical rule: the description says how to work, the expected output says what to hand back, and every sentence in the expected output should be checkable by a person reading the result for ten seconds.

## Three layers of enforcement

| Layer | Declared as | Enforced by | Fails how |
|---|---|---|---|
| Prompt-level | `expected_output` text | The model's compliance | Silently — a worse answer is still an answer |
| Parse-level | `output_pydantic` / `output_json` | Conversion of the final text into the schema | Error or retry; nested schemas can fail |
| Function-level | `guardrail` / `guardrails` | Your Python, run after the task | Returns a failure the crew can retry |

Only the second and third layers are enforcement. If a requirement matters, it belongs in one of them. `expected_output` is a strong hint, not a validator, and a crew that relies on it alone will eventually ship a report with an empty `source_url` column.

`output_pydantic=Model` gives you `task_output.pydantic` as a validated instance; `output_json=Model` gives `json_dict`. Both are converted from the model's final message, so they inherit every weakness of free-text generation: a model that writes a good paragraph but a malformed list will produce a conversion failure. Keep schemas shallow, give every field a `description`, and test the conversion on adversarial outputs before trusting it downstream.

Guardrails are plain functions that receive the task output and return a tuple — `(True, value)` to accept, `(False, "reason")` to reject. Rejection triggers a retry with the reason appended, up to `guardrail_max_retries` (default 3), after which the task fails. This is the right place for the checks a model cannot do for itself: does the URL resolve, does the total reconcile, is the date in range, is the named entity on the allowlist. A guardrail that only asks another model "is this good?" is a more expensive way to get an opinion.

## Context, ordering and what a task can see

In a sequential process the output of the previous task is threaded into the next one. `context=[research]` adds specific earlier task outputs — necessary when the dependency is not the immediately preceding task, which is common once a crew has more than three steps.

```python
review = Task(
    description="Check each finding against its cited source. Flag claims the source does not support.",
    expected_output="A list of claim/source pairs, each marked supported or unsupported, with a one-line reason.",
    agent=reviewer,
    context=[research],
)

brief = Task(
    description="Write the brief from supported findings only.",
    expected_output="Markdown, max 400 words, two sections, no unsupported claims.",
    agent=writer,
    context=[research, review],
)
```

Two things to notice. First, `context` is declarative data flow, not control flow: it does not change execution order, so a task can reference a task that has not run yet and get nothing. Second, context is appended as text, so a task with three context dependencies pays for all three in its prompt. Wide context is a cost decision as much as a quality decision.

`async_execution=True` lets a task start without blocking the sequence; its output is then only available to tasks that name it in `context`. It is useful for genuinely independent branches, and a source of confusing partial results when used casually.

## Results, files and humans

`crew.kickoff()` returns a `CrewOutput` with `.raw` for the final text and `.tasks_output` for each task's `TaskOutput` — `.raw`, `.pydantic`, `.json_dict`, and the agent that produced it. Persist those: a crew that only returns a string has thrown away the per-step evidence you need to debug it.

`output_file="reports/brief.md"` writes the raw output to disk after the task completes. Treat the path as configuration, never as user input; a `{name}` interpolated into a path is a path-traversal bug waiting for a creative caller.

`human_input=True` pauses the task and prompts on stdin for review. It is a development convenience. In a service, approval belongs in a Flow's human-feedback step or in your own approval queue, where the request can be authenticated and the pause can survive a deploy.

## Common mistakes

- **One giant task.** "Research the market, analyse it and write the deck" produces an unlocalisable failure and a prompt that no one can tune.
- **Unfalsifiable expected outputs.** "High quality", "comprehensive", "professional tone" — none of these can be checked, so none of them will be met consistently.
- **Expecting schema validation from prose.** Only `output_pydantic`, `output_json` and guardrails enforce anything.
- **Depending on task order for data flow.** Use `context`; positional luck breaks the first time someone reorders the list.
- **`human_input=True` in production.** It blocks a worker and cannot be approved by anyone who is not at that terminal.
- **Writing task text that only makes sense with the previous task's prompt in mind.** Write each task as if it will be read alone, because in a retry it will be.

## Production notes

Treat each task as the unit of evaluation: one assertion per task, run against a fixture set, is enough to catch most regressions. Keep tasks small enough that a failure points at one behaviour, and number them in file names so reading order is obvious in review. Store the full `TaskOutput` alongside the run ID, not just the final text. Version task descriptions and expected outputs in git with the code, because a one-word change to an expected output is a behaviour change and should be reviewable as one. And when a task starts needing conditional logic — "if the source is paywalled, do X instead" — that is the signal that the logic belongs in a Flow or in ordinary Python, not in a longer paragraph.
