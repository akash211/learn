# Recursion, Backtracking and Dynamic Programming

## Core model

Every recursive call needs a decreasing measure and a base case. Python does not optimize tail recursion; depth n consumes O(n) frames and may exceed the recursion limit. Backtracking chooses, recurses, then undoes. The path must represent exactly the current decisions, and append a copy to results so later mutation cannot change stored answers.

## Recognize and prove the pattern

Memoization computes each state once; total work is states times transition cost. Cache keys must include every value that affects future choices. Bottom-up DP evaluates states in dependency order. Define a state in plain language, write the transition and base cases, then justify why it captures all relevant history.

## Costs and implementation

Loop order changes semantics: descending capacity for 0/1 knapsack prevents reusing an item; ascending order can model unbounded reuse. For LCS, prefix lengths give a two-dimensional recurrence; longest common substring instead resets mismatch state. Space compression is safe only after proving which old row and diagonal values remain needed.

## Edge cases

Combinatorial output may be exponential, so state output-sensitive bounds. Prune only when no completion can work. Test empty, unreachable, duplicate choices and smallest state. Specify whether counting ordered sequences or unordered combinations; similar transitions can answer different questions.

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
## Worked example: coin change as shortest progress through states

For coins `[1, 3, 4]` and amount 6, define `dp[a]` as the fewest coins needed to form amount a, or infinity if impossible. Set `dp[0] = 0`; for each positive amount a, consider each coin c ≤ a and take `1 + dp[a-c]`. The result is `dp[6] = 2` (3+3), rather than the greedy 4+1+1. Each transition removes one chosen coin and reaches a smaller amount, so ascending amounts are already solved when needed. If no transition reaches the target, return -1.

There are amount+1 states and each examines C coin choices, so time is O(amount·C); the table uses O(amount) space. The recurrence is correct because every valid nonempty solution has some final coin c; removing it leaves a smaller subproblem represented by `dp[a-c]`. This “consider the last choice” proof is reusable for many minimization DPs.

| Problem shape | State design | Transition clue | Complexity driver |
|---|---|---|---|
| Fibonacci-like repeats | `dp[i]` for prefix/index | Combine a few prior states | Number of states |
| Knapsack | item index and remaining capacity | Include or exclude current item | States × choices |
| String alignment | `dp[i][j]` for prefixes | Match or edit last symbols | Product of lengths |
| Subset generation | index plus decision path | Include/exclude branch | Output can be 2ⁿ |

## Backtracking, memoization, and tabulation

Backtracking explores choices, mutates a path, recursively explores, then undoes the mutation. The recursion invariant is that `path` holds exactly the decisions from the root to the current call. Save `path.copy()` when recording a result; storing the same list object makes every output alias later changes. Prune a branch only when the remaining choices provably cannot produce a valid answer. If all combinations are returned, runtime must include output size, which may be exponential.

Memoization is valuable when different paths reach the same state. A cache key must contain every fact that changes future choices; leaving out a constraint can merge distinct subproblems incorrectly. Top-down recursion follows only reached states but has call-stack cost. Bottom-up tabulation controls evaluation order and avoids recursion depth. Before compressing a DP table, prove which old values are needed. For 0/1 knapsack, iterating capacity downward prevents reusing the same item; upward iteration can intentionally model unlimited reuse.

## Common mistakes and production notes

Write a recurrence in words before code: state meaning, base cases, transition, and evaluation order. Test amount zero, impossible cases, duplicate candidates, empty strings/inputs, and minimum dimensions. Distinguish ordered sequences from unordered combinations; loop ordering changes which objects are counted. Avoid copying large slices at every recursive step, which may add quadratic allocation. Python does not optimize tail recursion. For large state spaces, estimate memory before allocating a multidimensional table; sparse memoization or a one-dimensional formulation may be required. In production, protect against malformed or extreme inputs and document whether the input collection is changed.

