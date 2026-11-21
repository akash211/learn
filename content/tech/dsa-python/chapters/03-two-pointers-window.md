# Two Pointers and Sliding Window

## Core model

Sorted pair search moves the endpoint that cannot possibly improve the sum: if too small advance left, if too large retreat right. The ordering proves discarded pairs irrelevant. In-place compaction uses a read pointer and a write pointer; the prefix before write is the processed result. These arguments, not the pointer syntax, justify linear time.

## Recognize and prove the pattern

A window represents a contiguous interval. Update the entering value, restore validity by advancing left, then record the answer. For longest unique substring, latest indices allow a direct jump, guarded by max so left never retreats. Each pointer advances at most n times. Fixed-width windows instead remove the leaving value at each step.

## Costs and implementation

Variable windows need a monotone condition. Shrinking a sum until it fits works for nonnegative values, but negatives break the reasoning; use prefix sums. Minimum-window substring expands until requirements hold, then shrinks while valid. Exactly-k counts can be atMost(k)-atMost(k-1) when the helper counts all relevant subarrays.

## Edge cases

Choose inclusive or half-open ranges consistently. Record answers only for valid windows. Distinct values do not mean distinct positions: pair solutions may use equal values if there are two indices. Test repeated values, width one, and inputs with no valid window. Map state may use O(alphabet) or O(n) space.

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
## Worked example: longest unique substring

Consider `s = "abca"`. Keep a left boundary for the active substring and a map from each character to its most recent index. When the second `a` arrives at index 3, the prior `a` lies inside the active range, so move left to 2; the active substring becomes `"bca"`. The update is `left = max(left, last[ch] + 1)`. The maximum is essential: if a repeated character was already outside the current range, its old index must not move left backwards. After adjusting left, record the new index and evaluate `right - left + 1`.

The invariant is that the current window contains no repeated character. Each right index is processed once, and left only moves forward, so total pointer movement is O(n), not O(n²). The map uses O(min(n, alphabet size)) space. This direct last-seen method is preferable to repeatedly deleting characters from a string slice, which creates copies and can add substantial cost.

| Pattern | When it fits | Boundary rule | Typical complexity |
|---|---|---|---|
| Opposing pointers | Sorted pair/triplet constraints | Move the endpoint proven unable to work | O(n) after sorting |
| Fixed window | Every range has width k | Remove outgoing item before scoring next window | O(n) |
| Variable window | Validity is monotone as boundary moves | Expand, shrink until valid, then score | O(n) if both ends move once |
| Prefix-sum map | Exact sums with negative values | Count earlier prefix values | O(n) expected |

## Conditions matter: why positive-only windows fail

For nonnegative values, a sum window has a useful monotonicity: moving right cannot reduce the sum, and removing from the left cannot increase it. Therefore one can shrink while the sum is too large. With negative values, neither claim is true. For `[4, -3, 2]`, the current sum may go down when a value enters, so a local shrink/expand decision can skip a valid range. Prefix sums do not require monotone values; use a prefix-frequency map for exact-sum counts, or a specialized monotonic deque for shortest-range variants.

For “at most k distinct” counts, after shrinking until the window has at most k distinct keys, every suffix ending at right and beginning between left and right is valid. That yields `right-left+1` new subarrays. Exactly k can be computed as atMost(k) minus atMost(k-1), since the set with at most k includes exactly-k and fewer-than-k. This subtraction is a counting identity, not a generic property of every window problem.

## Interview, mistakes, and production notes

State whether intervals are inclusive or half-open; half-open windows `[left, right)` have length `right-left` and often simplify endpoint handling. Record an answer only after restoring the validity invariant. For pairs, values may repeat while indices remain distinct. For maximum windows, use a deque of indices, not values alone, because indices tell when candidates expire. Test width 1, width n, repeated values, an answer at either boundary, no valid window, and empty input. For strings, define whether comparisons are case-sensitive and whether Unicode normalization matters.

A sliding window is compelling when each item enters and leaves a small maintained state a bounded number of times. If shrinking can invalidate a previous answer or the condition is not monotone, do not force the pattern. Explain exactly what each move proves and which candidate ranges it eliminates.

