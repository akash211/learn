# Core Abstractions and the LCEL Composition Model

LangChain is usually introduced as an agent framework. It is better understood as a set of interfaces with adapters bolted on. The interfaces live in `langchain-core` and have been remarkably stable; the adapters and convenience wrappers around them are what keep changing. Learning where that line falls is most of the skill.

## The part that is actually stable

`langchain-core` defines chat models, messages, prompt templates, output parsers, tools, retrievers, documents, and one execution protocol — the Runnable. Everything else is either an adapter to a third-party library (a vector store, a document loader, a provider SDK) or a convenience function built on top of those protocols.

That split matters for upgrades. A `ChatOpenAI` instance, a `ChatPromptTemplate`, and a `StrOutputParser` will compose in roughly the same way in any recent version. `load_qa_chain`, `ConversationBufferMemory`, `AgentExecutor` and most `langchain.chains.*` classes have been deprecated, moved to `langchain-classic`, or deleted. If a tutorial imports from `langchain.chains` or `langchain.memory`, its date is showing.

## Chat models and messages

A chat model object wraps a provider's HTTP API behind one interface. You give it a list of messages and it returns one message.

```python
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

model = ChatOpenAI(model="gpt-4.1-mini", temperature=0, timeout=30, max_retries=2)
reply = model.invoke([
    SystemMessage("You answer in one sentence."),
    HumanMessage("Why is the sky blue?"),
])
print(reply.content)
print(reply.usage_metadata)      # input_tokens / output_tokens / total_tokens when provided
```

`reply` is an `AIMessage`, not a string. It carries `content`, `tool_calls`, `usage_metadata`, `response_metadata`, and an `id`. `content` is a string for plain text and a *list of content blocks* when the provider returns images, reasoning blocks, citations, or cached-prefix markers. Code that assumes `str` works until the day you switch to a reasoning model, then fails on `.split()`.

`response_metadata` is provider-specific and undocumented in the generic layer. Use it for debugging, never for control flow; provider libraries change those keys without warning.

Model parameters are not portable. `temperature`, `max_tokens`, `stop` and tool binding are broadly common; reasoning effort, safety settings, cached content and logprobs are not. `model.bind(temperature=0.2)` attaches call-time kwargs and returns a new runnable — the useful pattern when one chain must run at two settings:

```python
strict = model.bind(temperature=0)
creative = model.bind(temperature=0.9)
```

`init_chat_model("openai:gpt-4.1-mini")` resolves the class from a string, which is how you make the provider a configuration value rather than an import. It is convenient and it also means an import error becomes a runtime error, so validate the string at startup.

## Prompt templates

An f-string produces a string. A `ChatPromptTemplate` produces a validated list of messages, supports a placeholder for conversation history, composes with `.partial()`, and can be inspected before any tokens are spent.

```python
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a terse technical editor. Reply with the rewrite only."),
    MessagesPlaceholder("history", optional=True),
    ("human", "Rewrite this for a senior engineer:\n\n{draft}"),
])
```

Behaviour worth knowing:

- Input variables are discovered from the template; a missing key raises before the network call, which is the cheapest possible failure.
- `MessagesPlaceholder` requires a *list of messages*, not a string. Passing `"\n".join(history)` is a common bug that silently degrades quality instead of erroring.
- `.partial(draft=...)` freezes a value and returns a new template — useful for per-tenant system prompts.
- `prompt.invoke({...})` returns a `PromptValue`, not a string. Call `.to_messages()` or `.to_string()` when you need the concrete form; printing a `PromptValue` shows a `repr`, which confuses people debugging prompts.

## Output parsers

A chat model returns a message; most downstream code wants data. Parsers bridge that gap and are themselves Runnables.

| Parser | Use it for | Failure mode |
|---|---|---|
| `StrOutputParser` | Text out of `.content` | None — but loses structure |
| `JsonOutputParser` | JSON without a fixed schema, streamable partials | Raises on invalid JSON |
| `PydanticOutputParser` | Typed objects from models without native structured output | Requires injecting `format_instructions` into the prompt |
| `CommaSeparatedListOutputParser` | Trivial list extraction | Breaks on any comma inside an item |

