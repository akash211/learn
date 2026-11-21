# Iterators, Generators and itertools

Iteration is Python's main abstraction for "a stream of things". Getting it right is what lets
you process a 40 GB file on a laptop, and getting it wrong produces the two most common bugs in
data code: an exhausted generator and a `groupby` that returns one group per row.

## The iterator protocol

Two dunder methods define the protocol:

- `__iter__` returns an iterator. On an iterable it returns a fresh iterator; on an iterator it
  returns `self`.
- `__next__` returns the next value or raises `StopIteration`.

A `for` loop is sugar for:

```python
it = iter(container)          # calls container.__iter__()
while True:
    try:
        item = next(it)       # calls it.__next__()
    except StopIteration:
        break
    handle(item)
```

The distinction that matters: an **iterable** can produce an iterator many times (a list, a
dict, a file path). An **iterator** produces its values once, then is permanently exhausted. A
list is iterable but not an iterator; a generator is both.

```python
nums = [1, 2, 3]
it = iter(nums)
list(it)      # [1, 2, 3]
list(it)      # []  — same object, already exhausted
```

Anything with `__iter__` works in `for`, in `list()`, in unpacking, and in comprehensions. That
is the whole extension point: you rarely need to write an iterator class, because a generator
does it for you.

## Generators: suspended functions

A function containing `yield` compiles to a generator function. Calling it does not run the
body; it returns a generator object holding a frame. Each `next()` resumes the frame until the
next `yield`, which suspends it and hands the value out. Local variables, the instruction
pointer and the exception state survive between resumptions.

```python
def read_records(path):
    with open(path) as fh:
        for line in fh:                 # file objects are iterators: one line at a time
            line = line.strip()
            if line:
                yield line

for record in read_records("events.jsonl"):
    process(record)                     # constant memory, regardless of file size
```

That is the core idiom of streaming ETL. The alternative — `fh.readlines()` — allocates the
whole file. The generator version holds one line at a time, and the `with` block stays open for
the lifetime of the generator, closing when the generator is garbage collected or exhausted.

Because the frame is a real object, generators have properties functions do not:

- They cannot be pickled, so they cannot cross a process boundary. `ProcessPoolExecutor` will
  refuse a generator argument; materialise it or pass a factory.
- They hold references to everything in their frame, including open files and large
  intermediates. A half-consumed generator is a leak with a delay fuse.
- They are not reusable and have no `len`. If you need two passes, either call the function
  twice or `itertools.tee` (which buffers the difference in memory — often worse than two
  passes).

### Sending values in

`yield` is an expression. `gen.send(value)` resumes the generator with that value as the result
of the `yield`, which is how coroutine-style pipelines are built:

```python
def averager():
    total, count = 0.0, 0
    while True:
        value = yield (total / count if count else None)
        total += value
        count += 1

avg = averager()
next(avg)          # prime: run to the first yield, returns None
avg.send(10)       # 10.0 — first value sets the average
avg.send(20)       # 15.0
```

You must prime with `next()` before the first `send`. `throw()` raises inside the generator at
the suspension point; `close()` raises `GeneratorExit` there, and the generator must not yield
again or it gets `RuntimeError`. `yield from subgen` delegates iteration and forwards `send`,
`throw` and `close`, and evaluates to the sub-generator's `return` value — that is how
recursive generators and `asyncio` coroutines compose.

## Generator expressions

`(expr for x in it if cond)` is a lazy generator expression. It is not a tuple comprehension,
despite the parentheses. Compared to a list comprehension it saves the intermediate list and
starts producing immediately, at the cost of being single-use and slightly slower per item.

```python
total = sum(len(line) for line in fh)          # no list built
squares = (x * x for x in range(10))           # generator object
```

Pass a generator expression as the sole argument without extra parentheses:
`any(x < 0 for x in values)` — this short-circuits, unlike `any([x < 0 for x in values])`.

## itertools: the standard vocabulary

`itertools` is C-implemented and covers almost every loop you were about to write by hand.

| Function | Does | Watch out |
|---|---|---|
| `chain(a, b)` / `chain.from_iterable(xss)` | Concatenate | Lazy; `from_iterable` for a stream of streams |
| `islice(it, start, stop, step)` | Slice an iterator | No negative indices; consumes as it goes |
| `groupby(it, key)` | Consecutive groups | Input must be sorted by the same key |
| `accumulate(it, func)` | Running fold | Default is addition; `initial=` since 3.8 |
| `pairwise(it)` | Overlapping pairs | 3.10+; replaces `zip(it, it)` tricks |
| `batched(it, n)` | Fixed-size tuples | 3.12+; last batch may be short |
| `product`, `permutations`, `combinations` | Cartesian / combinatorics | Output explodes; never materialise blindly |
| `count`, `cycle`, `repeat` | Infinite iterators | Must be bounded by `islice`/`zip`/`takewhile` |
| `tee(it, n)` | n independent iterators | Buffers unseen items; memory grows with lag |
| `takewhile` / `dropwhile` | Prefix/suffix by predicate | `dropwhile` then `takewhile` is a common filter |

`groupby` deserves its own warning. It groups *consecutive* equal keys, not all equal keys, and
the group iterator is invalidated as soon as you advance the outer iterator:

```python
from itertools import groupby
from operator import itemgetter

rows.sort(key=itemgetter("country"))       # mandatory
for country, group in groupby(rows, key=itemgetter("country")):
    total = sum(r["amount"] for r in group)  # consume before advancing
    print(country, total)
```

If you need random access to groups, build a dict of lists instead. If you forget the sort you
get one group per change of key — the bug looks like duplicate output, not an exception.

`batched` is the modern replacement for the chunking recipe:

```python
from itertools import batched        # Python 3.12+

for batch in batched(records, 500):
    db.execute_many(INSERT, batch)
```

Before 3.12 the idiom was `iter(lambda: list(islice(it, n)), [])`, which is correct but opaque.

## Building pipelines

Generator stages compose into a pipeline where nothing runs until the consumer pulls:

```python
def parse(lines):
    for line in lines:
        yield json.loads(line)

def only_errors(events):
    for e in events:
        if e.get("level") == "ERROR":
            yield e

pipeline = only_errors(parse(read_records("app.jsonl")))
for event in pipeline:
    ...
```

Each stage is testable in isolation and memory stays flat. The failure mode is a stage that
buffers — a `sorted()`, a `list()`, a `Counter` — which silently converts your streaming job
into an in-memory one. Audit pipelines for those calls.

## Common mistakes

- Reusing an exhausted generator. Symptom: the second loop over it does nothing, no error.
- `len(gen)`, indexing, or slicing a generator. Convert to a list if you truly need random
  access, and accept the memory.
- `groupby` without sorting by the key first.
- Returning a generator from `__init__`-style setup where the caller expects a reusable
  collection.
- Holding a generator that wraps an open file, long after you are done with it.
- Building `list(product(a, b))` when `a` and `b` have 10,000 elements each.

## Production notes

Streaming is the default posture for ingestion code: read a line, transform, write, never hold
the file. When a job's memory grows linearly with input size, look for the stage that calls
`list()` or `sorted()` on the full stream.

Generators are also the cheapest way to batch database writes: `batched()` plus
`executemany` turns 100,000 single-row inserts into 200 round trips. Measure both — on a local
Postgres the difference is typically two orders of magnitude in wall time.

Finally, remember that `StopIteration` escaping a generator body is converted to `RuntimeError`
(PEP 479). If you call `next()` inside a generator, catch `StopIteration` and `return`
explicitly, or your generator dies with a confusing error.
