# Trees and BSTs: Traversals and Recursion Templates

## Core model

Preorder is node-left-right, inorder left-node-right, postorder left-right-node; level order uses a queue. Inorder is sorted for a BST only under a defined duplicate policy. A generic recursion template states the empty-subtree base case, recursively summarizes children, then combines them. Max depth returns zero for None and one plus the larger child depth.

## Recognize and prove the pattern

Carry lower and upper bounds to validate a BST; checking only parent-child edges misses deeper violations. Define strict versus inclusive bounds for duplicates. Lowest common ancestor in a general tree combines child results, but if targets may be absent track presence explicitly. In a BST, comparing target values can discard one entire side.

## Costs and implementation

BFS level order captures queue length before adding children. Kth-smallest uses inorder order and can stop early, with O(h+k) time and O(h) stack in the usual model. Tree recursion uses O(h) stack, which is O(n) for a skewed tree; iterative traversal avoids recursion limits.

## Edge cases

Test empty, singleton, skewed, duplicate-key trees and a target at root. Distinguish node depth from edge height. Assume an acyclic proper tree only if guaranteed. BST operations are O(h), not automatically logarithmic; balance is a separate property.

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
## Worked example: validate a BST with bounds

Consider a root value 8 with a left child 4 whose right child is 10. Every direct parent-child comparison seems plausible locally, but the 10 violates the root’s rule: all nodes in the left subtree must be less than 8. Carry bounds through recursion. Start with no lower or upper bound; for the left child, retain the lower bound and set upper to 8. For the right child, set lower to 8 and retain the upper bound. A node is valid only if it lies strictly between both active bounds. This catches violations several levels below the root in one traversal.

The recursive meaning is: `check(node, lo, hi)` returns whether every value in this subtree lies inside the exclusive interval `(lo, hi)`. Empty subtrees are valid; each nonempty node checks its range and then delegates tightened ranges to its children. Every node is visited once, so time is O(n), and call-stack space is O(h), where h is tree height. A skewed tree has h = n, so recursion can hit Python’s limit.

| Traversal | Visit order | Common use | Auxiliary state |
|---|---|---|---|
| Preorder | Node, left, right | Serialize/copy; root-first decisions | O(h) recursion/stack |
| Inorder | Left, node, right | Sorted keys in a BST | O(h) |
| Postorder | Left, right, node | Aggregate child results | O(h) |
| Level order | By depth using queue | Levels and shortest edge distance | O(width) queue |

## Define recursive state and duplicate policy

Tree recursion works best when a call returns a precise summary: depth, validity, subtree size, or a candidate node. Combine child summaries only after defining their meaning. For example, maximum depth returns zero for an empty tree and one plus the larger child depth. A lowest-common-ancestor routine can combine matches from both children, but if the question’s targets may be missing, a returned candidate alone is insufficient; also track whether each target was found.

In a BST, inorder traversal is sorted only under a stated duplicate convention. Strict BST validation uses exclusive bounds and disallows duplicates. Other systems may place equal values consistently left or right, which requires inclusive bound changes on only one side. Do not improvise a policy midway through the implementation. Operations are O(h); they become O(log n) only when balance keeps height logarithmic.

## Common mistakes and production notes

Capture the queue length at the start of a level so children belong to the next row. Distinguish height measured in nodes from height measured in edges. Do not validate only adjacent parent-child comparisons. Test empty, singleton, skewed, balanced, duplicate-key, and invalid-deep-descendant trees. For untrusted large depth, use explicit stacks or iterative traversal. In production, check whether the input is truly a tree: a graph with cycles can make naïve recursion loop forever, while shared child references may cause repeated work. If node values are not mutually comparable, BST ordering itself needs a compatible comparator.