`PydanticOutputParser` is the one people reach for first and should reach for last: it works by asking the model politely to emit JSON, then validating afterwards. When the provider supports native structured output, `with_structured_output(Model)` is more reliable and streams better (chapter 5). Parser failures raise `OutputParserException`, not `ValueError` — catch the specific class, because a bare `except Exception` around a chain hides provider outages as "bad JSON".

## Runnables and the pipe operator

The Runnable protocol is the composition contract: `invoke`, `batch`, `stream`, plus async equivalents and `astream_events`. Objects that implement it can be piped into each other.

```python
chain = prompt | model | StrOutputParser()

chain.invoke({"draft": "we gotta make it faster"})
list(chain.stream({"draft": "we gotta make it faster"}))   # str deltas, not one blob
chain.batch([{"draft": a}, {"draft": b}], config={"max_concurrency": 4})
```

`a | b` calls `a.__or__(b)` and builds a `RunnableSequence`. Bare dicts and plain functions are coerced: a dict becomes a `RunnableParallel`, a callable becomes a `RunnableLambda`. That coercion is convenient and is also where chains become opaque — a stack trace through four lambdas tells you nothing.

What the pipe preserves:

- **Streaming.** `RunnableSequence.stream` feeds chunks through each step. `StrOutputParser` yields per-chunk strings, so the list above really is incremental.
- **Batching.** `batch` maps over inputs with bounded concurrency, so the provider sees parallel requests without you writing a pool.
- **Config propagation.** `config={"callbacks": [...], "tags": [...], "metadata": {...}, "max_concurrency": n}` is passed down to every nested runnable, including tools invoked inside a model call. This is how tracing works at all.

What it destroys:

```python
# Do not do this
chain = prompt | (lambda x: model.invoke(x)) | StrOutputParser()
```

The lambda hides a full model call from the runtime. `stream` now yields exactly one chunk at the end, `batch` no longer parallelises the model calls, and the trace shows one opaque `RunnableLambda` instead of a chat-model run with token counts. Lambdas are an escape hatch that silently removes the properties you composed the chain to get.

Fan-out uses `RunnableParallel`, written as a dict:

```python
rag = (
    {"context": retriever | format_docs, "question": RunnablePassthrough()}
    | prompt
    | model
    | StrOutputParser()
)
```

`RunnablePassthrough.assign(...)` is the other workhorse: it adds keys to the incoming dict without dropping existing ones, which is how state accumulates in a linear chain without a mutable context object.

## What the abstractions do not do

- **No type checking between steps.** `input_schema` and `output_schema` exist for introspection; a dict with the wrong keys reaches the prompt and fails there.
- **No implicit retries.** `with_retry()` and `with_fallbacks()` are opt-in wrappers with their own semantics.
- **No cycles.** A `RunnableSequence` is a DAG; loops belong to LangGraph or to your own `while`.
- **No persistence.** Nothing survives the process.
- **No cost control.** Token counts are reported, not enforced.

## Common mistakes

- Treating `AIMessage.content` as always a string.
- Hiding model calls in `RunnableLambda`, then wondering why streaming stopped working.
- Building a twelve-step chain when four steps plus ordinary Python would be easier to debug.
- Expecting `|` to run steps in parallel. It is sequential unless you use `RunnableParallel`.
- Believing an output parser enforces a schema on the model. It validates what arrived, after you paid for it.

## Production notes

Pin `langchain-core` explicitly and treat it as the compatibility floor for every other LangChain package. Keep chains shallow — three to five steps — and push side effects into tools or service functions that can be tested without a model. Snapshot the *rendered* prompt in tests (`prompt.format_messages(...)`), not the template source, because that is what the model sees. Every time a chain grows a branch, a retry policy, or a loop, ask whether it has outgrown LCEL.
