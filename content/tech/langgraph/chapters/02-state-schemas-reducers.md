# State Schemas and Reducers

A LangGraph state schema is the contract shared by nodes in a graph. It describes the named channels that nodes may read and update, and—in some cases—the rules for combining concurrent or incremental updates. Schema design is therefore not clerical typing. It determines which facts survive from one step to the next, how parallel work merges, and what a saved checkpoint must be able to represent.

The most common schema is a `TypedDict`. It gives Python static tooling a clear shape without requiring that every update construct a full object. A node can read `state["question"]` and return `{"answer": ...}`. Keys that it does not return remain as they were. By default, a value returned for an existing key replaces its previous value. That is usually right for fields such as `status`, `decision`, or `current_draft`.

```python
from typing_extensions import TypedDict

class State(TypedDict):
    question: str
    answer: str
    attempts: int

def answer_node(state: State) -> dict:
    return {"answer": f"A short answer to: {state['question']}"}
```

A node's return value is a state update, not necessarily the new complete state. Returning `{"answer": "..."}` preserves `question` and `attempts`; returning an empty mapping changes nothing. This makes node ownership legible. It also means that a typo in a key may go unnoticed at runtime unless your tests, type checks, or validation catch it. Treat state names as an API and use explicit types and tests.

## Reducers define merge semantics

A reducer receives the current channel value and the update from a node, and returns the new value. Attach it to a schema field with `Annotated`. If no reducer is specified, the effective behavior is replacement. Reducers matter when multiple nodes in a super-step write the same key, or when a node adds a piece to an accumulated channel.

A common example is append-only messages or observations. `operator.add` combines lists by concatenation:

```python
import operator
from typing import Annotated
from typing_extensions import TypedDict

class ResearchState(TypedDict):
    question: str
    notes: Annotated[list[str], operator.add]

def collect_note(state: ResearchState) -> dict:
    return {"notes": [f"Look up: {state['question']}"]}
```

The returned list is a delta, not a replacement for all prior notes. The reducer combines it with the current list. This is distinct from ordinary fields where returning a new value overwrites the old one. If several parallel workers append results, the reducer provides a merge operation for the channel. Do not assume a particular ordering of concurrently produced values unless your workflow and reducer make that ordering explicit.

Reducers should be associative where possible, and their behavior should be safe when multiple updates are merged. A concatenating list reducer is straightforward but grows without bound if the workflow keeps adding data. A dictionary merge may overwrite conflicting keys and so needs an explicit conflict policy. A custom reducer can deduplicate by stable identifiers, but it must be deterministic and have well-defined behavior for each pair of values. State updates are not a substitute for a transaction across external databases.

`add_messages` is a message-aware reducer used in conversational graphs. It can append new messages and handle updates to existing messages by ID. This is often preferable to `operator.add` for message state, where replacing a prior message or maintaining message identity matters. In newer LangChain message APIs, messages can be represented as message objects or supported message-like inputs; keep the chosen representation consistent and avoid treating message history as an arbitrary list of strings.

## Separate input, internal state, and output

A single schema is adequate for simple graphs. Larger workflows often benefit from distinct input and output schemas, with an internal state that includes extra working fields. For example, an API may accept a user question but keep retrieved documents and a confidence score internal. The input contract should not force callers to populate internal bookkeeping fields.

LangGraph allows a full state schema alongside input and output schemas. This is useful for defining a narrow boundary, but it is not a security mechanism by itself. Internal fields may still be visible through traces or streaming modes depending on how the application is configured. Avoid placing secrets or unnecessary personal data in graph state. A state key is an explicit data channel, not a private vault.

Choose schema tools based on the need. `TypedDict` is concise for mapping-shaped state and is a common default. A dataclass can provide defaults and clearer attribute-oriented semantics. Pydantic can add validation at boundaries in applications that need it, though model and API compatibility should be checked against the installed LangGraph version. Regardless of representation, validation of untrusted input should occur before that input drives tools or consequential routing.

## Designing state as a durable interface

Once a graph is compiled with a checkpointer, state may outlive the Python process and remain in storage across deployments. That changes how to think about a field. It should have a stable meaning, a deliberate size, and a migration story. Use explicit statuses or enums rather than ambiguous booleans such as `done`, whose meaning can change as a workflow grows. Store identifiers and compact summaries when a large object can be fetched from a system of record.

Do not store runtime-only objects—open connections, callbacks, model instances, file handles, or credentials—in serializable state. Pass dependencies through runtime context or construct them in the process. Checkpoint state is application data: it needs access control, retention, and privacy review. Every additional field can increase persistence footprint and expose another piece of user information to traces.

Runtime context is separate from graph state. Context is appropriate for dependencies or invocation-time configuration such as a tenant-scoped repository, a selected model family, or a policy version. State is appropriate for values the workflow computes, updates, and may need to resume. Do not smuggle large or secret configuration into a checkpoint merely because it is convenient for a node to access.

## Worked state example: parallel evidence collection

Here is a compact schema for workers that collect independent evidence snippets. The parent state has a list of search topics and an accumulated `evidence` channel. A real graph can fan out with `Send`; each worker returns one evidence item and the reducer appends it. The example below focuses on the state contract so that the merge semantics are easy to see.

```python
import operator
from typing import Annotated
from typing_extensions import TypedDict

class EvidenceState(TypedDict):
    question: str
    evidence: Annotated[list[str], operator.add]

def source_a(state: EvidenceState) -> dict:
    return {"evidence": [f"Source A considered: {state['question']}"]}

def source_b(state: EvidenceState) -> dict:
    return {"evidence": [f"Source B considered: {state['question']}"]}
```

Each worker returns only a one-element list. With a reducer, updates combine with existing `evidence`; without it, an update would replace the list. If the workers run in parallel, do not make correctness depend on which source happens to appear first. If stable ordering is required, include source identifiers and sort in a later node. If results can be duplicated across retries, deduplicate by an idempotency key or use a keyed merge reducer. The graph state can hold findings, but source retrieval and citation verification remain responsibilities of the application.

## Common mistakes

- **Using replacement where accumulation was intended.** Without a reducer, a later list replaces an earlier list; test this explicitly.
- **Using append semantics for a current-value field.** Appending drafts or status values creates confusing history; use a separate history channel if history is desired.
- **Assuming list order means causal order.** Parallel work can finish in different orders; encode order or sort deliberately.
- **Making state a dumping ground.** Large documents, raw API responses, and secrets inflate checkpoints and increase data exposure.
- **Changing a persisted field's meaning without migration.** Old checkpoints may be read by newer code long after deployment.

## Production notes

For every field, document its owner, reducer, maximum expected size, sensitivity, and whether it is part of public input or output. Add tests that apply multiple updates and verify the reducer result, including empty and duplicate updates. For concurrent writes, prefer reducers that are deterministic and whose merge behavior is understood. A reducer is part of the correctness model: changing it can change what old state means even if the schema's type annotation remains identical.
