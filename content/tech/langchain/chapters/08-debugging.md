# Debugging Chain Failures

LCEL chains fail in ways that frustrate people who are used to reading stack traces: the error surfaces at a prompt, not at the thing that was wrong, and the frame that raised is three abstractions away from the code you wrote. The remedy is to treat the chain as a data pipeline and inspect the data at each boundary.

## Classify the failure first

| Symptom | Likely layer | First check |
|---|---|---|
| `KeyError: 'question'` | Input mapping | What keys reach the prompt |
| `ValidationError` from the prompt | Template variables | Rendered messages |
| Provider 400 / `BadRequestError` | Message shape, context length | Transcript structure, token count |
| `OutputParserException` | Parsing | Raw model output |
| `RateLimitError` / 429 | Provider quota | Retry policy, concurrency |
| `TimeoutError` | Network or slow tool | Per-step latency |
| No error, wrong answer | Prompt, retrieval, or model | Retrieved docs, rendered prompt |

The last row is the expensive one. Silent wrongness has no traceback, so the debugging tools differ: you need retrieval logs and evaluation, not exception handlers.

## Turn on visibility

Three escalating options:

```python
from langchain_core.globals import set_debug, set_verbose

set_verbose(True)   # inputs/outputs per step, readable
set_debug(True)     # adds internal detail, noisy
```

`set_verbose` is a global, which is fine in a notebook and wrong in a server. In a server, attach a handler per request (chapter 6) and log to your own pipeline, keyed by request id.

```python
chain.invoke(inputs, config={"run_name": "answer_question", "callbacks": [LogHandler()]})
```

Once you have the trace, read it as a tree and find the **last successful node** and the **first failing node**. The gap between them is the bug. Errors that appear at the top of the tree are symptoms; the innermost `on_chain_error` is the cause.

## The four bugs behind most LCEL failures

### 1. The input dict does not have the keys the prompt wants

A prompt with `{question}` and `{context}` needs both, at the same level, in the first step. `RunnableParallel` produces a dict with exactly the keys you named; `RunnablePassthrough` forwards its input unchanged; `RunnablePassthrough.assign(x=...)` copies the input and adds `x`. Confusing these three is the most common composition bug.

```python
# Wrong: retriever receives the whole dict, not the question
{"context": retriever, "question": RunnablePassthrough()} | prompt

# Right: extract the question for the retriever
{"context": (lambda x: x["question"]) | retriever, "question": lambda x: x["question"]} | prompt
```

Note that `RunnablePassthrough()` as the *second* value is correct — it forwards the original dict, and `prompt` reads `question` from it. The bug is the retriever, which needs a string.

### 2. The messages are structurally invalid

Providers reject transcripts that violate their role rules: a `ToolMessage` with no preceding `tool_calls`, an assistant message with two tool calls and one result, two human messages in a row, a system message in the middle. The error message names the provider's validation, not your code, so search your history-building and trimming logic.

Validate locally before spending a call:

```python
def check_transcript(messages):
    pending = set()
    for m in messages:
        for call in getattr(m, "tool_calls", []) or []:
            pending.add(call["id"])
        if m.type == "tool":
            pending.discard(m.tool_call_id)
        elif m.type == "human" and pending:
            raise ValueError(f"unanswered tool calls: {pending}")
    if pending:
        raise ValueError(f"dangling tool calls at end: {pending}")
```

### 3. The output does not match the parser

`OutputParserException` means the model returned prose, markdown-fenced JSON, or missing fields. Print the raw text before parsing — attach a handler on `on_llm_end` or invoke the model without the parser for one run. Then decide: switch to native structured output, tighten the schema, or add one repair retry with the validation error appended.

Never "fix" this with a regex that tolerates anything. A parser that silently accepts malformed output moves the failure downstream, where it is harder to see.

### 4. The context window is exceeded

Providers report this differently — some as a 400 with `context_length_exceeded`, some as a 413, some buried in a message about `max_tokens`. The cause is usually not the prompt but accumulated history or a stuff-chain with `k=20`. Count before sending:

```python
from langchain_core.messages import trim_messages
n = model.get_num_tokens_from_messages(messages)   # approximate, provider-specific
```

`get_num_tokens_from_messages` is an estimate, not the provider's tokeniser, and it is wrong for images and tool schemas. Budget with headroom — 15–20% — rather than exactly to the limit.

## Error propagation and policy

By default, an exception in any step aborts the chain and propagates to the caller. That is correct, and it is also why `RunnableBranch` and `RunnableParallel` do not "handle" anything: a failing branch kills the run.

```python
resilient = chain.with_retry(
    stop_after_attempt=3,
    wait_exponential_jitter=True,
    retry_if_exception_type=(RateLimitError, TimeoutError),
).with_fallbacks([cheap_chain], exception_key="primary_error")
```

Read the semantics precisely:

- `with_retry` retries the wrapped runnable. With streaming, it cannot retry after the first chunk has been emitted.
- `with_fallbacks` catches exceptions from the wrapped runnable and calls the next one — **with the same input**. If the fallback expects a different input shape, it will fail too, and the error you see is from the fallback, hiding the original.
- `exception_key` puts the original error into the fallback's input under that key, which is the only way to log both.
- Wrapping the wrong level is the classic mistake: `(a | b | c).with_retry()` retries all three; `a | b.with_retry() | c` retries only `b`.

Retrying a non-idempotent tool call inside a chain is a correctness bug, not a resilience feature.

## Bisect the chain

When the trace is unclear, invoke each segment directly:

```python
pv = prompt.invoke({"question": q, "context": "..."})
print(pv.to_messages())          # did the prompt render what you expect?
msg = model.invoke(pv)
print(msg.content, msg.response_metadata)
print(parser.invoke(msg))
```

Five lines, no framework. If each segment works alone, the bug is in the wiring — key names, order, or an object being reused across tenants (a bound model with per-user config, a mutable history dict). If a segment fails alone, you have localised it.

## Reproduction discipline

Model bugs are not reproducible by default. To make them so: `temperature=0`, a fixed model snapshot, the recorded input, and the rendered prompt saved to a file. Then the failure is a fixture, testable in CI. Keep the raw request payload for provider support tickets — the generic error often omits the field that was rejected.

## Common mistakes

- Reading only the top-level exception and assuming the last step failed.
- Leaving `set_verbose(True)` in a deployed service and logging full prompts.
- Catching `Exception` around the whole chain and returning a generic 500, destroying the error class you needed.
- Retrying `ValidationError` from a prompt (deterministic — it will fail identically).
- Adding a fallback that changes output shape without telling the caller.
- Debugging a "bad answer" with prompt edits before checking what retrieval returned.

## Production notes

Define an error taxonomy at the boundary — provider unavailable, rate limited, invalid request, parse failure, tool failure — and map LangChain and provider exceptions onto it once, centrally. Log the run id on every error so the trace can be found. Alert on parse-failure and retry rates separately from latency: they move for different reasons, and a rising parse-failure rate after an untouched deploy almost always means the provider changed the model behind a floating alias.
