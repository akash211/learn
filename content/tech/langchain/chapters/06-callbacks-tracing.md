# Callbacks, Tracing, and LangSmith

A chain that makes four model calls and a retrieval is not observable by reading its source. You need to see the tree: what went in, what came out, how long each step took, how many tokens it cost, and which one failed. LangChain's answer is the callback system, and LangSmith is the hosted backend built on it.

## How callbacks work

Every runnable emits lifecycle events: `on_chain_start`, `on_chain_end`, `on_chain_error`, `on_chat_model_start`, `on_llm_new_token`, `on_tool_start`, `on_tool_end`, `on_tool_error`, `on_retriever_start`, and so on. A handler subclasses `BaseCallbackHandler` and implements the ones it cares about.

```python
import time
from langchain_core.callbacks import BaseCallbackHandler

class TimingHandler(BaseCallbackHandler):
    def __init__(self):
        self.starts = {}

    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        self.starts[run_id] = time.perf_counter()

    def on_llm_end(self, response, *, run_id, **kwargs):
        elapsed = time.perf_counter() - self.starts.pop(run_id, time.perf_counter())
        usage = getattr(response, "llm_output", None) or {}
        tokens = usage.get("token_usage", {})
        print(f"model run {run_id} {elapsed:.2f}s in={tokens.get('prompt_tokens')} out={tokens.get('completion_tokens')}")
```

Handlers are attached three ways, in increasing scope:

```python
chain.invoke(inputs, config={"callbacks": [handler]})        # one call
chain = chain.with_config({"callbacks": [handler]})          # everywhere this chain goes
# or set env LANGSMITH_TRACING=true / LANGCHAIN_TRACING_V2=true for the global tracer
```

`with_config` is the one teams underuse. Retry policies, tags, metadata and callbacks belong on the chain definition so that every caller — CLI, API handler, batch job — is instrumented identically.

Handler behaviour worth knowing: an exception raised inside a handler is logged rather than propagated in current versions, but do not depend on that. Handlers run inline, so a handler that makes an HTTP call per token event will dominate your latency. Buffer and flush.

## Config as the carrier

`RunnableConfig` is passed down through every nested runnable, which makes it the natural place for cross-cutting context:

```python
config = {
    "run_name": "answer_question",
    "tags": ["prod", "tenant:acme", "rag-v4"],
    "metadata": {"conversation_id": "conv-7", "tenant": "acme", "prompt_version": "2026-03-01"},
    "callbacks": [handler],
    "max_concurrency": 4,
}
chain.invoke({"question": q}, config=config)
```

Tags and metadata are what make traces searchable; `run_name` is what makes them readable. A production trace showing `RunnableSequence → RunnableSequence → RunnableSequence` is nearly useless, while `retrieve → build_context → answer` tells you in one glance where the two seconds went.

Inside a tool, you receive the config as a parameter instead:

```python
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

@tool
def lookup_order(order_id: str, config: RunnableConfig) -> str:
    tenant = config["metadata"]["tenant"]   # the user's tenant, not model-supplied
    ...
```

That is the safe way to get request identity into a tool: from config, set by your code, rather than from an argument the model can invent.

## LangSmith

LangSmith is a hosted trace store plus dataset and evaluation tooling. Enable it with environment variables:

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=...
export LANGSMITH_PROJECT=checkout-assistant
# older name still honoured: LANGCHAIN_TRACING_V2=true, LANGCHAIN_API_KEY
```

The environment-variable rename from `LANGCHAIN_*` to `LANGSMITH_*` is itself a small illustration of the ecosystem's churn: both names have been accepted for a long transition, and copy-pasted setup instructions are split roughly evenly between them.

What it gives you that logs do not:

- The full run tree with inputs, outputs, latency and token counts per node, including nested tool calls.
- Prompt versioning and diffing across runs.
- Datasets, experiments and evaluators (chapter 9), so evaluation lives beside the traces that motivated it.
- Feedback attached to specific runs, from users or from judges.

What it costs: prompts and outputs leave your infrastructure. For regulated data that is often disqualifying unless you redact before sending, self-host, or use it only on synthetic traces. LangSmith supports self-hosting and a `hide_inputs` / `hide_outputs` style of masking on the client, but redaction is your responsibility — a handler-side `before_send` hook is the place to enforce it, and it must be tested, because a missed field is a data breach with a support ticket attached.

Alternatives worth considering: OpenTelemetry instrumentation (`openinference-*`, `opentelemetry-instrumentation-langchain`) if your organisation already has a tracing backend; or a 60-line custom handler writing JSON lines to your existing log pipeline, which is genuinely sufficient for many teams and has no vendor dependency.

## What to instrument

| Signal | Why | Where |
|---|---|---|
| Per-step latency | Find the 2 s retrieval | `on_chain_end` timings |
| Token in/out per run | Cost attribution per tenant | `on_llm_end` usage |
| Tool name + args + result | Debug wrong actions | `on_tool_start/end` |
| Retriever doc ids + scores | Separate retrieval from generation failure | `on_retriever_end` |
| Parse failures | Prompt/schema drift | `on_chain_error` |
| Time to first token | Perceived latency | `on_llm_new_token` |

The retriever row is the one people omit and later need most. When an answer is wrong, the first question is always "what did retrieval return?" — and without that logged, you cannot answer it after the fact.

One more signal worth carrying: the correlation id from your web layer. Put it in `metadata` at the entry point and every nested run inherits it, which is what lets you join a user's support ticket to the trace and to the application logs without guessing timestamps.

## Cost and cardinality

Two failure modes when instrumentation goes wrong:

- **Trace explosion.** Every token event as its own span, every batch item as a separate trace, no sampling. You pay for storage and learn nothing extra.
- **PII in traces.** Full prompts containing customer emails, addresses, card fragments. The trace store becomes a second, unaudited copy of your most sensitive data.

Sample the batch path, redact at the handler, and set retention explicitly. For high-volume classification, trace 1–5% and keep aggregate metrics for the rest.

## Debugging with callbacks before you have a tracer

A ten-line handler that prints `run_name`, input keys, output type and elapsed time catches most problems in development faster than opening a UI:

```python
class LogHandler(BaseCallbackHandler):
    def on_chain_start(self, serialized, inputs, *, run_id, **kwargs):
        print("→", (serialized or {}).get("name"), list(inputs)[:5])
    def on_chain_error(self, error, *, run_id, **kwargs):
        print("✗", type(error).__name__, str(error)[:200])
```

Note `on_chain_error` fires at every level, so one failure produces several lines — the innermost is the cause, the outermost is the symptom. Read bottom-up.

## Common mistakes

- Enabling tracing in production without deciding what may leave the network.
- No `run_name`, so the trace tree is unreadable.
- Instrumenting only top-level calls, then being unable to see the retrieval step.
- A handler that blocks on network I/O per token.
- Assuming callback errors break the chain — or assuming they never will.

## Production notes

Set tags and metadata at the entry point from request context, so every nested run inherits tenant, user, prompt version and conversation id. Alert on p95 per Step, not only on overall request latency. Keep a redaction test in CI: build a fake trace with known PII and assert it does not appear in the outbound payload.
