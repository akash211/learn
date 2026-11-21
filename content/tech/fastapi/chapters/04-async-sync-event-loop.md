# Async, Sync, and the Event Loop

FastAPI supports both `async def` and ordinary `def` path operations. The distinction is operational: an async endpoint runs as a coroutine on the event loop, while a synchronous endpoint is run in a worker thread by Starlette's thread-pool mechanism. The framework's ability to accept either signature does not transform a blocking function into non-blocking I/O.

## What the event loop does

An event loop schedules coroutines and I/O callbacks on a thread. A coroutine runs until it reaches an `await` that actually suspends; then the loop can run another ready task while the first waits for a socket, timer, or other asynchronous operation. Cooperative concurrency works well when the endpoint uses async-aware libraries: an async HTTP client yields while waiting for the remote server, allowing unrelated requests to progress.

```python
import httpx
from fastapi import FastAPI

app = FastAPI()

@app.get("/profile")
async def profile():
    async with httpx.AsyncClient(timeout=3.0) as client:
        response = await client.get("https://api.example.test/profile")
        response.raise_for_status()
        return response.json()
```

A production service normally reuses an `AsyncClient` created during application lifespan rather than creating a pool per request; this example emphasizes the await boundary. A timeout bounds waiting, and `raise_for_status` prevents an upstream failure from becoming an apparently successful response.

An `await` is not automatically a yield. Awaiting a coroutine that completes immediately may continue without giving other tasks a turn. More importantly, a synchronous call made from `async def` does not yield at all. `requests.get`, a synchronous database driver, `time.sleep`, filesystem calls on a slow mount, CPU-heavy JSON transformation, or a long Python loop can occupy the event-loop thread. During that interval, every other coroutine assigned to that loop waits—even if the service CPU appears low while blocked on a socket.

## Choosing `def` or `async def`

Use `async def` when the body uses awaitable libraries and can benefit from concurrent I/O. Use `def` for a conventional synchronous implementation; Starlette runs the endpoint in a thread pool rather than blocking the loop. Calling an async library from `def` does not work merely because FastAPI is involved; the coroutine must be awaited from an async context.

A sync endpoint is not necessarily wrong or slow. If most of its work is blocking legacy I/O and no async driver is available, the thread-pool boundary can preserve event-loop responsiveness. But thread pools are finite resources: if all worker threads block on slow upstream calls, new sync work queues. The pool is a containment boundary, not infinite capacity.

For one isolated blocking call in an async function, use `asyncio.to_thread` or an appropriate thread-pool API, and bound concurrency. A thread does not make CPU-bound pure Python parallel under the conventional CPython GIL; it mainly moves blocking I/O off the loop. CPU-heavy work may require a process pool, a separate job worker, or a native library that releases the GIL. Moving work to a process adds serialization, memory, and lifecycle costs, so measure and design the interface.

## Never block the loop

```python
import asyncio
import time

async def unsafe():
    time.sleep(1)                # blocks this event-loop thread
    return "done"

async def safer_for_blocking_io():
    return await asyncio.to_thread(time.sleep, 1)
```

The second example illustrates the mechanism, not an application pattern for sleeping. For a real synchronous SDK call, wrap the whole call in `to_thread`; do not create a new thread for each sub-operation without bounds. A semaphore can cap downstream concurrency:

```python
vendor_limit = asyncio.Semaphore(12)

async def call_vendor(payload):
    async with vendor_limit:
        return await asyncio.to_thread(sync_vendor_call, payload)
```

Set client connect/read timeouts and an overall request deadline where appropriate. A cancellation of the awaiting coroutine does not forcibly terminate a synchronous function already running in a thread. That is why the underlying library needs its own timeout and why unbounded thread tasks are dangerous.

## Background work and CPU cost

FastAPI's `BackgroundTasks` schedule work after a response is sent, but the work still runs in the application process and is not a durable queue. CPU-intensive work can monopolize a thread or process; a process restart loses the task. Use a queue-backed worker for work that must survive restarts, retry, or scale independently. Small notification or audit tasks may be suitable for in-process background execution when loss semantics are accepted.

Async does not make CPU work cheaper. JSON encoding a large nested structure, compression, image processing, cryptography, and loops over millions of records can delay the event loop. Offload appropriately or move the computation out of the request. Measure loop lag and endpoint latency; do not infer responsiveness from CPU utilization alone.

## Common mistakes

- Declaring `async def` but calling a synchronous HTTP, database, or sleep API inside it.
- Wrapping every function in `to_thread`, adding context switches without a blocking boundary.
- Treating threads as CPU parallelism in standard GIL-enabled CPython.
- Assuming cancellation kills a synchronous function running in a thread.
- Increasing worker or thread counts without checking downstream connection limits.
- Using in-process background tasks as a durable job queue.

## Production notes

Instrument event-loop lag, thread-pool saturation where available, upstream timings, and timeouts. Reproduce a slow upstream scenario under concurrent load; one request's duration will not reveal cross-request starvation. Keep async and sync library boundaries explicit, and use lifespan-managed clients with finite timeouts. Consider structured concurrency for groups of async calls so failures and cancellation are coordinated instead of leaving orphaned work behind.

## The scheduler is cooperative, not preemptive

An event loop does not interrupt a coroutine at arbitrary Python instructions to run another request. A task yields when it awaits an operation that is pending, or explicitly schedules control back to the loop. Therefore, even pure Python work that takes only a few milliseconds can be harmful when many requests perform it back-to-back: each computation delays all other tasks on that loop. Keep synchronous critical sections short and move substantial CPU work to a separate process or service when it dominates latency. Native extensions sometimes release the GIL, but that behavior is library-specific and does not prove that a particular call is safe to run on the loop.

For concurrent upstream calls, limit fan-out. A request that launches hundreds of coroutines can exhaust file descriptors, connection pools, and the upstream's rate budget even though each coroutine yields. Use a semaphore and client connection limits, and apply an overall deadline so one request cannot consume resources indefinitely. When several calls form one logical operation, structured concurrency makes failure behavior explicit: if one required call fails, cancel siblings and await their cleanup rather than leaving detached tasks to finish after the response.

Cancellation is cooperative too. Async libraries should respond to cancellation and close sockets in `finally` blocks or context managers. Do not swallow `asyncio.CancelledError` as though it were an ordinary application failure; doing so can prevent graceful shutdown. Cleanup should be short and bounded, because a stuck shutdown hook can outlast the container's termination grace period. These are lifecycle concerns, not merely syntax details of `await`.