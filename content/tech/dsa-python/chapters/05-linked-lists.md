# Linked Lists

## Core model

A singly linked list has no random access: reaching a position costs O(n). Insertion after a known node is O(1), but locating it is not. Before redirecting a pointer, save the successor or the remaining chain is lost. Reversing iteratively maintains prev as the reversed prefix and current as the untouched suffix; save next, reverse one link, advance.

## Recognize and prove the pattern

Fast/slow pointers find a midpoint or detect cycles. For cycle entry, after a meeting reset one pointer to head and advance both one step. A dummy sentinel simplifies head removal and sorted merges by avoiding a special first-node case. Merging two lists takes O(m+n) time; relinking nodes uses O(1) auxiliary space if mutation is allowed.

## Costs and implementation

Remove nth from end with a fixed gap between pointers so the slow pointer reaches the predecessor. For palindrome checking, reverse the second half and compare; restore it if callers require the original list. For intersection, switch each pointer to the other head after reaching None; compare node identity, not values.

## Edge cases

Test empty, singleton, even/odd lengths, head deletion, duplicate values, cycles, and shared tails. Recursive reversal consumes O(n) stack and may hit Python recursion limits. Define behavior for invalid n, and clarify whether input mutation is allowed.

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
## Worked example: reverse without losing nodes

Given `1 → 2 → 3 → None`, initialize `prev = None` and `current = head`. Before changing a link, save `nxt = current.next`; then set `current.next = prev`. Advance `prev` to current and current to nxt. The states after each iteration are: reversed prefix `1`, then `2 → 1`, then `3 → 2 → 1`; the untouched suffix begins at current. The loop ends when no suffix remains, and `prev` is the new head. Saving the successor first is essential: overwriting `current.next` without it disconnects the rest of the list.

The invariant is that `prev` heads exactly the reversed prefix and `current` heads the original unprocessed suffix. Each node is visited once, so time is O(n), while only three references are held, giving O(1) auxiliary space. This is an example of a pointer invariant that makes mutation safe: every iteration transfers one node from the untouched chain to the reversed chain.

| Operation | Time | Extra space | Caveat |
|---|---:|---:|---|
| Index access to position i | O(i) | O(1) | No random access |
| Insert after a known node | O(1) | O(1) | Finding that node may cost O(n) |
| Reverse list | O(n) | O(1) iterative | Mutates links |
| Merge sorted lists | O(m+n) | O(1) relinking | Inputs become one list |
| Detect cycle | O(n) | O(1) | Compare node identity |

## Fast/slow pointers and sentinels

Fast and slow pointers move at different speeds. If a cycle exists, their relative distance changes by one around the cycle each iteration, so they eventually meet. If the fast pointer reaches `None`, the list is acyclic. To find a cycle entrance after a meeting, reset one pointer to the head; advancing both one step makes them meet at the entrance. For midpoint tasks, decide whether the slow pointer should land on the left or right middle for even lengths, because that affects palindrome and split logic.

A dummy sentinel is a temporary predecessor before the head. It removes special cases for deleting the first node, merging, and removing the nth node from the end. In the last problem, advance a lead pointer n nodes ahead; then move lead and lag together until lead reaches the tail. Lag is immediately before the deletion target. This is one pass, O(n) time and O(1) auxiliary space, assuming 1 ≤ n ≤ length.

## Common mistakes and production notes

Use `is` for node identity in cycle and intersection checks; equal values do not imply shared nodes. Clarify whether routines may mutate lists. A palindrome check that reverses a half changes the structure unless it restores the links, including on early mismatch. Avoid recursive reversal for unbounded lists: Python has a recursion limit and uses O(n) frames. Test empty and singleton lists, head/tail deletion, even and odd lengths, duplicate values, cycles, and intersecting shared tails. In APIs that expose nodes to callers, temporary mutation may violate invariants visible to other code; restoration or a non-mutating O(n)-space approach can be safer.

