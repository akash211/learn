# Data Structures and Complexity

Most Python performance problems are the wrong container for the access pattern, not a slow
interpreter. This chapter builds the cost model for picking one in ten seconds, then covers the
built-ins you use daily and three stdlib modules that replace hand-rolled loops.

## The cost model

CPython's built-in containers are not abstract data types with hidden costs; they are concrete
implementations with published behaviour. Learn these three facts and most choices follow:

- A `list` is a contiguous array of pointers. Indexing is O(1); search is O(n); appending is
  amortised O(1) because the array over-allocates.
- A `dict` is a hash table. Lookup, insert and delete are O(1) on average, O(n) in the
  pathological case where every key collides.
- A `set` is a `dict` without values: same hashing, same O(1) average membership.

"Average" matters. Hashing a key costs O(len(key)) for strings, and a bad `__hash__` turns your
O(1) table into a linked list. Custom objects inherit identity hashing, which is fine until you
define `__eq__` and forget `__hash__` — then the object becomes unhashable and drops out of sets
and dict keys entirely.

| Operation | list | dict / set | deque | heap |
|---|---|---|---|---|
| Index / key access | O(1) | O(1) avg | O(n) middle, O(1) ends | O(1) peek min |
| Membership test | O(n) | O(1) avg | O(n) | O(n) |
| Insert at front | O(n) | — | O(1) | — |
| Append / push | O(1) amortised | O(1) avg | O(1) | O(log n) |
| Delete by value | O(n) | O(1) avg | O(n) | O(log n) |
| Ordered iteration | insertion order | insertion order | insertion order | heap order only |

## list: the default, with two traps

`list` over-allocates on append: when it runs out of room CPython grows the buffer by roughly
1/8 plus a small constant. That is why `append` is amortised O(1) rather than O(n) — the
occasional resize copies everything, but the copies are spread across enough appends to average
out. Preallocating with `[None] * n` only helps when you then assign by index; it does nothing
for `append`.

The two traps are `pop(0)` and `x in my_list` inside a loop. Both are O(n), so a loop over n
items becomes O(n²). On 10,000 rows that is invisible; on 10 million it is the difference
between seconds and hours.

```python
# O(n^2): re-scans the list for every row
for row in rows:
    if row.id in seen_ids_list:
        ...

# O(n): hash lookup, or O(1) amortised inserts
seen_ids = set()
for row in rows:
    if row.id in seen_ids:
        ...
    seen_ids.add(row.id)
```

`list` also supports slicing, which copies; `data[1:]` in a recursive function allocates a new
list at every level.

## dict and set: the workhorses

Since 3.7 dicts preserve insertion order as a language guarantee, and since 3.6 the
implementation is a "compact dict": a dense array of entries plus a sparse index table. The
practical consequences are a smaller memory footprint than the old design, fast iteration in
insertion order, and the fact that deleting keys does not compact the table — a dict that grows
to a million keys and then shrinks to ten keeps the large table until you rebuild it with
`dict(d)` or `{k: v for k, v in d.items()}`.

`set` operations are the reason to reach for sets at all: `|`, `&`, `-`, `^` are O(len(smaller))
and express intent far better than nested loops. Deduplicating while preserving order is
`list(dict.fromkeys(items))` — it works for any hashable item and is faster than a manual
seen-set loop because the loop moves into C.

Sets and dicts are unordered in the sense that iteration order for a `set` is a function of hash
values, not insertion. Never rely on set ordering; it changes with `PYTHONHASHSEED` for strings,
which is randomised per process by default — a security feature (hash flooding) and the reason a
set-to-list comparison can differ between your machine and CI.

## tuple, and when immutability pays

