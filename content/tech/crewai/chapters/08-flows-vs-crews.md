# Flows: Event-Driven Orchestration vs Crews

A crew is a team running a script. A **Flow** is the program that decides which scripts run, in what order, with what happens on failure. Most non-trivial CrewAI systems need both, and the design question is always where the boundary sits.

## What a Flow is

A Flow is a class whose methods are triggered by events. State is typed; transitions are declared with decorators; the run can be persisted and resumed.

```python
from pydantic import BaseModel
from crewai.flow.flow import Flow, listen, start, router
from typing import Literal

class IntakeState(BaseModel):
    ticket_id: str = ""
    request: str = ""
    verdict: str = ""
    draft: str = ""

class IntakeFlow(Flow[IntakeState]):
    @start()
    def load(self):
        self.state.request = fetch_ticket(self.state.ticket_id)

    @router(load)
    def classify(self) -> Literal["answerable", "escalate"]:
        self.state.verdict = triage(self.state.request)   # cheap model call or rules
        return "answerable" if self.state.verdict == "answerable" else "escalate"

    @listen("answerable")
    def draft_with_crew(self):
        result = SupportCrew().crew().kickoff(inputs={"request": self.state.request})
        self.state.draft = result.raw

    @listen("escalate")
    def hand_off(self):
        create_escalation(self.state.ticket_id, self.state.request)
```

The primitives are few:

- `@start()` marks an entry point. Several can exist; all satisfied starts run, often in parallel.
- `@listen(x)` runs when `x` completes — `x` can be a method or a router label.
- `@router(x)` returns a label (`Literal[...]` is how the branches are declared, or `emit=[...]`), and listeners subscribe to labels rather than methods.
- `or_(a, b)` and `and_(a, b)` combine triggers when a step should fire on either or both.
- `self.state` is a dict or Pydantic model, unique per run, with an auto-generated `id`.

## Why Flows exist

Crews cannot express four things that production systems need constantly:

**Branching.** A crew's task list is linear. A Flow can route on a validated value and run a different crew per branch.

**Resumption.** A crew that fails at task four starts again at task one. A persisted Flow resumes from the last completed step, under the same state ID.

**Human approval.** A Flow can pause at a decision point and continue with the human's response — the `@human_feedback` decorator emits labels such as `approved`, `rejected` or `needs_revision`, with a `default_outcome` if no one answers.

**Composition.** A Flow can call several crews, each with its own agents and tools, and thread their outputs through one state object. Crews are then reusable units rather than entire applications.

That last point is the most useful reframing. **A crew is a step.** It has a defined input, a defined output, and an internal process you do not want to see from outside. A Flow is the place where the interesting control flow lives, in Python, where you can read it and test it.

## The comparison that matters

| Property | Crew | Flow |
|---|---|---|
| Control flow | Linear task list; manager in hierarchical mode | Explicit, code-driven, branching and loops |
| Who decides the next step | The process, or a manager model | You |
| State | Task outputs threaded as text | Typed `self.state` per run |
| Resumption | None | `@persist`, resume or fork by state ID |
| Human approval | `human_input=True` on a task (stdin) | `@human_feedback` with labels |
| Failure handling | The run raises | You catch, route and retry per step |
| Cost visibility | Per crew and per task | `flow.usage_metrics` across every call, including crews |
| Best fit | Multi-role work with a known sequence | Orchestration, approvals, retries, multiple crews |

Note what does not appear: loops inside a crew. A Flow can loop by routing back to an earlier step, which is how "rejected draft goes back for revision" is implemented without moving to another framework.

## Persistence: resume versus fork

`@persist` can decorate a Flow class (all methods) or a single method. The default implementation uses SQLite, and the persistence layer is pluggable.

```python
from crewai.flow.persistence import persist

@persist
class IntakeFlow(Flow[IntakeState]):
    ...
```

Two kickoff modes behave differently and are easy to confuse:

- `kickoff(inputs={"id": existing_uuid})` **resumes** — it loads the latest snapshot for that ID and continues writing history under the same flow UUID.
- `kickoff(restore_from_state_id=existing_uuid)` **forks** — it hydrates a new run from that snapshot and assigns a fresh state ID, leaving the original history intact.

Resume is for recovering a failed run. Fork is for "run this again from the same starting point with a change" — a replay for debugging, or a re-run after a bug fix. Choosing the wrong one either duplicates history or loses the ability to compare runs.

Persistence also creates the sharpest correctness question in the whole framework: **what happens if the process dies after a step performed an external side effect but before the state was saved?** The step will run again. Any step that sends an email, charges a card or creates a record must be idempotent, keyed by something stable in the state — not by a fresh UUID generated on each attempt.

## Where Flows stop

A Flow is not a workflow engine. It has no cron, no distributed workers, no durable timers, no retry policy for infrastructure failures, and no compensation/rollback. Persistence is a snapshot of state, not a transactional log with exactly-once semantics.

If you need scheduled runs, cross-service retries, or work that survives a cluster failure, put the Flow inside a real orchestrator — a queue with a worker, Airflow, Temporal, or a job runner — and treat the Flow as the LLM-shaped step. The common mistake is the reverse: stretching Flows until they are a bad scheduler.

## Anti-patterns

- **One giant Flow method.** If a method calls three models and two crews, you have written a crew with extra steps and lost the trace.
- **State as a dumping ground.** Store decisions and identifiers, not entire API responses. State is serialised on every persist.
- **Crews nested inside crews.** A crew step that internally kicks off another crew is invisible to the enclosing trace and multiplies cost unpredictably.
- **Routing on unvalidated model output.** Parse the model's answer into a constrained enum before it reaches `@router`; a label typo silently breaks a branch.
- **Assuming a resumed run is a fresh run.** Side effects already happened; check what the state says was done.

## Common mistakes

- Using a crew where a Flow with one task would do — or the reverse, wrapping a two-step pipeline in a Flow class.
- Forgetting that a Flow's state ID is created automatically, then wondering why resume finds nothing.
- Treating `@persist` as a transaction log.
- Putting an approval step behind `human_input=True` and discovering no one is at the terminal.
- Ignoring `flow.usage_metrics`, the cheapest cost signal in the framework.

## Production notes

Draw the boundary once and keep it: Flows own control flow, validation, approvals and persistence; crews own role-based work with a known internal sequence. Keep each Flow method small enough to unit-test with the state as input. Persist with a real database backend before production, version the state model, and treat a schema change as a migration. Log the flow ID on every downstream side effect so a resume can be reconciled against what actually happened. And measure per step: `flow.usage_metrics` tells you the total, but only per-step timing and token counts tell you which crew is eating the budget.
