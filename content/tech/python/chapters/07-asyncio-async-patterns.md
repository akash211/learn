# asyncio and Async Patterns

asyncio is a single-threaded scheduler for I/O-bound work. It shines when you need thousands of
concurrent connections on modest hardware, and it punishes any blocking call with a service-wide
latency spike. This chapter covers the execution model, the concurrency primitives that matter,
and the failure modes that show up in production.

## The event loop

An event loop owns a queue of ready callbacks and a selector that watches file descriptors. Each
iteration: run ready callbacks, ask the OS which sockets are readable/writable, wake the
coroutines waiting on them. There is no preemption — a coroutine runs until it awaits something
that actually suspends.

```python
import asyncio

async def main():
    await asyncio.sleep(1)          # suspends, yields control to the loop

asyncio.run(main())                 # creates the loop, runs main, closes the loop
```

`asyncio.run()` is the entry point for scripts. In a web framework (FastAPI, Starlette,
aiohttp), the server already runs a loop — never call `asyncio.run()` inside a request handler.

Coroutine objects do nothing until awaited. `main()` without `await` produces a
`RuntimeWarning: coroutine 'main' was never awaited` and no work.

## Tasks: concurrency, not just awaiting

`await f()` runs `f` and waits. To run several at once, wrap them in tasks:

```python
async def get_user(uid): ...
async def get_orders(uid): ...

async def profile(uid):
    user_task = asyncio.create_task(get_user(uid))
    orders_task = asyncio.create_task(get_orders(uid))
    user, orders = await user_task, await orders_task
    return {"user": user, "orders": orders}
```

`create_task` schedules immediately; the two calls interleave. `asyncio.gather` is the shorthand,
with a critical caveat: by default, if one coroutine raises, `gather` propagates the first
exception but **the others keep running** (they are not cancelled). Use `return_exceptions=True`
to collect outcomes, or `TaskGroup` (3.11+) for structured behaviour:

```python
async def profile(uid):
    async with asyncio.TaskGroup() as tg:
        user = tg.create_task(get_user(uid))
        orders = tg.create_task(get_orders(uid))
    return {"user": user.result(), "orders": orders.result()}
    # any failure cancels the sibling tasks and raises ExceptionGroup
```

`TaskGroup` is the modern default: it guarantees no orphan tasks and aggregates errors in an
`ExceptionGroup`, which you handle with `except*`.

## Timeouts, cancellation and shielding

3.11 added `asyncio.timeout`, a context manager that cancels the enclosed block:

```python
async def fetch_with_deadline(client, url):
    async with asyncio.timeout(5):
        return await client.get(url)
    # raises TimeoutError (builtin, 3.11+) on expiry
```

Cancellation in asyncio is cooperative: the loop throws `CancelledError` into the coroutine at
its current await point. That means:

- `except Exception` does **not** catch `CancelledError` (it inherits `BaseException` since 3.8),
  which is deliberate — do not swallow it.
- `finally` blocks run, so cleanup still happens.
- If you catch `CancelledError` to log, re-raise it, or the task becomes uncancellable.

```python
async def worker():
    try:
        await long_operation()
    except asyncio.CancelledError:
        log.info("worker cancelled")
        raise                        # mandatory
```

`asyncio.shield(coro)` protects an inner await from outer cancellation — use it sparingly, for
work that must complete (releasing a lease, flushing a buffer). Shielded work still dies if the
loop shuts down.

## Do not block the loop

Every coroutine shares one thread. A synchronous call that takes 300 ms — a `requests.get`, a
`psycopg2` query, a big `json.loads`, `time.sleep`, a pandas operation — freezes every other
request for 300 ms. This is the single most common asyncio production bug.

Fixes, in order of preference:

1. Use an async-native library (`httpx.AsyncClient`, `asyncpg`, `aiomysql`, `aiofiles`).
2. Push blocking work to a thread: `await asyncio.to_thread(blocking_fn, arg)` (3.9+).
3. Use a process pool for CPU-bound work: `loop.run_in_executor(ProcessPoolExecutor(), fn, arg)`.