A `tuple` is a fixed-size array of pointers. It is cheaper than a list by one allocation and a
few words of header, it is hashable if its contents are, and it can be a dict key or set member.
Use it for records whose shape is fixed — coordinates, `(key, value)` pairs, function return
values with multiple parts — and for anything you want to guarantee cannot be mutated by a
callee. A named tuple (`typing.NamedTuple` or `collections.namedtuple`) adds attribute access
for readability at the same memory cost. For records with behaviour, a `@dataclass(frozen=True,
slots=True)` is usually the better answer.

## deque, heapq, bisect

Three stdlib modules cover the cases where `list` is the wrong shape.

`collections.deque` is a doubly linked list of fixed-size blocks. `append` and `popleft` are
O(1) and it is bounded with `maxlen`, which makes it the correct FIFO queue, the correct sliding
window, and the correct "last N log lines" buffer:

```python
from collections import deque

window = deque(maxlen=1000)
for event in stream:
    window.append(event)          # oldest is dropped automatically
```

Indexing into the middle of a deque is O(n) — it walks the blocks.

`heapq` maintains a binary heap inside a plain list. `heappush` and `heappop` are O(log n),
`heapify` is O(n), and it is a min-heap only. For a max-heap, push negated values or tuples
whose first element is negated. The standard "top K" pattern is `heapq.nlargest(k, iterable)`,
which is O(n log k) and beats sorting when k is small. Heaps are not sorted: only `heap[0]` is
guaranteed to be the minimum.

`bisect` does binary search on an already-sorted list: `bisect_left`, `bisect_right`, `insort`.
Search is O(log n); insertion is O(n) because the list shifts. That is still fastest for a few
thousand elements with frequent reads and rare writes; beyond that, a tree or a database index
is the answer.

## Choosing in practice

Stop at the first match:

1. Fixed record, no mutation → tuple or frozen dataclass.
2. Membership or dedupe → set (or dict if you need the payload).
3. FIFO / bounded buffer → deque.
4. Repeated min/max extraction → heapq.
5. Sorted data with binary search → bisect over a list.
6. Numeric arrays, element-wise maths → `array.array` or NumPy, not a list of floats.

NumPy deserves the caveat: a list of 10 million floats stores 10 million boxed objects plus
pointers; `array('d')` stores 80 MB of raw doubles. If you are doing arithmetic over a large
numeric sequence in pure Python loops, the container is not your problem — the interpreter is.

## Memory: what things actually cost

`sys.getsizeof` reports the object header and its direct buffer, not the objects it points to.
On a typical 64-bit CPython 3.12 build, `sys.getsizeof([])` is 56 bytes and
`sys.getsizeof({})` is 64. A list of 1,000 small ints reports a few thousand bytes for the
pointer array plus 28 bytes per distinct int object. To measure the real footprint of a
structure, use `tracemalloc` snapshots or `pympler.asizeof`.

Per dict entry the overhead is about three words plus an index slot; a list slot is one
pointer. That is why a list of tuples often beats a list of dicts for tabular data, and why
columnar layouts beat row-wise ones at scale.

## Common mistakes

- Using a list as a queue: `pop(0)` is O(n). Use `deque`.
- Checking membership in a list inside a loop: O(n²).
- Mutating a dict while iterating it: `RuntimeError: dictionary changed size during iteration`.
  Iterate over `list(d)` or build a new dict.
- Assuming set iteration order is stable or sorted.
- Using a mutable default such as `def f(cache={})` — the dict is shared across calls.
- Defining `__eq__` without `__hash__`, making the object unusable as a key.

## Production notes

Container choice shows up in profiles as flat time in `list.__contains__` or `dict.get`. When a job is 10x slower than expected, check the access pattern before you check
the interpreter. Two concrete wins that recur: replacing a seen-list with a seen-set in
dedupe stages, and replacing `list.pop(0)` with `deque.popleft()` in queue-draining loops.

Watch unbounded caches. A module-level dict used as a memo grows with cardinality; if the key
space is user IDs or request paths, it is a leak with a friendly name. Cap it (`functools.lru_cache(maxsize=...)`)
or expire entries.
