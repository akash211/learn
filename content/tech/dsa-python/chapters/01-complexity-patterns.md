# Complexity Analysis and Patterns to Recognise

## Core model

Recognize input size, count dominant operations, and state assumptions. A single pass is O(n); independent passes add, while nested loops are quadratic only when the inner work scales per outer item. If pointers each traverse the collection once, a nested while loop can still be linear. Hash-table operations are expected O(1), not guaranteed worst-case constant. Comparison sorting is O(n log n). Python integers can grow, so arithmetic is not strictly constant time for unbounded magnitudes.

## Recognize and prove the pattern

Patterns compress proofs: hashing provides fast membership; two pointers discard regions proven irrelevant; windows exploit a movable boundary; BFS discovers shortest unweighted paths; dynamic programming memoizes equivalent future states. A pattern is a hypothesis, not a label. Verify its preconditions, say the invariant, and explain why each update preserves it.

## Costs and implementation

Separate auxiliary from output space. A set of n keys is O(n); recursive calls use O(depth). Slicing copies, and repeated prefix slicing in recursion can turn linear logic quadratic. Amortized append is O(1), but one resize can copy the list. State expected versus worst-case costs and include sorting, conversion, and answer materialization when they matter.

## Edge cases

Ask about empty inputs, duplicates, ordering, mutation, and scale. Give a baseline, improve it, trace a boundary case, then code. Check initialization, preservation, and termination of the invariant. Test smallest, repeated, and adversarial inputs. Do not infer complexity from indentation alone.

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
## Worked example: choose a representation before coding

Suppose a list contains n values and the task is to find whether any pair sums to a target. The direct approach examines every pair: the number of comparisons is n(n-1)/2, so time is O(n²) and auxiliary space O(1). A dictionary trades space for expected lookup speed. At index i, the only useful prior value is target - nums[i]; look it up, then record nums[i]. Looking up before insertion prevents pairing an element with itself. The invariant is: `seen` contains exactly the values at indices strictly before i, mapped to one valid prior index. At the end of each iteration the invariant advances by one position.

This example demonstrates a general design decision: determine what information about the processed prefix is sufficient for future decisions. Frequencies, last-seen positions, prefix sums, and unresolved indices are compact summaries. When the summary can be updated in constant expected time, a quadratic scan may become linear. But that improvement is not free: the dictionary consumes O(n) memory and relies on hashable keys and expected-time hashing. If memory is constrained or deterministic worst-case bounds are required, sorting or a different representation may be preferable.

| Work pattern | Typical time | Auxiliary space | What to verify |
|---|---:|---:|---|
| One scan with constant state | O(n) | O(1) | Every item is processed a constant number of times |
| Sort, then scan | O(n log n) | O(n) or implementation-dependent | Whether sorting may mutate the input |
| Nested independent scans | O(n²) | Often O(1) | Whether both loops really range over n items |
| Push/pop each item once | O(n) amortized | O(n) | An item cannot be reinserted indefinitely |
| Branching recursion | Often exponential | O(depth) plus output | Number of states/branches and output size |

## Recognizing a useful pattern

Start with constraints and the shape of the answer. A contiguous range suggests prefix sums or a window; a pair from sorted data suggests opposing pointers; a “next greater” query suggests an unresolved monotonic frontier; a shortest path in an unweighted graph suggests BFS; repeated subproblems suggest memoization or tabulation. These are leads, not proofs. Ask what must be true for the candidate to work. A variable sum window usually needs nonnegative numbers because extending right cannot lower the sum and advancing left cannot raise it. If negatives are allowed, use prefix sums and a map instead.

A practical derivation has four steps: (1) state a simple correct baseline; (2) identify repeated work or an expensive operation; (3) retain only the information needed to avoid that work; (4) prove the retained state is sufficient. For two pointers, explain why a discarded region cannot contain a better answer. For DP, explain why two histories with the same state have identical future choices. For a heap, explain why its root is exactly the next candidate needed—not that the whole heap is sorted.

## Interview and production habits

Speak in terms of input dimensions: an algorithm on a grid is O(RC), not merely O(n), unless n is defined. Separate auxiliary memory from the returned output. Mention recursion depth, hash assumptions, mutation, and whether the output itself may be exponential. In production, benchmark only after deriving a credible bound; constant factors and Python object overhead matter, but they do not rescue a quadratic algorithm at large n.

### Common mistakes

Do not infer quadratic complexity merely from nested syntax: a monotone pointer may advance only n times overall. Conversely, do not call slicing or string concatenation free. Include preprocessing, sorting, conversion, and output materialization. Do not state “constant space” while retaining a set or recursion stack.

