# Graphs: BFS, DFS, Topological Sort and Union-Find

## Core model

An adjacency list stores O(V+E), ideal for sparse graphs. BFS marks vertices when enqueued and visits distance layers; first discovery gives shortest path in an unweighted graph. Its cost is O(V+E). Weighted edges need a weighted shortest-path algorithm. Multi-source BFS begins by enqueuing every source at distance zero.

## Recognize and prove the pattern

DFS supports reachability and components, but deep recursion may exceed Python’s limit; use an explicit stack when depth is unbounded. Directed-cycle detection needs active versus finished states; an edge to an active node is a back edge. Kahn topological sorting removes zero-indegree vertices; fewer than V outputs proves a cycle.

## Costs and implementation

Union-find with path compression and union by size supports incremental undirected connectivity in amortized O(alpha(V)) per operation. It detects whether an added edge joins already-connected vertices. It does not answer directed reachability or reconstruct arbitrary paths. For nonnegative weighted shortest paths, use Dijkstra with a heap.

## Edge cases

Test disconnected components, isolated vertices, self-loops, duplicate edges and cycles. Clarify directedness and label representation. Mark visited on enqueue to avoid duplicates. State O(V+E) traversal and O(V) auxiliary state; use a map if labels are not contiguous integers.

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
## Worked example: BFS shortest path in an unweighted graph

Suppose the adjacency list is `A: [B, C]`, `B: [D]`, `C: [D]`. Starting from A, enqueue it at distance zero and mark it visited immediately. Process A, then B and C in the next layer, then D. The first time D is discovered, its distance is two edges. Because FIFO order processes complete layers, no longer path can reach D first. Marking neighbors when enqueued prevents B and C from adding D twice and bounds queue entries by O(V).

BFS over an adjacency list runs in O(V+E) and uses O(V) distance/visited/queue space. The bound assumes each adjacency list is scanned once. If only one component is reachable, it may visit fewer vertices; to count all components, start a traversal at every still-unvisited vertex. BFS gives shortest paths by edge count, not shortest weighted distance. Even a small positive weight breaks that guarantee; use Dijkstra for nonnegative weights or another algorithm suited to the edge model.

| Need | Pattern | State / proof idea | Typical bound |
|---|---|---|---|
| Reachability/components | DFS or BFS | Mark once, traverse each edge | O(V+E) |
| Shortest unweighted path | BFS | First discovery is minimum layer | O(V+E) |
| Directed acyclic ordering | Kahn / DFS states | Remove zero indegree / detect active edge | O(V+E) |
| Incremental undirected connectivity | Union-find | Merge components, compare representatives | Amortized near-constant |
| Nonnegative weighted shortest path | Dijkstra | Heap extracts smallest current distance | O((V+E) log V) typical |

## Choose graph representation and cycle logic

An adjacency list costs O(V+E), making it appropriate for sparse graphs. An adjacency matrix costs O(V²) but makes checking a particular edge O(1); it may be reasonable for dense graphs. Convert arbitrary labels to integer indices or use dictionaries keyed by labels. Clarify directedness: an undirected edge generally needs two adjacency entries. Decide how duplicate edges and self-loops are treated before counting indegrees.

For directed DFS cycle detection, a single visited bit is insufficient. Use three states: unseen, active on the current search path, and finished. An edge to an active node proves a cycle; an edge to a finished node does not. Kahn’s algorithm repeatedly emits zero-indegree vertices; if fewer than V are emitted, a directed cycle remains. Union-find is useful for undirected connectivity as edges arrive, but cannot answer directed reachability or reconstruct general routes.

## Common mistakes and production notes

Use `deque.popleft()` for BFS, not `list.pop(0)`. Mark nodes on enqueue, not on dequeue. State whether isolated vertices are included and whether you need one component or all. Test disconnected graphs, self-loops, duplicate edges, empty graphs, multiple valid topological orders, and cycles. Avoid recursive DFS for unbounded depth in Python; an explicit stack or iterative color-state traversal avoids recursion-limit failures. In production, validate external IDs and edge direction, and consider whether graph updates can occur during traversal. For a grid, the same analysis applies with R rows and C columns: O(RC) visited cells and up to four neighbor checks each.

