# Heaps, Top-K and Streaming

## Core model

heapq is a min-heap: the root is smallest, not a complete sorted order. Push/pop cost O(log n), peek O(1), and heapify O(n). For k largest values, maintain a min-heap of size k; replace its root only for a larger arrival. This uses O(k) space and O(n log k) time. Sort the final k items only if ordered output is required.

## Recognize and prove the pattern

For most-frequent items, count then maintain a bounded heap or bucket by frequency. Specify deterministic ties. A running median uses a max-heap for the lower half and min-heap for the upper half; balance their sizes and read the roots. Streaming state is bounded only if the algorithm explicitly caps retained history.

## Costs and implementation

Tuple entries compare left to right. Include a sequence number after priority to avoid comparing non-orderable payloads. Dijkstra may leave stale heap entries; skip entries whose distance no longer matches the best-known value. heapq lacks efficient arbitrary deletion/decrease-key; lazy duplicates are a common alternative.

## Edge cases

Test k=0, k>n, all equal, negative values and ascending/descending input. Counting top-k frequent values also stores O(u) distinct keys. Define tie order and empty-stream behavior. A heap is valuable when k is small or priorities arrive incrementally.

## Worked reasoning checklist

Treat the prompt as a contract. Identify the input domain, valid outputs, allowed mutation, and constraints before selecting a pattern. A solution that silently assumes positive values, unique keys, sorted input, or a connected graph is only correct if the contract guarantees that property. When it is not stated, ask or choose a method that handles the broader case. Keep the assumption visible in the explanation.

Write down the state your algorithm maintains. For a pointer algorithm, describe the region already proved irrelevant. For a queue, say what ordering it represents. For recursion, define the meaning of a call and its base result. For dynamic programming, define what each state means before writing a recurrence. This turns code into an implementation of an argument: initialization establishes the invariant, each operation preserves it, and termination leaves the requested answer.

Use a tiny trace to challenge the reasoning. Include an empty or smallest input, repeated values, a boundary transition, and an adversarial ordering such as ascending or descending data. Check that indices remain in range, that a queue or stack cannot grow without bound unexpectedly, and that duplicate candidates do not create duplicate output unless they represent distinct valid answers. A hand trace often reveals an off-by-one error earlier than a large test.

Derive complexity from the actual work. Count visits, insertions, removals, comparisons, and allocations. If each item is pushed and popped once, a nested loop can be linear. If every recursive branch copies a suffix, copying can dominate. Include preprocessing and output construction. Report auxiliary space separately from returned output, and name expected-time hash assumptions. Python’s built-ins have their own contracts: list front deletion shifts elements, slicing copies, dictionaries hash keys, and recursion uses interpreter stack frames.

In an interview, begin with a clear baseline and its cost, then explain why an improvement is possible. Choose a data structure because it supports the required operation, not because it is familiar. State the key invariant before coding, trace one example, and then implement small helpers with clear names. Afterward, test boundary cases and state time, space, mutation, and return behavior. If a constraint changes, revisit the proof: many familiar optimizations fail when a hidden assumption, such as nonnegative values or unweighted edges, is removed.

### Common mistakes and production notes

Do not claim worst-case O(1) for ordinary hash lookup, omit space for a set or memo table, or call a Python list a queue when repeatedly removing from the front. Do not confuse sorting order with a heap’s partial order. Mark graph vertices when enqueued, not only when dequeued. Define duplicate handling, empty-input behavior, and whether the caller’s data may be mutated. Prefer a simpler proven approach over a clever one whose boundary conditions are unclear.

### Practice prompt

Explain the simplest correct solution, then improve it while preserving the contract. State one invariant, prove why it is maintained, and give a bound in terms of the actual input dimensions. Walk through one normal and one adversarial example. Finally explain what changes if the input grows, is streamed, contains duplicates, or loses an assumption. This rehearsal makes the technique transferable to variants rather than memorized for one exact statement.
## Worked example: retain the k largest values

To keep the three largest values from the stream `4, 1, 7, 3, 8`, use a min-heap of capacity three. Push until full: after 4, 1, 7 the root is 1, the smallest retained candidate. When 3 arrives, replace 1 because 3 is larger; when 8 arrives, replace the new root 3. The heap contains 4, 7, 8, and its root 4 is the third-largest value. Any discarded value was no larger than the smallest retained candidate, so it cannot enter the final top three unless later candidates are also discarded; the fixed-size invariant remains valid.

Building through individual pushes costs O(n log k), with O(k) state. If all values are already available, `heapq.nlargest` or sorting may be simpler; sorting costs O(n log n), while a bounded heap is attractive when k is much smaller than n or values arrive incrementally. Do not promise ordered output from the heap—sort the retained items if the caller needs ranking order.

| Operation | Complexity | Practical note |
|---|---:|---|
| Peek minimum | O(1) | Root only |
| Push / pop | O(log n) | Maintains heap invariant |
| Heapify n items | O(n) | Faster than n separate pushes |
| Keep k best from n | O(n log k) | O(k) heap state |
| Sort final k results | O(k log k) | Needed only for ordered output |

## Priority queues for live state

A running median uses two heaps: a max-heap for the lower half and a min-heap for the upper half. Python’s `heapq` is min-oriented, so represent lower values as negatives. Maintain size difference at most one and ensure every lower-half value is no greater than every upper-half value. The median comes from one root or their average. For Dijkstra, a heap may contain multiple distance entries for one vertex; when popping, skip entries that no longer equal the best-known distance. This lazy deletion avoids needing decrease-key, but stale entries consume temporary memory.

Tuples in Python heaps compare lexicographically. If priorities tie, a payload may be compared and raise `TypeError` when payload objects are not orderable. Add a unique sequence number after priority, e.g. `(priority, counter, task)`, to guarantee a deterministic tie break without comparing tasks. Specify whether equal-priority items need stable order.

## Common mistakes and production notes

Do not treat a heap as globally sorted or remove arbitrary items by scanning if updates are frequent. Handle k=0, k greater than the input size, empty streams, negative values, and ties. Frequency top-k additionally stores counts for all u distinct values, even if the selection heap is size k. A memory limit must account for Python object and dictionary overhead, not just the number of entries. For distributed top-k, each shard can send its local top-k candidates for a global merge under compatible ranking and tie rules; this relies on the same score semantics at every shard.

