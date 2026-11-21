# Collections, Iterators, and Zero-Cost Abstractions

Rust's standard collections cover common storage shapes, while iterator adapters express data transformations as composable operations. The compiler often inlines and optimizes these abstractions so the resulting machine code need not pay for a chain of conceptual operations. “Zero-cost” is a design goal, not a guarantee that every abstraction is free: allocation, cloning, dynamic dispatch, and poor algorithm choices still cost real resources.

## Choosing a collection

`Vec<T>` is a growable contiguous array and the default sequence choice. Indexing is constant time, iteration is cache-friendly, and appending is amortized constant time; inserting near the beginning shifts elements. `String` is UTF-8 text backed by a byte vector. A string index is not a character index: use `.chars()` for Unicode scalar values or grapheme-aware libraries for user-perceived characters.

`HashMap<K, V>` provides average constant-time lookup and is appropriate for key-based retrieval, but has hashing and allocation costs and no stable iteration order. `BTreeMap` keeps keys ordered and offers logarithmic operations; choose it when order or range queries matter. `HashSet` and `BTreeSet` model membership without a dummy value. `VecDeque` is useful for efficient operations at both ends; `BinaryHeap` supports priority-queue behavior. Choose by operation profile, not by the most familiar type.

For a collection of optional values, consider whether sparse representation or a map better models the data. Avoid storing references in collections unless their lifetime is genuinely bounded by an owner that outlives the collection. Owned values often make APIs easier to use.

## Iterators are lazy pipelines

An iterator produces items on demand. Methods such as `map`, `filter`, `take`, `enumerate`, and `zip` create adapters but do not consume the input. A terminal operation—`collect`, `sum`, `fold`, `for_each`, or a `for` loop—drives the pipeline:

```rust
let squares: Vec<i32> = (1..=5)
    .filter(|&n| n % 2 == 1)
    .map(|n| n * n)
    .collect();
assert_eq!(squares, vec![1, 9, 25]);
```

Because adapters are lazy, forgetting a terminal operation means the work never happens. `collect`'s target type is inferred from context or specified explicitly; use `collect::<Result<Vec<_>, _>>()?` to collect a sequence of fallible operations and stop on the first error. `filter_map` is useful when each input may or may not produce an output; `flat_map` joins nested iterables.

`iter()` yields shared references, `iter_mut()` yields mutable references, and `into_iter()` consumes the collection and yields owned items. This distinction explains many move errors. When transforming a vector into another owned vector, consuming `into_iter()` may avoid cloning. When retaining the original, borrow and clone only the elements that truly need ownership.

## Folding and allocation

`fold` makes an accumulator explicit and works for reductions more general than `sum`:

```rust
let total = [2, 4, 6].iter().fold(0, |sum, value| sum + value);
assert_eq!(total, 12);
```

Prefer the clearest standard adapter over a hand-written loop when it communicates intent. Conversely, a straightforward loop is often easier to debug when it has complex mutation or early exits. Reserve capacity when a reliable size estimate is available (`Vec::with_capacity`), but do not guess a huge capacity that multiplies across many requests. Repeated string concatenation can reallocate; use `String::with_capacity` or `write!` into a buffer where it improves clarity and the size is predictable.

## Zero-cost does not mean cost-free

Static generics and iterator adapters can compile down to efficient loops, but monomorphization may increase binary size and compile time. `Box<dyn Trait>` enables dynamic dispatch and can require heap allocation. `clone()` may copy or allocate. `collect()` often allocates a new collection. A chain that looks elegant can still do unnecessary passes if it has multiple terminal operations; when performance matters, inspect allocation profiles and benchmark representative input.

## Common mistakes

- Using `String` byte indexes as if they were character positions.
- Expecting iterator adapters to run before a terminal operation.
- Calling `collect` on a large or unbounded iterator without considering memory growth.
- Cloning every element to work around ownership when consuming or borrowing would fit.
- Assuming `HashMap` iteration order is stable across runs.

## Production notes

Model data for the operations the workload performs. A `Vec` scan may beat a hash lookup for a tiny collection due to locality; a sorted tree may simplify range semantics; measure before changing the structure. Bound input before collecting it, particularly in network-facing code. For maps, choose a hasher according to the threat model; the default is designed to resist common hash-flooding attacks, while faster alternatives need an explicit security review. Prefer iterator code that communicates intent, but do not force a pipeline into one expression if named intermediate steps would make ownership, error propagation, or allocation clearer. Tests should cover empty iterators, duplicate keys, Unicode boundaries, and the intended ordering guarantees.

## Build a pipeline with ownership in mind

Adapters are lazy; receiver types determine whether the pipeline borrows or consumes. `iter()` yields references, `iter_mut()` yields mutable references, and `into_iter()` transfers owned elements. Avoid cloning until the result truly needs ownership.

```rust
fn positive_labels(values: &[i32]) -> Vec<String> {
    values.iter().copied().filter(|value| *value > 0)
        .enumerate().map(|(index, value)| format!("{index}:{value}")).collect()
}
fn main() { assert_eq!(positive_labels(&[-2, 4, 7]), vec!["0:4", "1:7"]); }
```

Here `copied` converts references to small integer values, `filter` retains positive entries, and `enumerate` assigns positions after filtering. Changing the order would preserve original positions instead. `collect` drives the chain and allocates the output vector; the adapters themselves do not construct intermediate vectors. `filter_map` combines rejection and transformation, and `flat_map` lets one input produce zero or more outputs. `take`, `find`, `any`, and `all` can short-circuit. Use `fold` for a custom accumulator, but prefer `sum` where it says the same thing more clearly.

## Fallible iteration and collection choices

An iterator of `Result<T, E>` can collect into `Result<Vec<T>, E>`, stopping at the first error. If partial success matters, handle each result and collect both successes and failures deliberately; `filter_map(Result::ok)` discards diagnostic information. A chain is often single-pass; build a collection when you need random access or multiple traversals.

Choose collections by operations. `HashMap` supports average constant-time key lookup; `BTreeMap` provides order and range queries. `VecDeque` fits queue work at both ends. A linear scan over a small vector can outperform a map while remaining simpler. Reserve capacity only with a reliable size estimate, and benchmark realistic workloads before trading memory for fewer reallocations.

For text, bytes, Unicode scalar values, and grapheme clusters are not interchangeable. `str::len()` counts bytes, `.chars()` yields scalar values, and user-perceived characters may require a Unicode segmentation library. Use the unit that matches the operation to avoid indexing and display bugs.

## Iterator debugging and performance

When a chain produces an unexpected result, name an intermediate iterator or add a temporary `inspect` adapter to observe values without collecting a second vector. Also check whether a predicate receives a reference to an item, as `filter` does, or the item itself, as `map` does. That distinction explains many confusing dereferences. Avoid side effects in `map` when the intent is iteration for effects; a `for` loop or `for_each` communicates that purpose more clearly.

Iterator chains are often optimized well, but they do not guarantee a faster algorithm. Nested iteration over two large collections may still perform quadratic work, and a hash-based lookup may be preferable when its setup cost is justified. Likewise, repeated calls to `collect` or repeated terminal traversals repeat work. Benchmark the complete operation with representative data sizes and distribution, not just the closure body. Readability, allocation behavior, and asymptotic complexity matter more than whether the source is written as a chain or a loop.
