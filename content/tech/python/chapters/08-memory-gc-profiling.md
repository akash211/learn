# Memory Management, GC and Profiling

A Python process that grows until the OOM killer arrives is almost never "a Python memory leak"
in the C sense. It is a reference you did not mean to keep. This chapter explains how CPython
allocates and frees, how to find what is holding memory, and how to profile CPU without guessing.

## Reference counting, and what it cannot do

Every object has an `ob_refcnt`. Assignment, argument passing, and container insertion increment
it; deletion, rebinding and scope exit decrement it. When it hits zero the object is freed
immediately and deterministically — unlike a tracing GC, CPython reclaims most garbage at the
moment the last reference drops.

Reference counting cannot free cycles. A list containing itself, two objects pointing at each
other, a parent holding a child that holds a parent back: the counts never reach zero. That is
what the cyclic garbage collector exists for.

## The generational collector

CPython tracks container objects in three generations. New objects go into gen0. When gen0
reaches its threshold (700 net allocations by default), a collection runs: survivors are
promoted to gen1, and gen1 to gen2. Gen2 collections are full collections and much more
expensive.

```python
import gc
gc.get_threshold()      # (700, 10, 10) typically
gc.get_count()          # current counts per generation
gc.collect()            # full collection, returns number of unreachable objects
gc.disable()            # only if you have measured and know why
gc.freeze()             # move current objects to a permanent generation (3.7+)
```

`gc.freeze()` is the interesting one for servers: call it after imports and warm-up, and the
collector stops scanning long-lived objects on every full collection. On a large process it can
cut GC pause time substantially. It is safe because those objects are reachable for the life of
the process.

`gc.disable()` is a common cargo-cult optimisation. Without the collector, cycles are never
freed, so memory grows monotonically in any workload that creates them — and most do, because
exceptions hold tracebacks that reference frames that reference the exception. Only disable it
in short-lived batch processes where you know the cycle profile, or where you call `gc.collect()`
at deliberate checkpoints.

## Pymalloc: arenas and fragmentation

Small objects (≤512 bytes) come from `pymalloc`, which carves 256 KB arenas into pools of
fixed-size blocks. Freed blocks return to their pool; a pool returns to the OS only when it is
completely empty. This produces the classic symptom: RSS does not drop after a spike even though
`gc.collect()` frees everything, because one live object pins an entire pool.

Consequences:

- RSS is a high-water mark, not a live-object measure. Track `gc.get_objects()` counts or
  `tracemalloc` totals instead.
- Long-running processes that alternate between huge and small workloads fragment. Restarting
  workers periodically (`max_tasks_per_child` in gunicorn/celery) is a legitimate mitigation.
- `PYTHONMALLOC=malloc` disables pymalloc for debugging with valgrind, at a large performance
  cost.

## Finding the leak

Work in this order: measure, snapshot, diff, attribute.

```python
import tracemalloc

tracemalloc.start(25)                 # 25 frames of traceback per allocation
snap1 = tracemalloc.take_snapshot()
...                                   # run the suspect workload
snap2 = tracemalloc.take_snapshot()

for stat in snap2.compare_to(snap1, "lineno")[:10]:
    print(stat)                       # file:line, size diff, count diff
```

`tracemalloc` is in the stdlib, has modest overhead, and answers "where was this allocated".
It does not tell you why it is still alive. For that:

- `gc.get_referrers(obj)` — who points at this object. Expect noisy output; filter by type.
- `objgraph.show_backrefs(obj, max_depth=3)` — a graph of referrers, much easier to read.
- `pympler.asizeof(obj)` — deep size, unlike `sys.getsizeof`.
- `tracemalloc.get_traced_memory()` — current and peak bytes, cheap enough for a metrics gauge.

Common real leaks, in order of frequency:

