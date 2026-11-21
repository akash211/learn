# Streaming at Three Levels

Streaming is not one feature. There are three distinct things you can stream, they are often confused in conversation, and choosing the wrong one is why a chat UI sits blank for eight seconds and then prints the whole answer.

| Level | API | What arrives | Use it for |
|---|---|---|---|
| Model chunks | `model.stream(...)` | `AIMessageChunk` deltas | Building a custom loop |
| Chain output | `chain.stream(...)` | Whatever the last step yields | Straight text streaming |
| Events | `chain.astream_events(...)` | Every step's start/end/token events | Progress UI, tool activity, debugging |

## Level 1: model chunks

```python
for chunk in model.stream("Explain vector indexes"):
    print(chunk.content, end="", flush=True)
```

Each chunk is an `AIMessageChunk`. Chunks support `+` and merge into a full message, which is how a chain reassembles the final output while also forwarding deltas:

```python
acc = None
for chunk in model.stream(prompt_value):
    acc = chunk if acc is None else acc + chunk
print(acc.content, acc.usage_metadata)
```

`usage_metadata` is typically only populated on the final chunk, and only if the caller requested it. If you count tokens from streamed chunks, read the last one, not the first.

Not every field streams cleanly. Content blocks for images or reasoning arrive as separate typed deltas; `tool_calls` arrive as partial JSON strings across chunks, with the argument object only valid after assembly. Do not attempt to parse `tool_calls[0]["args"]` mid-stream — it is a fragment.

## Level 2: chain output

`RunnableSequence.stream` pushes chunks through each step. If every step implements `transform`, the pipeline is genuinely incremental:

```python
chain = prompt | model | StrOutputParser()

for text in chain.stream({"question": q}):
    sys.stdout.write(text)
```

`StrOutputParser` yields one string per chunk, so this is the shortest correct streaming RAG/chat endpoint in Python. The properties that break it:

- A `RunnableLambda` wrapping `model.invoke` — collapses to one chunk at the end.
- A retriever in the middle — step 1 emits nothing until it finishes; the *stream* starts late but it is still a stream.
- A parser that requires the complete output, such as `PydanticOutputParser` — no output until the end.
- Anything that calls `.invoke()` internally, including most legacy chains.

That last one is the classic bug: `create_retrieval_chain(...).stream()` works, but a chain of custom functions that each call `.invoke()` does not, and the symptom is "streaming doesn't work" with no error.

## Level 3: events

`astream_events` emits a typed event for every step in the tree, which is what a UI needs to show "searching documents…" before any text appears.

```python
async for event in chain.astream_events({"question": q}, version="v2"):
    kind, name = event["event"], event["name"]
    if kind == "on_chat_model_stream":
        token = event["data"]["chunk"].content
        if token:
            await send(token)
    elif kind == "on_retriever_start":
        await send_status(f"searching: {name}")
    elif kind == "on_tool_start":
        await send_status(f"calling {event['data'].get('name')}")
    elif kind == "on_chain_error":
        await send_error(event["data"].get("error"))
```

Event names follow `on_<runnable>_<phase>`: `on_chain_start/end/error`, `on_chat_model_start/stream/end`, `on_tool_start/end/error`, `on_retriever_start/end/error`. Always pass `version="v2"`; v1 events had a different shape and the schemas are not compatible. Filter with `include_names` / `include_types` if the tree is large — an agent with ten tools produces a lot of events and serialising all of them to a browser is a bandwidth problem.

`astream_events` is the modern replacement for `astream_log`, which was the older JSON-patch based mechanism and is effectively legacy. If a tutorial uses `astream_log`, translate the idea, not the code. The cost of events is overhead: every runnable in the tree emits start, end and error events, so an agent that calls five tools produces dozens. Serialise selectively, and never forward raw events to a browser.

## FastAPI and SSE, correctly

```python
import json
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

@app.post("/chat")
async def chat(payload: dict):
    async def events():
        try:
            async for ev in chain.astream_events({"question": payload["q"]}, version="v2"):
                if ev["event"] == "on_chat_model_stream":
                    tok = ev["data"]["chunk"].content
                    if tok:
                        yield f"data: {json.dumps({'t': tok})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
```

The pieces that are easy to miss:

- **`X-Accel-Buffering: no`** and proxy configuration. Nginx buffers responses by default; without this header the "stream" arrives in one block after completion and every local test passes because the test client does not buffer.
- **Errors after the first byte cannot change the status code.** The response is 200 already; report failure as an event in the stream.
- **SSE framing** — `data: ` prefix, blank line terminator, and JSON-encoding the payload so newlines and quotes do not corrupt the frame.
- **Disconnects.** When the client goes away you get a cancellation; wrap persistence in `finally` so a partial answer is either saved deliberately or not at all, and stop consuming the model stream to stop paying for it.

## Cancellation and cost

A cancelled stream still bills for tokens generated before the provider notices. In an agent, cancelling mid-run can leave a tool half-executed. Design for it: check `is_disconnected`, catch `asyncio.CancelledError`, mark the turn as aborted rather than complete, and never retry a stream that already emitted text to the user — you will double-print, and in a tool-using loop you may double-execute.

Retries and streaming are fundamentally at odds. `with_retry` on a streaming chain can only retry before the first chunk is emitted; after that, the user has seen output. If you need both, retry only the model call inside a buffered path, or accept truncation and mark it in the UI.

## Measuring what users feel

Total latency is the wrong metric for a streaming interface. Report:

- **Time to first token** — dominated by retrieval, prompt size, and provider queueing.
- **Tokens per second** — dominated by model and provider.
- **Time to completion** — matters for persistence and billing.

A pipeline with 300 ms to first token and 20 tok/s feels responsive; one with 2.5 s to first token feels broken even if it finishes 1 s earlier overall. Retrieval is usually the culprit, and the fix is reranking fewer candidates rather than streaming harder.

## Common mistakes

- Calling `invoke` inside a lambda, then reporting "streaming is broken".
- Parsing partial tool-call arguments mid-stream.
- Forgetting proxy buffering and shipping a stream that only works on localhost.
- Assuming a mid-stream exception can return HTTP 500.
- Retrying a partially delivered stream.
- Using `astream_events` for text and then also subscribing to a token callback, doubling work.

## Production notes

Test streaming through the real proxy, not the test client. Assert ordering and that concatenated chunks equal the non-streamed result — that test catches dropped final chunks. Emit heartbeat comments (`: ping\n\n`) on idle streams to keep intermediaries from closing long-lived connections. And record the completion reason: model stop, length limit, user cancel, or error. "Why did the answer end mid-sentence" is answered by that field and nothing else.
