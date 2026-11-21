# Decorators and Context Managers

Both features exist to remove repeated setup/teardown code from call sites. Decorators wrap
callables; context managers wrap blocks. They share one prerequisite — understanding that
functions are objects with closures — and one failure mode: hiding control flow so well that the
next reader cannot see what actually runs.

## Functions as objects

A decorator is a callable that takes a function and returns something callable in its place.
That is the entire mechanism:

```python
def logged(fn):
    def wrapper(*args, **kwargs):
        print(f"calling {fn.__name__}")
        return fn(*args, **kwargs)
    return wrapper

@logged
def add(a, b):
    return a + b
```

`@logged` is exactly `add = logged(add)`. Everything else — arguments, classes, `functools` —
is variation on that line.

## Always use functools.wraps

Without `functools.wraps`, the wrapper replaces the original's metadata: `add.__name__` becomes
`"wrapper"`, `add.__doc__` is lost, and `inspect.signature(add)` reports `(*args, **kwargs)`.
That breaks more than documentation:

- Frameworks that route by function name (Flask, Click, pytest fixtures) may register the
  wrong name or collide on `"wrapper"`.
- `functools.lru_cache` keyed on a wrapped function, and pickling of decorated callables, can
  fail.
- `help()` and generated API docs become useless.

```python
from functools import wraps

def logged(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        ...
        return fn(*args, **kwargs)
    return wrapper
```

`wraps` copies `__module__`, `__name__`, `__qualname__`, `__doc__`, `__dict__` and sets
`__wrapped__`, which `inspect.signature` follows.

## Decorators with arguments

`@retry(times=3)` needs one more layer: the outer function receives the arguments and returns a
decorator.

```python
import time
from functools import wraps

def retry(times=3, delay=0.5, exceptions=(Exception,)):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            for attempt in range(1, times + 1):
                try:
                    return fn(*args, **kwargs)
                except exceptions:
                    if attempt == times:
                        raise
                    time.sleep(delay * attempt)
        return wrapper
    return decorator

@retry(times=4, exceptions=(TimeoutError,))
def fetch(url): ...
```

Three levels, and the mental model is: the outermost call happens at import time, once. Any
state you create there (a cache dict, a compiled regex, a counter) is shared by every call —
which is usually what you want for a cache and a bug for a counter.

Class-based decorators are cleaner when the wrapper needs state:

```python
class CountCalls:
    def __init__(self, fn):
        self.fn = fn
        self.calls = 0
        wraps(fn)(self)          # copies metadata onto the instance

    def __call__(self, *args, **kwargs):
        self.calls += 1
        return self.fn(*args, **kwargs)
```

Decorators on methods work because the wrapper is a function, so it becomes a descriptor and
receives `self` as its first positional argument. Decorators on `classmethod`/`staticmethod`
must be ordered carefully: put `@classmethod` outermost, because it must wrap the result of
your decorator, not the other way round.

## Decorators worth knowing from the stdlib

| Decorator | Use | Note |
|---|---|---|
| `functools.cache` | Unbounded memoisation | Leaks on unbounded key spaces |
| `functools.lru_cache(maxsize=N)` | Bounded memoisation | `maxsize=None` is `cache`; `typed=True` separates `1` and `1.0` |
| `functools.cached_property` | Compute once per instance | Needs `__dict__`; not for `__slots__` classes |
| `functools.singledispatch` | Type-based dispatch | Dispatches on the first argument only |
| `functools.total_ordering` | Fill in comparison methods | Requires `__eq__` and one of `__lt__` etc. |
| `contextlib.contextmanager` | Turn a generator into a CM | See below |
| `dataclasses.dataclass` | Generate `__init__`, `__repr__`, `__eq__` | `slots=True` in 3.10+ |
| `typing.final` / `override` | Intent markers for type checkers | `override` is 3.12+ |

Stacked decorators apply bottom-up at definition time:

```python
@retry(times=3)      # applied second: retries the cached call
@cache               # applied first
def expensive(x): ...
```

Here retries wrap the cache lookup, so a successful cached call never retries — order changes
semantics, not just style.

## Context managers

`with` guarantees cleanup even when the block raises. The protocol is two methods:

```python
class Timer:
    def __enter__(self):
        self.start = time.perf_counter()
        return self                      # the value bound by `as`

    def __exit__(self, exc_type, exc, tb):
        self.elapsed = time.perf_counter() - self.start
        return False                     # falsy: do not suppress the exception
```

Rules that trip people up:

- Whatever `__enter__` returns is what `as` binds. Returning `self` is conventional; returning
  `None` silently breaks `with open(...) as fh`-style usage if you expected a handle.
- `__exit__` receives `(None, None, None)` when the block succeeded. Returning a truthy value
  suppresses the exception — powerful and easy to abuse.
- `__exit__` runs on `return`, `break`, `continue` and exceptions. There is no path out of a
  `with` block that skips it short of `os._exit`.

### contextmanager: the generator form

```python
from contextlib import contextmanager

@contextmanager
def transaction(conn):
    cur = conn.cursor()
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
```

Everything before `yield` is `__enter__`; everything after is `__exit__`. The exception, if
any, is thrown *at the yield statement*, so a bare `yield` with no `try` means your cleanup code
never runs on failure. The `try/finally` is not optional in resource-managing managers.

`contextlib` also gives you `suppress(Exception)`, `redirect_stdout`, `redirect_stderr`,
`chdir` (3.11+), `nullcontext` (a no-op stand-in so code can accept an optional manager), and
`ExitStack` for a dynamic number of resources:

```python
from contextlib import ExitStack

with ExitStack() as stack:
    files = [stack.enter_context(open(p)) for p in paths]
    # all closed on exit, in reverse order, even if one of them fails later
```

`AsyncExitStack` is the asyncio equivalent. For async code the protocol is `__aenter__` /
`__aexit__` used with `async with`; `@asynccontextmanager` mirrors the sync decorator. Never
call a blocking `__enter__` inside a coroutine — it stalls the loop.

## Common mistakes

- Forgetting `@wraps`, then wondering why FastAPI shows the wrong request schema or why
  `lru_cache` grows one entry per call site.
- Using `@contextmanager` without `try/finally`, leaking file handles when the body raises.
- Suppressing exceptions in `__exit__` by returning `True` "to be safe" — the caller then
  believes the operation succeeded.
- Making a context manager non-reentrant and then nesting it (a lock or a cursor reused in a
  loop). Either support nesting with a depth counter or document it.
- Decorating a function before a framework registers it, so the framework stores the wrapper
  while your tests call the original.
- Caching a method with `@cache` where `self` is part of the key: the cache holds every
  instance alive forever.

## Production notes

Decorators are where cross-cutting concerns live: retries, timing, auth checks, tracing spans,
rate limiting. Keep them small and keep their failure behaviour explicit — a retry decorator
that retries `ValueError` will turn a deterministic bug into a 30-second timeout.

For observability, prefer a decorator that records into a metrics client over one that prints.
A timing decorator is three lines and pays for itself the first time an endpoint's p99 triples:

```python
def timed(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        t0 = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            STATS.observe(fn.__qualname__, time.perf_counter() - t0)
    return wrapper
```

Context managers are the right tool for anything with a lifecycle: connections, transactions,
temporary directories, patched globals in tests, log correlation IDs. If you find yourself
writing setup at the top of a function and cleanup at the bottom, that is a context manager
waiting to be extracted.
