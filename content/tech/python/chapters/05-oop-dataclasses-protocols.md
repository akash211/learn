# OOP, Dataclasses and Protocols

Python's object model is small: classes are objects, instances have a `__dict__` unless you say
otherwise, and attribute lookup walks a linearised MRO. Most of what looks like advanced OOP is
consequence of those three facts. This chapter covers the parts that change code quality —
`super()`, slots, dataclasses, and structural typing — and skips the parts that only exist in
interviews.

## Classes, instances and the attribute lookup order

`self.x` resolves in this order: data descriptors on the type (`property`, functions are
non-data descriptors), the instance `__dict__`, then non-data descriptors and class attributes.
This is why a `property` cannot be shadowed by an instance attribute, and why assigning to a
class attribute after creating instances changes what they report.

```python
class Config:
    debug = False

a, b = Config(), Config()
Config.debug = True
a.debug          # True — looked up on the class, not copied to the instance
```

Class-level mutable attributes are worse than that: they are shared by every instance.

```python
class Registry:
    items = []              # BUG: one list for all instances
    def add(self, x):
        self.items.append(x)   # mutates the class attribute
```

Assigning `self.items = []` in `__init__` fixes it. The bug is silent until two instances exist.

## Inheritance, MRO and super()

Python supports multiple inheritance with C3 linearisation: the MRO is a deterministic order
that respects "appears before its bases" and "bases in declaration order". `ClassName.__mro__`
shows it. Cooperative multiple inheritance works when every class calls `super().__init__(**kwargs)`
and passes the rest along:

```python
class Base:
    def __init__(self, **kwargs):
        super().__init__(**kwargs)

class Logged(Base):
    def __init__(self, logger, **kwargs):
        self.logger = logger
        super().__init__(**kwargs)

class Retried(Base):
    def __init__(self, retries=3, **kwargs):
        self.retries = retries
        super().__init__(**kwargs)

class Client(Logged, Retried):
    pass
```

`Client(logger=log, retries=5)` walks `Client → Logged → Retried → Base → object`, each
consuming its own keyword. This is the pattern behind mixins; it breaks the moment a class in
the chain forgets to call `super()` or hard-codes arguments.

Prefer composition to inheritance when the relationship is "has a" or "uses". Deep hierarchies
are hard to change because every subclass is a constraint on the base.

## Dunder methods that matter

| Method | Enables | Rule |
|---|---|---|
| `__repr__` | Debugging output | Unambiguous, ideally `eval`-able |
| `__eq__` | `==`, `in`, set membership | Define `__hash__` too, or the class becomes unhashable |
| `__hash__` | dict/set keys | Must be consistent with `__eq__`; hash only immutable fields |
| `__len__` | `len()`, truthiness | Must return a non-negative int |
| `__iter__` | `for`, unpacking, `in` | Return a fresh iterator unless self is an iterator |
| `__enter__`/`__exit__` | `with` | See the context manager chapter |
| `__call__` | Instance callable | Keep it stateless or document state |

If you define `__eq__` and want instances hashable, set `__hash__` explicitly. `@dataclass(eq=True, frozen=True)`
does both correctly; a hand-written `__eq__` sets `__hash__ = None` implicitly.

`__repr__` is the highest-return dunder you can write. A log line that prints
`<User object at 0x7f3a>` costs an hour of debugging; `<User id=42 email='a@b.c'>` costs
nothing.

## __slots__ and memory

By default each instance has a `__dict__` — a hash table with per-object overhead. `__slots__`
declares a fixed set of attributes stored in the object header instead:

```python
class Point:
    __slots__ = ("x", "y")
    def __init__(self, x, y):
        self.x, self.y = x, y
```

For millions of small objects this typically cuts per-instance memory substantially (often
around half, depending on attribute count) and speeds up attribute access. The costs: no
dynamic attributes, no multiple inheritance from slotted and non-slotted bases without care,
and `__dict__`-dependent features (`functools.cached_property`, some serialisers) stop working.
Do not add slots speculatively; add them when a memory profile shows instance dicts dominating.

## Dataclasses

`@dataclass` generates `__init__`, `__repr__` and `__eq__` from annotations. It is the correct
default for data-holding classes.

