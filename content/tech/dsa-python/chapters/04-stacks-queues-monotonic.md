# Stacks, Queues and Monotonic Patterns

## Core model

A stack uses append/pop at the end in amortized O(1). A FIFO queue should use collections.deque and popleft, not list.pop(0), which shifts n elements. Balanced delimiters push expected closing tokens and reject mismatches early. A queue is not a priority queue; use heapq when extracting best priority rather than oldest arrival.

## Recognize and prove the pattern

A monotonic stack stores an unresolved frontier. For next-greater values, pop indices when the current value resolves them; every index enters and leaves once, so total time is O(n). Store indices when distances or expiration matter. For histograms, a lower bar resolves right boundaries; flush remaining bars or use a sentinel.

## Costs and implementation

For sliding maximum, keep indices in decreasing-value order. Expire old front indices and remove dominated smaller values from the back. A newer larger item remains useful longer. Each index is inserted and removed at most once, for O(n) time and O(k) space. Equal-value policy affects which index survives, so define tie behavior.

## Edge cases

A two-stack queue transfers each element once, yielding amortized O(1) operations though one transfer costs O(n). Test increasing, decreasing, equal sequences and boundary window widths. A monotonic stack is not globally sorted; discarded elements are permanently irrelevant under the stated query.

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
## Worked example: next warmer day

For temperatures `[70, 73, 71, 75]`, the first day is unresolved until 73 appears; the 71 remains unresolved until 75. Store indices in a stack whose temperatures are non-increasing from bottom to top. On each new temperature, pop while the top is strictly colder: the current index is the first later warmer day for every popped index, because all intervening days were already processed and none was warmer. Store the distance `current - old_index`, then push the current index. Equal temperatures do not resolve one another, so they remain stacked. Each index is pushed once and popped at most once, giving O(n) total work despite the while loop.

The stack is an unresolved frontier, not a sorted copy of all temperatures. Indices are essential because the answer asks for distances and because equal values at different dates expire at different times. At the end, remaining entries have no warmer day and their initialized answer stays zero.

| Structure | Order represented | Python operation | Typical cost |
|---|---|---|---|
| Stack | Most recent unresolved item first | `list.append`, `list.pop` | Amortized O(1) |
| FIFO queue | Oldest item first | `deque.append`, `deque.popleft` | O(1) |
| Monotonic deque | Candidate extrema in index/value order | pop either end | O(1) amortized per item |
| Heap | Best priority at root | `heapq.heappush/pop` | O(log n) |

## Choosing and proving a monotonic structure

For next-greater queries, pop only candidates that the current item definitively resolves. For a sliding maximum, maintain decreasing values: a new larger value dominates smaller values behind it because it is better and expires later. Expire indices at the front when they fall outside the window. For a histogram, a newly lower bar closes the maximal span of taller bars; a sentinel or final flush is needed to process bars that never encounter a lower value. State strict versus non-strict comparisons carefully: changing `<` to `<=` changes how duplicates are treated and can change widths or which index survives.

A queue is not the right structure simply because items arrive over time. BFS needs FIFO order to preserve distance layers. A task scheduler ordered by priority needs a heap. `list.pop(0)` is O(n) because it shifts elements, making a nominal BFS potentially quadratic; `collections.deque` avoids that cost. Two stacks can implement a queue by transferring only when the output stack is empty. Each item moves at most once in each direction, so operations are amortized O(1), although one pop may trigger an O(n) transfer.

## Common mistakes and production notes

Store indices whenever age, distance, or expiration matters. Mark the precise comparison rule for equal keys. Do not forget to flush unresolved candidates or handle a final boundary. Explain amortized work across all iterations rather than counting a nested while as n removals per outer iteration. Test strictly increasing, strictly decreasing, all-equal inputs, empty input, and minimum/maximum window sizes. In production, consider whether streaming means the structure must discard expired history; a monotonic deque remains bounded by the current window, while a plain unresolved stack may grow to O(n).