| Pattern | Why it grows | Fix |
|---|---|---|
| Module-level dict cache keyed by request/user | Unbounded cardinality | `lru_cache(maxsize=)`, TTL cache, explicit eviction |
| Exception stored with traceback | Traceback holds every frame's locals | Store `str(exc)`, not `exc`; clear `__traceback__` |
| Global registry of instances (`__subclasses__`, signals, callbacks) | Strong refs forever | `weakref.WeakSet`, `WeakValueDictionary` |
| Thread-local or contextvar holding request data | Never cleared on long-lived threads | Clear in `finally` |
| Log record queue / async queue with no bound | Producers outrun consumers | `maxsize`, drop policy |
| `functools.cache` on a method | Key includes `self` | Cache on a function taking the fields, or per-instance cache |
| C extension buffer not released | Outside the GC's view | Check the library's docs/issues |

`weakref` is the tool for caches and observer lists: a `WeakValueDictionary` drops entries when
the value is collected elsewhere, turning a leak into correct behaviour.

## Slots, interning and copy discipline

- `__slots__` removes the per-instance dict. For millions of small objects this is the single
  biggest memory win available without changing algorithms.
- Columnar layout beats object layout: three lists of 1,000,000 ints use far less than 1,000,000
  three-field objects, because the latter pays an object header and a dict or slots array each.
- `sys.intern` on repeated identifier strings saves memory when the same strings appear in
  large numbers of dicts — but only measure it; interning has its own table and lookup cost.
- Slicing copies. `data[1000:2000]` in a loop over a 1 GB list allocates 1,000-element copies;
  use indices or `memoryview` for buffers.
- `copy.deepcopy` is slow and can blow up on graphs with shared nodes. Prefer explicit copy
  constructors or immutable data.

## Profiling CPU

Use the right tool for the question:

| Tool | Answers | Overhead |
|---|---|---|
| `timeit` | How fast is this snippet | Micro-benchmark only |
| `cProfile` | Which functions dominate call time | High, but fine for batch jobs |
| `py-spy` | What a running production process is doing | Near zero, no code change |
| `scalene` | CPU + memory + GPU per line | Moderate |
| `line_profiler` | Time per line in one function | High, targeted |
| `perf` + `py-spy` | Native + Python stacks | Low |

```bash
python -m cProfile -s cumulative -m mypackage.job
py-spy top --pid 12345
py-spy dump --pid 12345            # current stack of every thread
```

`cProfile` sorts by `tottime` (time in the function itself) or `cumulative` (including callees).
Read `cumulative` first to find the hot subsystem, then `tottime` to find the function to change.
Beware: `cProfile` inflates call overhead, so it over-weights functions called millions of
times.

For a single suspicious function, `time.perf_counter()` around it is often enough:

```python
t0 = time.perf_counter()
result = transform(rows)
log.info("transform", extra={"rows": len(rows), "seconds": round(time.perf_counter() - t0, 3)})
```

## Common mistakes

- Calling `gc.collect()` in a request path to "fix" memory — it is a stop-the-world pause and
  it hides the real reference.
- Trusting RSS as a live-memory metric.
- Caching with `@cache` on a function whose arguments are unbounded (user IDs, URLs, dates).
- Storing exceptions in a list for later reporting; each one pins a traceback and its locals.
- Profiling with `cProfile` a program dominated by I/O and concluding the code is slow.
- Optimising before measuring, and optimising the wrong 5%.

## Production notes

Export `tracemalloc` current/peak as gauges, plus `gc.get_count()` and collection durations.
A memory graph that steps up after each deploy or each batch is a leak; one that steps up and
plateaus is a cache doing its job.

For services, `max_requests`/`max_tasks_per_child` recycling is a pragmatic backstop against
slow leaks in third-party libraries — not a substitute for finding yours.

When investigating a live process, `py-spy dump` first: it tells you whether the process is
stuck, busy, or waiting on I/O without restarting anything. That single command resolves a large
share of "the worker is hung" incidents.
