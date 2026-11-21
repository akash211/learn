# Sorting, Binary Search and Bit Tricks

## Core model

Python sorting is stable, O(n log n) worst case, and can exploit existing runs. `sorted` copies while `list.sort` mutates. Binary search is best understood as locating a monotone predicate boundary. Maintain half-open [lo,hi), where values before lo are false and values at/after hi true; each step discards half. bisect_left/right implement insertion boundaries on sorted sequences.

## Recognize and prove the pattern

Rotated sorted search uses the fact that at least one half is ordered; duplicates can make the half ambiguous and degrade worst-case time to O(n). Binary search on answer requires a monotone feasibility predicate. Interval merge sorts by start then scans in O(n log n); output can use O(n) memory.

## Costs and implementation

XOR is associative and a^a=0, isolating a lone unmatched value when all others occur exactly twice. `x & (x-1)` clears the lowest set bit. Python integers are arbitrary precision, so bit work depends on integer width; apply fixed-width masks only when the contract specifies a width.

## Edge cases

Avoid stalled loops by ensuring every branch changes bounds. Test empty, singleton, duplicate, absent, and out-of-range targets. Searching is O(log n), but inserting into a Python list shifts elements in O(n). Clarify sorting mutation and tie-breaks.

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
## Worked example: binary search as a boundary proof

Suppose `nums = [2, 4, 4, 4, 9]` and we need the first position whose value is at least 4. Use a half-open interval `[lo, hi)` initially `[0, 5)`. Maintain the invariant that positions before lo are known to be below 4, while positions at or after hi are outside the remaining candidate range. At midpoint 2, value 4 satisfies the predicate, so move hi to 2; midpoint 1 also satisfies, so move hi to 1; midpoint 0 is false, so move lo to 1. The loop stops with lo = hi = 1, the lower-bound insertion position.

The search takes O(log n) comparisons because each iteration halves the interval. The invariant directly returns the boundary, including when the target is absent: searching for 5 returns the position where it could be inserted. `bisect_left` implements this behavior for sorted sequences. To find the last occurrence, use `bisect_right(target) - 1` and verify the candidate is in bounds and equal to the target.

| Technique | Preconditions | Time | Common use |
|---|---|---:|---|
| Comparison sort | Comparable items | O(n log n) worst case | Ordering, grouping, interval scans |
| Binary search | Monotone predicate / sorted input | O(log n) | Boundary or membership |
| Binary search on answer | Feasibility is monotone | O(log range × check cost) | Minimize/maximize a feasible value |
| XOR cancellation | Every other value pairs exactly twice | O(n) | Isolate one unpaired value |
| Bit clear `x & (x-1)` | Integer bit representation | O(number of set bits) loops | Remove lowest set bit |

## Sorting, rotated arrays, and binary-search-on-answer

Use `sorted(items)` when preserving input matters; `items.sort()` mutates. Python sorting is stable, which preserves original relative order among equal keys, and supports a `key` function for explicit ranking. Sorting can simplify deduplication and interval problems, but includes O(n log n) preprocessing. If input is a rotated sorted array with distinct values, at least one half is ordered and can be tested for the target range. With duplicates, equal endpoints may hide which half is ordered, forcing extra checks and worst-case O(n) behavior.

Binary search on an answer is valid only when feasibility is monotone: if a capacity works, all larger capacities must also work (or the reverse). Then search the boundary rather than all candidate values. Prove monotonicity separately from the implementation and ensure each check has a clear cost. Half-open bounds are often easier to reason about than inclusive endpoints, but either convention works if every branch strictly shrinks the search range.

## Common mistakes and production notes

Avoid infinite loops by ensuring midpoint updates exclude the tested position. Test empty and singleton arrays, duplicates, absent targets, and targets outside the value range. Searching is O(log n), but inserting in the middle of a Python list remains O(n) due to shifting. Python integers are arbitrary precision; bit tricks are not necessarily constant time for arbitrarily wide values. Use masks only when fixed width is part of the contract. Confirm whether bit operations should use signed or unsigned interpretation, and avoid translating fixed-width assumptions from another language without making them explicit.

