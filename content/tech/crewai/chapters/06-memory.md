# Memory and Context Sharing Between Agents

"Crew memory" is one of the most overloaded phrases in agent frameworks. In CrewAI it means at least four different mechanisms, and conflating them produces systems that either leak data between users or silently lose the fact you needed.

| Mechanism | Scope | Selected by | Lifetime |
|---|---|---|---|
| Task `context` | Explicit, per task | You, in code | One run |
| Conversation/agent state | One agent's loop | The agent | One task |
| Memory | Crew or agent scope, across tasks and runs | Similarity + recency + importance | Until deleted |
| Knowledge sources | Crew or agent, read-only reference | Retrieval at task time | Until re-indexed |

Only the first is deterministic. The other three are retrieval: something is selected for the prompt by a scoring function, and whatever is not selected effectively does not exist for that call.

## The older four-type vocabulary

For several years CrewAI documented four memory types, and most tutorials and interview questions still use those names:

- **Short-term memory** — recent interaction context within a run, held in a vector store so it can be searched rather than replayed.
- **Long-term memory** — facts and task results retained across runs, typically in a local SQLite store, scored by recency and relevance.
- **Entity memory** — people, companies, projects and their attributes, extracted from text and stored so later tasks can resolve "the client" to a specific record.
- **Contextual memory** — a composite view that combines the above for a given task.

Current documentation describes a **single `Memory` class** that replaces those separate stores, along with external memory integrations. You call `remember()` to store, `recall()` to retrieve, `forget()` to delete, and `extract_memories()` to pull atomic facts out of a longer text. Storage is organised into a hierarchical tree of scopes (`/project/alpha`, `/agent/researcher`), and records are scored by a blend of semantic similarity, recency and importance, with the weights configurable.

Know both vocabularies. The four types explain *why* the feature exists and what interviewers mean; the unified class is what you actually import.

## How it behaves in a crew

```python
from crewai import Crew, Memory

memory = Memory(recency_weight=0.4, semantic_weight=0.4, importance_weight=0.2)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research, write],
    memory=memory,          # or memory=True for defaults
)
```

With memory enabled, the crew extracts discrete facts from each task's output and stores them, then recalls relevant context before each task and injects it into the prompt. Each of those steps is a model or embedding call. Memory is not free: it adds latency and tokens to every task, and it adds a second failure surface — the extraction step can store a wrong fact just as confidently as the writing step can state one.

The default embedder, when none is configured, is an OpenAI embedding model, which means enabling memory quietly adds a provider dependency and a data-egress path for everything the crew processes. Configure the embedder deliberately, especially in regulated environments.

## Scopes are the isolation boundary

A single shared memory across a multi-tenant application is a data breach with extra steps. Scopes exist for this:

```python
crew_memory = Memory()
customer_memory = crew_memory.scope(f"/tenant/{tenant_id}")

support = Agent(
    role="Support agent",
    goal="Resolve the customer's issue using prior context for this account only",
    backstory="You have the account history in front of you and do not speculate beyond it.",
    memory=customer_memory,
)
```

Two rules follow. First, derive the scope from the authenticated request, never from model output or user-supplied text. Second, use `forget(scope=...)` as part of your deletion path — memory is personal data under most privacy regimes, and "it is only a vector store" is not a legal defence.

An agent can also take a private scope (`memory.scope("/agent/researcher")`) while others read the crew's shared memory. That is genuinely useful: a researcher accumulates raw findings privately, and a writer reads only what has been promoted into shared memory.

## Memory is not the system of record

The most common production failure is using memory where a database belongs. Memory is optimised for *plausible relevance*, not for correctness, ordering or transactions. It can return a fact that was true last quarter, alongside one that superseded it, with no indication of which is current.

If a value must be right — an account balance, a contract status, an entitlement, an address — read it from the system of record through a tool at the moment you need it. Use memory for the things that make a conversation feel continuous: preferences, prior decisions, the shape of the last attempt, open questions. A useful test: if being wrong about this fact would require a correction to a customer, it does not belong in memory.

## Knowledge sources are different again

`knowledge_sources` attach reference material — documents, PDFs, CSV rows, text — that is chunked, embedded and made retrievable for a crew or an agent. Unlike memory, it is not written by the run; it is curated by you. Use it for policy documents, product catalogues and style guides, and refresh it when the source changes.

The operational trap is assuming that re-indexing is automatic. It is not: if the source file changes and the collection is not rebuilt, the crew keeps answering from the old text, and no error will tell you.

## Failure modes worth designing against

**Memory poisoning.** Anything a crew reads can be stored as a fact, including instructions embedded in a web page or an email. Because memory is retrieved and injected into future prompts, a single poisoned run can influence later ones. Sanitise what gets stored, and prefer extracting facts with a schema over storing raw text.

**Retrieval noise.** As a scope grows, recall returns more marginally relevant material, and the prompt fills with context that competes with the task. Importance weighting, smaller scopes and periodic pruning help; unlimited growth does not.

**Stale embeddings.** Changing the embedding model invalidates the index's comparability with new queries. Rebuild the collection when you change models, and version the embedder alongside the crew.

**Silent absence.** Recall returning nothing looks exactly like recall returning something unhelpful. Log which memories were injected; without that, "the agent forgot" is undebuggable.

## Common mistakes

- **Assuming agents share a conversation.** They do not; they share what the process and memory explicitly provide.
- **Enabling `memory=True` by default.** It adds cost, latency, an embedder dependency and a privacy surface, and many crews do not need it.
- **Global memory in a multi-tenant app.** One scope per tenant, derived server-side.
- **Storing summaries instead of facts.** Summaries decay into vague statements that retrieve well and inform nothing.
- **Treating knowledge sources as live data.** They are a snapshot; rebuild them.
- **Never deleting.** `crewai reset-memories` exists for local development; production needs a retention policy.

## Production notes

Decide the memory requirement before the crew shape: continuity across runs, personalisation within a session, or none at all. If none, leave it off and pass what you need through task context — it is cheaper and testable. If yes, pin the embedder, isolate scopes per tenant, log recalls, and set a deletion path that includes both memory and any vector index behind it. Evaluate recall separately from generation with a fixture of known questions and expected facts, so a missing answer can be attributed to retrieval rather than blamed on the model. And re-read what actually gets stored after a week of real traffic; the extraction step's output is usually more revealing than any prompt you wrote.
