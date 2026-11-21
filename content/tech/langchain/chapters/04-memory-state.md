# Memory and Conversation State

Chat models are stateless. Every "memory" feature in every framework is a wrapper that appends messages to a list and resends them. Understanding that removes most of the mystery — and most of the cost surprises, because conversation state is the main reason token usage grows quadratically in a long session.

## The mechanism

```python
turn 1: send [system, user1]              -> assistant1
turn 2: send [system, user1, assistant1, user2] -> assistant2
turn 3: send [system, user1, assistant1, user2, assistant2, user3]
```

Nothing is remembered server-side unless the provider offers a conversation API; with the standard chat-completions interface you resend the transcript. A tenth-turn request carries nine turns of history, and a fifty-turn call centre conversation will exceed the context window or the budget long before it exceeds the model's patience.

## The memory classes are gone — treat them as history

`ConversationBufferMemory`, `ConversationSummaryMemory`, `ConversationBufferWindowMemory` and `ConversationEntityMemory` were the original answer. They are deprecated, and in v1 `langchain.memory` was removed, with no like-for-like replacement in `langchain-classic`. This is a good example of the churn to plan around: code copied from a 2023 tutorial will import something that no longer exists.

Two patterns replaced them.

### RunnableWithMessageHistory

```python
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.runnables.history import RunnableWithMessageHistory

store: dict[str, InMemoryChatMessageHistory] = {}

def get_history(session_id: str):
    return store.setdefault(session_id, InMemoryChatMessageHistory())

chat = RunnableWithMessageHistory(
    prompt | model | StrOutputParser(),
    get_history,
    input_messages_key="input",
    history_messages_key="history",
)

chat.invoke(
    {"input": "and the second one?"},
    config={"configurable": {"session_id": "user-42:conv-7"}},
)
```

The template must contain a `MessagesPlaceholder(history_messages_key)`. `RunnableWithMessageHistory` loads history before the call, appends the user message, invokes, then appends the AI response. `InMemoryChatMessageHistory` is per-process: it disappears on restart and is not shared between workers, so it is a development convenience, never production storage.

### Graph checkpointers

LangGraph's checkpointer persists the full state of a conversation — messages plus whatever else the graph carries — keyed by `thread_id`. `InMemorySaver` for tests, `SqliteSaver` for a single node, `PostgresSaver` for anything real. This is the direction the ecosystem moved: state belongs to the orchestration layer with an explicit schema, not to a "memory" object attached to a chain.

```python
from langgraph.checkpoint.memory import InMemorySaver

graph = builder.compile(checkpointer=InMemorySaver())
graph.invoke({"messages": [("user", "hello")]}, config={"configurable": {"thread_id": "conv-7"}})
```

Checkpointers also give you resumption after a crash and time travel to a prior state, which no message-list wrapper can offer.

## Trimming, summarising, and what they cost

Long conversations need a policy, and there are only three:

| Policy | How | Cost | Risk |
|---|---|---|---|
| Window | Keep last N messages or tokens | Cheap, bounded | Silently forgets the requirement stated at turn 2 |
| Summary | Replace old turns with an LLM summary | One extra call per compaction | Summary drift; details lost that later matter |
| Retrieval over history | Embed past turns, retrieve relevant ones | Indexing + retrieval complexity | Misses conversational flow |

```python
from langchain_core.messages import trim_messages

trimmed = trim_messages(
    messages,
    max_tokens=2000,
    strategy="last",
    token_counter=model,
    start_on="human",
    include_system=True,
)
```

`include_system=True` is not optional in practice: dropping the system prompt to save tokens changes the assistant's behaviour mid-conversation in ways users notice. `start_on="human"` prevents orphaned assistant or tool messages.

Summarisation has a specific hazard: summarise before you compress tool output, or you will spend thousands of tokens summarising a JSON blob. Strip, truncate, or structurally reduce tool results first.

## Structural integrity of the message list

Providers validate the transcript, and the rules are stricter than they look:

- An `AIMessage` with `tool_calls` must be followed by a `ToolMessage` for **each** call id, before the next human turn. Trimming mid-pair produces a 400 from the provider with a message that does not mention your trimming code.
- Some providers reject two consecutive messages of the same role; others merge them. Normalise before sending if you support multiple vendors.
- `SystemMessage` position matters: most providers accept it only at the start.

So any trimming implementation must operate on *turns*, not raw list slices, and must never split a tool-call group.

## Session identity is a security boundary

`session_id` is usually read from `config["configurable"]`. If it comes from a request body without validation, one user can pass another user's id and read their history — a cross-tenant data leak with no exotic cause. Derive the key from the authenticated principal plus a conversation id, and authorise the conversation against the principal before loading anything.

The same applies to storage: history contains whatever the user typed, which routinely includes PII, credentials pasted by accident, and internal data the model echoed back. Give it a retention period, encrypt it at rest like any other user data, and make deletion possible — "delete my conversation" is a data-subject request, not a cache invalidation.

## Persistence details that matter later

- **Write after response, not before.** If you persist the assistant message before the client receives it, a retried request can duplicate turns. Make writes idempotent on a message id.
- **Store structured messages, not rendered strings.** You will want to change the template without corrupting old history.
- **Version the schema.** Message metadata, tool calls and content blocks evolve; a JSON column with no version field becomes unreadable.
- **Bound the row.** An unbounded message blob per conversation turns every history read into a large transfer. Cap the number of stored turns and archive the rest.

## When to compact

Compaction policy is a product decision disguised as a technical one. Compact on a token threshold, not on turn count — a turn with a long pasted document costs more than twenty short exchanges. Compact *before* the call that would exceed the window, and always keep the most recent exchange intact, because that is what the user is actually talking about. Record in the stored history that compaction happened, so a later reader knows the transcript is lossy; a summary presented as a verbatim log is worse than no summary, because it invites false confidence about what was said.

## Common mistakes

- Using `InMemoryChatMessageHistory` in production and losing every conversation on deploy.
- Passing a joined string into `MessagesPlaceholder`, which degrades quality without erroring.
- Trimming raw lists and splitting `tool_calls` from their `ToolMessage`s.
- Trusting a client-supplied `session_id`.
- Summarising before truncating tool output.
- Believing the model "remembers" anything you did not resend.

## Production notes

Pick state storage at design time: message list in your database, `RunnableWithMessageHistory` for a single-process service, or a checkpointer when the workflow must resume. Log token count per turn so growth is visible before it is an incident. Test trimming with a synthetic 60-turn conversation including a tool-call pair at the boundary — that test catches the class of bug that only appears after a real user has been chatting for an hour.
