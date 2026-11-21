# Concurrency: Threading, Multiprocessing and the GIL

Python's concurrency story is confusing because the answer depends on what the work is waiting
for. The GIL is the reason, and understanding it precisely is the difference between a service
that scales and one that gets slower with more threads.

## What the GIL actually is

CPython (the reference implementation) has a global interpreter lock: only one thread executes
Python bytecode at a time. The lock exists because CPython's memory management — reference
counting — is not thread-safe, and making every refcount operation atomic would slow single
threads dramatically and break C extensions.

The GIL is released:

- Every `sys.getswitchinterval()` seconds (5 ms by default) so other threads can run.
- Whenever a thread blocks on I/O — `read`, `recv`, `time.sleep`, waiting on a lock.
- Inside many C extensions that explicitly release it: `numpy` arithmetic, `hashlib`, `zlib`,
  `lzma`, file reads, socket operations, database drivers.

It is *not* released during pure-Python computation. A loop summing a list holds the GIL and no
other thread runs Python code until the switch interval expires.

Consequences:

| Workload | Threads help? | Why |
|---|---|---|
| HTTP calls, DB queries, file I/O | Yes, massively | GIL released while blocked |
| NumPy/pandas heavy compute | Often yes | C code releases the GIL |
| Pure-Python CPU work (parsing, loops) | No | GIL serialises it |
| Compression/hashing | Usually yes | C libs release the GIL |

## Threads: right tool for I/O

`concurrent.futures.ThreadPoolExecutor` is the shortest correct way to parallelise I/O:

```python
from concurrent.futures import ThreadPoolExecutor, as_completed

def fetch(url):
    return requests.get(url, timeout=10).json()

with ThreadPoolExecutor(max_workers=16) as pool:
    futures = {pool.submit(fetch, u): u for u in urls}
    for fut in as_completed(futures):
        url = futures[fut]
        try:
            data = fut.result()
        except Exception as exc:
            log.warning("fetch failed", extra={"url": url, "error": str(exc)})
```

Rules of thumb: 8–32 workers for HTTP, closer to the DB pool size for database work, and never
more threads than the downstream service can absorb. A thread pool is a queue with backpressure
only if you bound it — submitting 500,000 tasks still allocates 500,000 futures.

**The GIL does not make your code thread-safe.** It makes individual bytecode operations
atomic-ish, not compound operations. `counter += 1` is load/add/store and can interleave:

```python
import threading

counter = 0
lock = threading.Lock()

def bump():
    global counter
    for _ in range(100_000):
        with lock:                 # remove this and the total is usually wrong
            counter += 1
```

Use `threading.Lock` for shared mutable state, `queue.Queue` to hand work between threads
(thread-safe by design), and `threading.local()` for per-thread context. Prefer designs where
threads share nothing but immutable data.

## Processes: right tool for CPU

`ProcessPoolExecutor` runs work in separate interpreters, each with its own GIL, so CPU-bound
work scales with cores. The costs are real:

- Arguments and return values are pickled. Lambdas, closures, open sockets, DB connections and
  generators cannot cross the boundary.
- Workers import your module fresh (on spawn), so import-time side effects run N times.
- Memory is per process: eight workers mean eight copies of your data unless you use shared
  memory or memory-mapped files.
- Startup on spawn is tens to hundreds of milliseconds per worker; keep pools long-lived.

```python
from concurrent.futures import ProcessPoolExecutor

def score_chunk(rows):             # module-level, picklable
    return sum(compute(r) for r in rows)

if __name__ == "__main__":         # required on Windows/macOS spawn
    chunks = [rows[i::8] for i in range(8)]
    with ProcessPoolExecutor(max_workers=8) as pool:
        totals = list(pool.map(score_chunk, chunks))
```

The `if __name__ == "__main__"` guard is mandatory with the spawn start method, which is the
default on macOS and Windows and available on Linux (`multiprocessing.get_context("spawn")`).
Linux still defaults to `fork`, which is faster to start but unsafe with threads and some C
libraries — `fork` inside a process with active threads can deadlock in the child. Prefer
`spawn` or `forkserver` for anything long-running.

## Choosing a model

```text
Is the bottleneck waiting (I/O, network, disk)?
├─ yes → threads or asyncio (asyncio if tens of thousands of connections)
└─ no, it is CPU
   ├─ pure Python → processes (or a C extension / vectorised NumPy)
   └─ releases the GIL → threads are fine, but processes still scale better
```

asyncio is covered in the next chapter. The short version: one thread, cooperative
multiplexing, enormous connection counts, and one blocking call ruins everything.

## Shared state and coordination

- `queue.Queue` — thread-safe FIFO with optional `maxsize` for backpressure. The producer
  blocks when full, which is what you want.
- `threading.Event` — one-shot signal between threads.
- `threading.Semaphore` — bound concurrency (e.g. limit concurrent requests to an API).
- `multiprocessing.Queue` / `Pipe` — cross-process, pickled.
- `multiprocessing.Value` / `Array` / `shared_memory` — avoid pickling large buffers.

Deadlock checklist: acquire locks in a consistent global order; use timeouts
(`lock.acquire(timeout=5)`); never call user code while holding a lock; remember that
`ThreadPoolExecutor` tasks that submit and wait on other tasks in the same pool can starve it.

## Free-threaded Python

PEP 703 landed an experimental free-threaded build in 3.13 (`python3.13t`), with the GIL
disabled. 3.14 moved that build to officially supported status. It is a separate binary, not a
flag on the normal one, and it is slower for single-threaded code (typically a modest
double-digit percentage penalty, improving each release). C extensions must opt in; many have
not. The practical guidance for production in 2026: the standard GIL build remains the default
for almost everything, and free-threaded builds are worth evaluating for CPU-bound services
that cannot use processes — not for general adoption.

## Common mistakes

- Threads for CPU-bound work, then concluding "Python is slow" when wall time does not improve.
- Assuming the GIL makes compound operations atomic.
- Sharing a database connection or `requests.Session` across threads without checking whether
  the object is thread-safe (sessions are generally not; one connection per thread is safer).
- Passing an unpicklable closure to a process pool: `AttributeError: Can't pickle local object`.
- Ignoring `BrokenProcessPool` — a worker killed by the OOM killer surfaces as every future
  failing at once.
- Unbounded thread pools: `ThreadPoolExecutor()` with no `max_workers` uses
  `min(32, os.cpu_count() + 4)` and can still hammer a fragile downstream.

## Production notes

Measure before choosing. Run the job single-threaded, then with threads, then with processes,
and compare wall time and CPU time (`/usr/bin/time -v`). If CPU time rises much faster than
wall time falls, you are adding overhead, not parallelism.

For services, size the thread pool to the downstream dependency, not to CPU count: a pool of 50
threads against a Postgres with 20 connections spends its time queuing. Add a bulkhead
(semaphore or bounded queue) and a timeout on every external call.

For batch jobs, processes plus chunking beats one big `pool.map` — chunks amortise pickling and
give the scheduler something to balance. And keep workers stateless: anything cached in a worker
dies with it, and you cannot rely on which worker got which task.
