# Background Tasks, Streaming Responses, and SSE

Not every operation should hold an HTTP request open until all work is complete. FastAPI provides in-process background tasks and response types for streaming, but these tools have distinct delivery and reliability semantics. Choose based on whether the caller needs the result now, whether the work must survive a process restart, and whether the response is a finite body or an ongoing event stream.

## BackgroundTasks: after-response, in-process work

A path operation can accept `BackgroundTasks` and register a callable. FastAPI arranges for it to run after the response is sent. This suits small, best-effort actions such as sending a lightweight notification or recording an audit event when loss on process crash is acceptable.

```python
from fastapi import BackgroundTasks, FastAPI

app = FastAPI()

def write_audit_line(event: str) -> None:
    with open("audit.log", "a", encoding="utf-8") as stream:
        stream.write(event + "\n")

@app.post("/events", status_code=202)
async def accept_event(event: str, tasks: BackgroundTasks):
    tasks.add_task(write_audit_line, event)
    return {"accepted": True}
```

This example is intentionally simple, not a recommendation to write concurrent production logs to a local file. Background tasks execute within the web application process and share its resource limits. They are not a queue, are not durable, and do not automatically provide retries, deduplication, scheduling, or independent scaling. If the work is expensive, CPU-bound, long-running, or must not be lost, publish a job to a durable broker and process it with a worker. Return an identifier and expose job status if clients need to observe completion.

Background tasks are not a way to evade blocking. A synchronous task may run in a thread pool, but it competes with other work; an async task that calls blocking code still blocks its event loop. Bound concurrency and ensure dependencies remain alive for the task's execution. Avoid passing a request-scoped database session into work that outlives the request; pass identifiers and let a worker open its own unit of work.

## StreamingResponse

`StreamingResponse` sends an iterable or async iterable in chunks rather than building one large body in memory. It is useful for large exports, proxying data, and generated output. Each chunk is transmitted as it becomes available, so the client may receive a partial response before the producer finishes. Once headers and body bytes have gone out, the server cannot replace the response with a different status if a later error occurs.

```python
from collections.abc import AsyncIterator
from fastapi.responses import StreamingResponse

async def csv_rows() -> AsyncIterator[bytes]:
    yield b"id,name\n"
    for row in await load_rows():
        yield f"{row.id},{row.name}\n".encode("utf-8")

@app.get("/export.csv")
async def export_csv():
    return StreamingResponse(csv_rows(), media_type="text/csv")
```

Real CSV should use a CSV encoder to quote commas, quotes, and newlines correctly; the snippet highlights the async iterator contract. A synchronous iterator is also accepted, but a blocking generator can tie up a worker thread. Stream from a source with bounded buffers, support client disconnect cancellation, and close upstream resources in a `finally` block or async context manager. Do not keep a database transaction open for an unbounded download; materialize the necessary data or use keyset pagination and short-lived reads.

Streaming changes dependency cleanup timing. If a generator needs a request dependency after the endpoint has returned, select a dependency scope that keeps the resource alive through response consumption, or manage the resource inside the generator. Verify behavior against the installed FastAPI version and test that disconnects and generator exceptions release the resource.

## Server-Sent Events

Server-Sent Events (SSE) are a simple one-way event stream over HTTP. The response uses `text/event-stream`; each event is UTF-8 text with lines such as `event: update`, `id: 42`, `data: {...}`, followed by a blank line. Multiple data lines are allowed. Browsers' `EventSource` reconnects automatically and may send `Last-Event-ID`; the server must define whether it can resume from that point. SSE is not a durable message broker, and reconnect behavior does not guarantee delivery unless the application retains events and implements replay.

```python
import json
from fastapi.responses import StreamingResponse

async def event_stream():
    async for update in subscribe_updates():
        payload = json.dumps(update, separators=(",", ":"))
        yield f"event: update\ndata: {payload}\n\n".encode("utf-8")

@app.get("/events/stream")
async def stream_events():
    return StreamingResponse(event_stream(), media_type="text/event-stream")
```

Production SSE needs heartbeats to keep idle proxies from closing the connection, bounded per-client queues, cancellation cleanup, authentication, and reverse-proxy buffering configured appropriately. Avoid buffering the entire event history in process memory. Set cache headers deliberately, and remember that browsers have restrictions on custom headers with native `EventSource`; cookie authentication or a fetch-based client may be needed.

## Common mistakes

- Treating `BackgroundTasks` as durable task processing or a retry queue.
- Passing request-scoped sessions into work that runs after the response lifecycle.
- Building a huge response in memory and calling it streaming.
- Assuming an exception midway through a stream can still change its HTTP status.
- Forgetting disconnect handling, resource closure, backpressure, or per-client buffering limits.
- Calling SSE reliable messaging without event retention and replay semantics.

## Production notes

Document what “accepted” means: accepted into process memory, accepted by a durable queue, or completed. Give job endpoints idempotency keys when clients may retry. For streams, set finite resource limits and verify behavior through the production proxy, not only the test client. Monitor open stream counts, time-to-first-byte, bytes sent, disconnects, and background task failures. Use queue-backed workers for tasks whose completion is a business promise; use streaming only when incremental delivery is actually useful to the client.

## Backpressure and delivery contracts

A producer and consumer rarely run at the same speed. If a stream producer keeps generating while a client reads slowly, unbounded buffering turns a slow connection into memory growth. Use bounded queues, pause reads when downstream cannot accept more data, or disconnect clients that exceed a policy. ASGI servers and reverse proxies have their own buffering behavior, so an application yield does not guarantee a byte reaches the browser immediately. Verify time-to-first-byte and flush behavior through the complete network path.

For background work, define the acknowledgement boundary precisely. A 202 response can mean the request was validated and placed durably onto a queue, or it can mean only that an in-memory callback was scheduled; those are very different promises. If a queue publish fails, return an error rather than claiming acceptance. Use idempotent job identifiers so a client retry after a timeout does not create duplicate work. Workers should record state transitions, retry transient failures with bounded backoff, and send poison messages to a dead-letter path rather than retry forever. FastAPI's built-in task helper does not provide these properties.

For SSE, each event should have framing and encoding rules. JSON-encode data rather than interpolating arbitrary strings into the `data:` line; newline characters need correct framing. Heartbeats keep intermediaries active but do not indicate business progress. When replay is supported, event IDs need a stable ordering and retention policy. Authentication expires during long connections, so decide whether to close streams at credential expiry or revalidate periodically. Protect against one client opening too many connections and ensure server shutdown closes streams cleanly so clients can reconnect to a replacement worker.