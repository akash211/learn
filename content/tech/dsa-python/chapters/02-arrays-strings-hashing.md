# Arrays, Strings and Hashing

## Core model

Lists provide O(1) indexing and amortized O(1) append, but front insertion/deletion shifts elements. Strings are immutable: repeated concatenation may copy growing prefixes quadratically; collect pieces and join. Slices allocate copies, so index-based loops avoid hidden work. Dicts and sets offer expected constant-time membership and counting, with key hashing cost and collision caveats.

## Recognize and prove the pattern

For pair sum, look up target minus current value before recording the current index; this prevents reusing one element. Frequency maps solve anagrams and duplicate counts. Prefix sums answer range sums by subtraction; for subarray sum k, count previous prefixes equal to current-k, seeded with zero. Negative values invalidate many positive-only window arguments.

## Costs and implementation

Sorting groups related values but costs O(n log n); preserve original indices if required. A sorted-character tuple is a general anagram key, while a fixed count vector is linear only under an explicit alphabet assumption. Python string indices are code points, not grapheme clusters; normalization and case folding belong to the problem contract.

## Edge cases

Test empty and singleton inputs, duplicates, negatives, zero, and missing answers. Avoid list.index inside loops. Clarify whether sorting mutates caller data. Use max(left, last[ch]+1) when moving a window past a repeated character so its boundary never moves backward.

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
## Worked example: count subarrays with a target sum

For `nums = [1, 2, 1, 2]` and target 3, the matching ranges are the first two items, the middle pair, and the last two items. Define a prefix sum P[j] as the sum of items before index j. A range from i through j-1 sums to target exactly when P[i] = P[j] - target. Scan once, maintaining the current prefix and a frequency map of earlier prefixes. Seed the map with `{0: 1}` so a range beginning at index zero is counted. At each step, add the frequency of `prefix - target` to the answer, then record the current prefix. This ordering ensures the current prefix is not paired with itself for an empty range.

The invariant is that the map counts every prefix boundary strictly before the current endpoint. Negative values cause no difficulty because the equation is algebraic; this is why prefix frequencies are safer than shrinking a sum window when signs are unrestricted. Time is O(n) expected and space O(n) in the worst case. If only a single range sum is needed after preprocessing, a prefix array makes each query O(1), but costs O(n) storage.

| Task clue | Useful state | Typical bound | Important assumption |
|---|---|---|---|
| Complement or duplicate lookup | Value → prior index / count | O(n) expected | Keys are hashable |
| Anagram grouping | Canonical key → words | O(total characters) to O(nm log m) | Character model and normalization |
| Range sum | Prefix sums | O(1) per query after O(n) build | Endpoints are consistent |
| Pair in sorted list | Two indices | O(n) after sorting | Input order is known or sorting allowed |

## Strings: correctness includes the text model

Python strings are immutable sequences of Unicode code points. “Character” in a prompt might mean bytes, code points, grapheme clusters, or case-folded symbols; normalization can make visually identical strings compare differently. State what the problem assumes. For anagrams, `Counter` is concise and handles arbitrary symbols. A fixed 26-slot vector is faster only when the input is guaranteed to contain lowercase English letters; map each symbol to an index only after validating that contract. For grouping, a sorted tuple is a clear canonical signature, while a frequency tuple can reduce per-word work under a restricted alphabet.

When building a result from many pieces, append to a list and `''.join(parts)` once. Repeatedly concatenating immutable prefixes can copy the accumulated text each time. Slicing also allocates, so a two-pointer scan should generally hold indices until it knows which result to materialize.

## Common mistakes and production notes

In pair sum, check the complement before storing the current index; otherwise a target of twice the current value may reuse one element. For prefix sums, forgetting the initial zero loses ranges starting at the first item. Do not use `list.index` in a loop, as the repeated scan recreates quadratic work. Be explicit about whether sorting changes the caller’s list. Test empty input, one item, repeated values, negative values, and zero targets. When counting, distinguish a frequency of values from a count of index pairs: duplicate values at different positions represent different candidates.

For large text ingestion, avoid building unnecessary normalized copies. If normalization is part of correctness, perform it consistently on both inputs, and understand the memory cost. Dict/set lookups are expected O(1), but hashing a long string itself costs time proportional to its length on first hash calculation. Benchmark realistic character distributions rather than assuming a constant cost for all key sizes.