```python
from dataclasses import dataclass, field

@dataclass(frozen=True, slots=True)
class Event:
    id: str
    kind: str
    payload: dict = field(default_factory=dict)
    tags: tuple[str, ...] = ()
```

Key options:

- `default_factory=` for mutable defaults. `field(default=[])` raises `ValueError` at class
  creation — the one place Python protects you from the mutable-default trap.
- `frozen=True` blocks assignment and generates `__hash__`, making instances usable as dict keys
  (provided the field values are hashable — a `dict` payload makes it unhashable at runtime).
- `slots=True` (3.10+) generates `__slots__`, but blocks adding attributes in `__post_init__`
  unless you declare them.
- `kw_only=True` (3.10+) makes all fields keyword-only, which keeps call sites readable and
  lets you add fields without breaking positional callers.
- `order=True` generates comparison methods in field order.
- `__post_init__` runs after `__init__` for validation or derived fields.

```python
@dataclass
class Range:
    lo: int
    hi: int
    size: int = field(init=False)

    def __post_init__(self):
        if self.lo > self.hi:
            raise ValueError(f"lo={self.lo} > hi={self.hi}")
        self.size = self.hi - self.lo
```

`dataclasses.replace(obj, **changes)` returns a modified copy; `asdict()` deep-copies into
dicts (slow for large trees); `fields()` drives generic serialisation. For validation beyond a
few checks, Pydantic or attrs is a better fit — attrs has converters and validators built in,
Pydantic parses external data.

## Protocols: structural typing

ABCs require inheritance. Protocols describe a shape and let any matching class qualify —
"static duck typing" checked by mypy/pyright, with optional runtime checks:

```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class Sink(Protocol):
    def write(self, chunk: bytes) -> int: ...

def drain(sink: Sink, chunks):
    for c in chunks:
        sink.write(c)

# Any object with a compatible write() works: a file, a socket, a test double.
```

Rules:

- Protocol members are structural. Adding a method to a Protocol silently breaks every
  implementer that lacks it — treat a published Protocol as an interface contract.
- `runtime_checkable` only checks method *names*, not signatures, and `isinstance` on a
  Protocol with non-method members raises `TypeError`.
- Protocols cannot be instantiated and do not participate in `super()` chains.
- Use `@abstractmethod` (ABC) when you need shared implementation or explicit registration;
  use Protocol when you want to accept "anything file-like" without forcing a base class.

Protocols are how you keep dependencies injectable: define a `Repository` protocol in the
domain layer, implement it with Postgres in the infrastructure layer, swap in an in-memory fake
in tests. No framework required.

## A short design checklist

1. Is this a record? `@dataclass(frozen=True, slots=True)`.
2. Is this behaviour over injected dependencies? A plain class with `__init__` taking them.
3. Do several classes share behaviour without an "is-a" relationship? A mixin or a function.
4. Do callers need to accept a family of implementations? A Protocol.
5. Does it need to be iterable/indexable/context-managed? Implement the two or three dunders
   that enable it, not a whole hierarchy.

## Common mistakes

- Mutable class attributes shared across instances.
- Defining `__eq__` without `__hash__`, then trying to put instances in a set.
- `super()` without arguments inside a comprehension or nested function — it needs
  `__class__` from the enclosing class scope and fails obscurely.
- Using inheritance to reuse one method; a function or composition is simpler.
- `frozen=True` with a mutable field (`list`), assuming the object is deeply immutable. It is
  only shallowly frozen — the list is still mutable.
- `isinstance` checks against Protocols with data members.

## Production notes

Dataclasses make serialisation boundaries explicit: `asdict()` at the edge, typed objects
inside. That single rule removes a class of "dict key typo" bugs that only appear at runtime.

Slots and `frozen=True` are cheap wins for high-cardinality objects — parsed log events, rows in
a batch, graph nodes. Measure with `tracemalloc` before and after; the win is real for millions
of objects and negligible for hundreds.

Protocols plus dependency injection is the most testable structure available without a
framework, and it survives refactors that break monkeypatching. If your tests patch module
globals, a Protocol-shaped seam is usually the better fix.