```python
# BAD: blocks the loop for the whole query
rows = psycopg2_conn.execute(sql).fetchall()

# OK: runs in a worker thread, loop stays responsive
rows = await asyncio.to_thread(lambda: psycopg2_conn.execute(sql).fetchall())
```

`to_thread` uses the default executor, which has a finite number of threads — a hundred
concurrent blocking queries will queue. Size it with
`loop.set_default_executor(ThreadPoolExecutor(max_workers=32))` and keep a semaphore in front.

Detect blocking calls in development with `asyncio.debug = True` (or `PYTHONASYNCIODEBUG=1`),
which logs callbacks that exceed the slow-callback threshold. In production, instrument loop lag:
schedule a `sleep(0.1)` and measure the drift; sustained lag means something is blocking.

## Bounding concurrency

Unbounded `gather` over 10,000 URLs will open 10,000 sockets and exhaust file descriptors, or
get you rate-limited. Bound it with a semaphore:

```python
sem = asyncio.Semaphore(50)

async def bounded_fetch(client, url):
    async with sem:
        return await client.get(url)

async def crawl(urls):
    async with httpx.AsyncClient(timeout=10) as client:
        return await asyncio.gather(*(bounded_fetch(client, u) for u in urls))
```

For a stream of work rather than a fixed list, use a queue with worker tasks:

```python
async def consume(queue: asyncio.Queue):
    while True:
        item = await queue.get()
        try:
            await handle(item)
        finally:
            queue.task_done()

async def run(items, workers=8):
    queue = asyncio.Queue(maxsize=100)      # maxsize gives backpressure
    tasks = [asyncio.create_task(consume(queue)) for _ in range(workers)]
    for item in items:
        await queue.put(item)               # blocks when the queue is full
    await queue.join()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
```

`queue.join()` waits for `task_done()` on every item. This pattern gives you backpressure and a
fixed worker count, and it degrades gracefully when one item is slow.

## Async iteration and context managers

```python
async def stream_rows(conn):
    async for row in conn.cursor("SELECT ..."):
        yield row

async with httpx.AsyncClient() as client:
    ...
```

Async generators are consumed with `async for`, and they hold resources the same way sync
generators do — an abandoned one keeps a cursor open until GC. `contextlib.aclosing` closes one
deterministically. Async context managers implement `__aenter__`/`__aexit__`, and
`@asynccontextmanager` mirrors the sync decorator, including the same rule: wrap the `yield` in
`try/finally`.

Never mix: a sync `with` around an async resource does not await cleanup, and a blocking
`__exit__` in a coroutine blocks the loop.

## Common mistakes

- Calling a blocking library from a coroutine (the 300 ms freeze).
- Creating a task and dropping the reference: `asyncio.create_task(f())` without storing it —
  the task can be garbage collected mid-flight. Keep a set of pending tasks, or use `TaskGroup`.
- `gather` without `return_exceptions`, then assuming siblings were cancelled.
- Swallowing `CancelledError`, leaving a task that cannot be stopped.
- One event loop per request (`asyncio.run` inside a handler) — connections and caches bound to
  the loop break.
- Assuming ordering: `gather` returns results in argument order, but tasks *complete* in
  whatever order I/O finishes. Side effects are not ordered.
- Running CPU-heavy parsing in the loop because "it is only 50 ms" — at 50 concurrent requests
  that is 2.5 seconds of serialised latency.

## Production notes

Size concurrency to the dependency, not to the number of requests. A service that fans out 20
calls per request with a semaphore of 50 and a timeout of 3 seconds fails predictably; one with
no bound fails as a thundering herd.

Always set timeouts at three levels: client timeout, per-attempt timeout, and an overall request
deadline. `asyncio.timeout` composes with retries — put the timeout *inside* the retry, and the
overall deadline outside.

Track loop lag and task counts as metrics. Rising pending-task count with flat throughput means
you are queuing, not scaling. And when a service that was fast becomes uniformly slow after a
library upgrade, check for a sync call that crept into an async path — that is the usual
culprit.
