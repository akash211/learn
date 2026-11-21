# Migration Realities and Choosing an Abstraction

The most useful thing to know about LangChain is that its API has been rewritten, substantially, about once a year. That is not a scandal — the problem domain moved faster than any abstraction could settle — but it changes how you should adopt it: keep the dependency narrow, keep your prompts and parsing in your own code, and expect to do a migration.

## Package topology

| Package | Contains | Stability |
|---|---|---|
| `langchain-core` | Runnables, messages, prompts, parsers, tools, retrievers | Most stable; the compatibility floor |
| `langchain` | Orchestration, `create_agent`, chain helpers | Moves between minor versions |
| `langchain-classic` | Legacy chains, `AgentExecutor`, old index APIs (v1) | Frozen; use only for migration |
| `langchain-community` | Third-party loaders, stores, deprecated integrations | Uneven; often behind upstream |
| `langchain-openai`, `-anthropic`, `-google-genai`, … | Provider adapters | Tracks the provider SDK |
| `langsmith` | Tracing and evaluation client | Independent versioning |
| `langgraph` | Stateful graph runtime | Own release cadence |

The practical rule: **depend on `langchain-core` directly, depend on a partner package for your model, and avoid `langchain-community` in production** where a dedicated package exists. Community integrations are the single largest source of unexplained breakage, because they wrap libraries that changed their own APIs.

## The churn, briefly

| Era | What changed | What broke |
|---|---|---|
| 0.0.x | One monolithic package | Everything later |
| 0.1 (early 2024) | Split into `core`, `community`, partner packages | Import paths moved; `langchain.llms` shrank |
| 0.2 (mid 2024) | Provider packages required; LCEL the recommended path | `langchain[openai]` extra; old chain imports deprecated |
| 0.3 (late 2024) | Pydantic 2 required, Python floor raised | v1 Pydantic models, `.dict()` calls |
| 1.0 (late 2025) | `create_agent` on LangGraph; legacy chains → `langchain-classic`; `langchain.memory` removed | `AgentExecutor`, memory classes, `initialize_agent` |

Two consequences. First, any tutorial older than about eighteen months is a description of a different library; check the import paths before believing the code. Second, a deprecation warning in LangChain is a scheduled removal, not a suggestion — the deprecation window has historically been one or two minors.

Concrete migrations you will likely perform:

- `ConversationBufferMemory` → `RunnableWithMessageHistory` or a graph checkpointer (chapter 4).
- `AgentExecutor` + `create_react_agent` → `create_agent`, or a LangGraph graph you control.
- `langchain.document_loaders` → the dedicated package (`langchain-community`, `langchain-text-splitters`, or a loader library you call yourself).
- `chain.run(...)` → `chain.invoke(...)`.
- `PydanticOutputParser` everywhere → `with_structured_output` where the provider supports it.

## Pinning strategy

```
langchain-core==1.*        # explicit floor and ceiling
langchain==1.*
langchain-openai==1.*
# no langchain-community unless a specific loader is required, pinned exactly
```

Rules that have held up:

- **Pin `langchain-core` explicitly.** It is the shared dependency of every other package; letting it float means two partner packages can resolve to incompatible assumptions.
- **Pin exactly in production, constrain in libraries.** A library should allow a range; an application should lock.
- **Upgrade on a schedule, not on a whim.** Batch LangChain upgrades behind the eval suite (chapter 9), because the failure mode is behavioural, not an ImportError.
- **Read the release notes for removals only.** Feature lists matter less than the "deprecated → removed" table.
- **Test the import surface, not just behaviour**: a smoke test that imports every LangChain symbol the app uses catches the rename class of breakage instantly.

## The decision table

| Situation | Choose | Why |
|---|---|---|
| One model call in one place | Provider SDK | Zero abstraction tax; full access to new parameters on day one |
| Two or three calls, one vendor, no streaming | Provider SDK or plain functions | A framework adds a failure surface and a stack frame |
| Linear pipeline, 4+ steps, needs streaming + tracing | LangChain LCEL | Composition, config propagation, one code path for sync/async/stream |
| Swap providers per environment or per tenant | LangChain model adapters | The one abstraction with clear, immediate payoff |
| Document ingestion + retrieval at scale | LangChain retrieval or LlamaIndex | Splitter/retriever interfaces and a large integration catalogue |
| Branching, retries per step, human approval, resumable runs | LangGraph | Explicit state, checkpointers, interrupts; LangChain agents already run on it |
| Single agent with typed outputs and injected dependencies | PydanticAI | Less surface, Pydantic-native validation, no retriever plumbing you do not need |
| Deterministic, auditable workflow with strict compliance needs | Plain Python + SDK | Every step visible in code review; no hidden prompt assembly |

A useful heuristic: count the things you need that LangChain actually provides. If the answer is "the message schema and one prompt template", use the SDK. If it is "streaming, tracing, batching, provider swapping, retrieval adapters", the abstraction is paying for itself.

## What the abstraction costs

Each layer adds failure modes that do not exist in the SDK:

- **Hidden prompt assembly.** The final string sent to the model is produced by templates, partials and history — not visible in your source. Snapshot tests fix this; nothing else does.
- **Provider feature lag.** A parameter released this week may not be exposed by the adapter for a month. Escape hatches exist (`model_kwargs`, `extra_body`, `bind`), but using them means you are no longer portable, which was the point.
- **Version coupling.** `langchain-core` upgrades ripple through partner packages and community integrations.
- **Error indirection.** A provider 400 arrives wrapped in a runnable stack, sometimes as a different exception class after a version bump.

Design so you can leave: keep prompts as data (files or constants, versioned), keep parsing and business validation in functions that take a string and return your domain object, and keep chain definitions thin adapters at the edge. Then replacing LangChain means rewriting those adapters, not the application.

## Migration playbook

1. **Inventory imports.** `grep -r "from langchain" --include=*.py` grouped by module. Anything from `langchain.chains`, `langchain.memory`, `langchain.llms` is a migration task.
2. **Freeze behaviour first.** Add the snapshot tests and a small eval set *before* upgrading, or you cannot tell an upgrade regression from an existing bug.
3. **Upgrade `langchain-core` with its partners together**, in one commit, and run the eval suite. Do not stagger partner packages across weeks.
4. **Replace, do not port.** `AgentExecutor` → `create_agent` is not a rename; the state model, callbacks and streaming semantics differ. Read the tracing output rather than assuming equivalence.
5. **Delete the compatibility shims** once green. They are the thing that makes the *next* migration expensive.

## Common mistakes

- Pinning `langchain` but not `langchain-core`.
- Depending on `langchain-community` for a provider that has a partner package.
- Upgrading mid-sprint because a new feature looked useful.
- Building the whole product inside `langchain.chains` abstractions, then discovering v1 removed them.
- Treating a deprecation warning as noise for a year.
- Assuming a working prototype proves the abstraction is right at production volume.

## Production notes

Record the exact resolved versions of every LangChain package in the lockfile and in your deployment metadata — when behaviour changes without a code change, that list is the first thing to diff. Keep an `evals/` gate wired to dependency updates. And write down the exit plan while the abstraction is still new: which files are LangChain-specific, what the SDK equivalent of each step is, and how long the swap would take. Teams that do this survive the churn; teams that do not spend a quarter on it eventually.
