# Functions, Arguments and Closures

Python's argument system is more expressive than most languages' and more forgiving than most
reviewers would like. Knowing the exact rules lets you design APIs that are hard to call
wrongly, and it explains a family of bugs — mutable defaults, late binding, shadowed builtins —
that otherwise look like magic.

## The five parameter kinds

A signature can mix five kinds, in this order:

```python
def f(pos_only, /, normal, *, kw_only, **kwargs): ...
```

| Kind | Syntax | Can be passed by |
|---|---|---|
| Positional-only | `a, /` | Position only |
| Positional-or-keyword | `b` | Either |
| Variadic positional | `*args` | Extra positional, as a tuple |
| Keyword-only | `*, c` | Keyword only |
| Variadic keyword | `**kwargs` | Extra keyword, as a dict |

`/` and `*` are markers, not parameters. Everything before `/` cannot be passed by name;
everything after `*` must be.

Positional-only is not decoration. It lets you rename a parameter later without breaking
callers, and it lets an implementation use the name internally — that is why
`len(obj=x)` fails on builtins. Use it for arguments whose name is an implementation detail.
Use keyword-only for booleans and options, because `save(data, True, False)` is unreadable:

```python
def save(data, *, overwrite=False, compress=False): ...

save(payload, overwrite=True)      # obvious at the call site
```

## Defaults are evaluated once

Default values are evaluated when the `def` statement executes, not per call. A mutable default
is therefore shared across every call:

```python
def append_one(item, target=[]):        # BUG
    target.append(item)
    return target

append_one(1)      # [1]
append_one(2)      # [1, 2]  — same list
```

The fix is the sentinel idiom:

```python
def append_one(item, target=None):
    if target is None:
        target = []
    target.append(item)
    return target
```

`None` is safe because nothing legitimate passes `None` as the target. When `None` *is* a valid
argument, use a module-level singleton: `_MISSING = object()`.

The same rule explains why `datetime.now()` as a default freezes the import time — a classic
bug in cache-expiry code.

## Argument unpacking

`*iterable` and `**mapping` at a call site unpack. This is how you forward arguments without
knowing the signature, and it is the backbone of decorators and wrappers:

```python
def wrapper(*args, **kwargs):
    return original(*args, **kwargs)
```

You cannot unpack a generator into `**`, and you cannot pass the same keyword twice
(`f(**a, **b)` raises `TypeError` when keys collide). `*` unpacking in literals is fine:
`[*a, *b]`, `{**defaults, **overrides}` — the latter is the standard "merge with precedence"
idiom and evaluates left to right.

## Closures and scope

Python resolves names with the LEGB rule: Local, Enclosing, Global, Builtin. A nested function
that reads a variable from its enclosing function closes over it — the variable lives in a cell
object shared by both frames, so the inner function sees later mutations:

```python
def make_counter():
    count = 0
    def increment():
        nonlocal count
        count += 1
        return count
    return increment

c = make_counter()
c(), c()          # (1, 2)
```

Without `nonlocal`, `count += 1` would create a new local and raise `UnboundLocalError`. The
same applies at module level with `global`, which you should treat as a design smell: module
state mutated by functions is untestable in parallel and invisible in signatures.

### Late binding

Closures capture *variables*, not values. The classic bug:

```python
funcs = [lambda: i for i in range(3)]
[f() for f in funcs]      # [2, 2, 2], not [0, 1, 2]
```

All three lambdas share the same `i` cell, which is `2` by the time they run. Bind it as a
default argument (evaluated at definition time) or a `functools.partial`:

```python
funcs = [lambda i=i: i for i in range(3)]     # [0, 1, 2]
```

The same trap appears in callbacks registered in loops and in `Thread(target=lambda: worker(x))`
inside a `for` — every thread gets the last value of `x`. Type checkers do not flag this.

### Closures vs classes

A closure is the right tool for one function with a bit of private state. When you need several
related operations, introspection, or pickling, use a class — closures are not picklable
(standard `pickle` cannot serialise a function object by value), which matters the moment you
send work to a process pool.

## Callables, partials and higher-order style

Anything with `__call__` is callable. `functools.partial` pre-binds arguments and is cheaper
and more transparent than a lambda:

```python
from functools import partial

def fetch(url, *, timeout, retries): ...

fetch_api = partial(fetch, timeout=5, retries=2)
fetch_api("https://example.com/health")
```

`partial` objects expose `.func`, `.args`, `.keywords` and work with `inspect.signature`, which
lambdas do not. Use `functools.partialmethod` for methods.

Functions are first-class: pass them to `sorted(key=...)`, `map`, `filter`, `defaultdict`,
thread pools. Prefer a named function over a lambda when the logic exceeds one expression —
tracebacks show `<lambda>` with no name, and coverage tools cannot attribute it.

## Return values and sentinels

Returning `None` to signal failure forces every caller to remember an `if result is None` check,
and it conflates "not found" with "found nothing". Options, in order of preference:

1. Raise an exception when absence is exceptional.
2. Return a sentinel when absence is normal: `_MISSING = object()`.
3. Return `(found, value)` when callers need to branch without exceptions.

Early returns keep functions flat. A function that nests four `if`s to reach a single return is
harder to review than one that returns on the guard conditions.

## Common mistakes

- Mutable default arguments (`def f(x, acc=[])`, `def f(cache={})`).
- Late-binding closures in loops.
- Shadowing builtins: `list = [...]`, `dict = {}`, `id = 5`, `type = "user"`. The damage appears
  three files away when someone calls `list(...)` and gets a `TypeError`.
- Using `is` for value comparison (`x is 1000` may be `False`; use `==`). `is` is for `None`,
  `True`, `False` and sentinels.
- Forgetting that `*args` is a tuple and `**kwargs` a dict — mutating them mutates the caller's
  objects.
- Writing `def f(a, b=1, *args)` and expecting `b` to be keyword-friendly; it is positional-or-keyword
  and silently shifts when callers pass positionally.

## Production notes

Keyword-only booleans and positional-only implementation details are the two signature changes
that most improve a codebase's call sites. When reviewing an API, ask: can this be called
wrongly and still run? `send(email, True)` can; `send(email, dry_run=True)` cannot.

For hot paths, local variable binding beats attribute lookup — `append = out.append` before a
long loop is measurably faster because it avoids a method lookup per iteration. It is a
micro-optimisation; do it only after a profile says the loop matters, and never at the cost of
readability in cold code.

Finally, beware of functions that mutate their arguments. A function that sorts a list in place
and also returns it invites callers to assume purity. Document mutation, or copy on the way in
when the input is small.
