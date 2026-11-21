# Consistency Levels and Trade-offs

Consistency describes which committed versions a read may return as replicas converge. In a distributed database, replication can improve availability and local access but introduces questions about how fresh, ordered, and mutually consistent reads must be. Cosmos DB's native NoSQL API offers five named levels: strong, bounded staleness, session, consistent prefix, and eventual. These form a spectrum of guarantees, latency, availability, and throughput—not a simple toggle from "correct" to "fast." Define application invariants first, then select a guarantee for each read path.

## The five levels

| Level | Practical guarantee | Common fit and cost to consider |
| --- | --- | --- |
| Strong | Linearizable reads return the latest committed write, with a total order consistent with real-time operations. | Strict latest-value requirements; cross-region coordination can increase latency and constrain availability. |
| Bounded staleness | Reads lag by no more than a configured time or version window, within supported configuration limits. | Applications that can tolerate a known bounded delay while preserving ordered reads. |
| Session | Read-your-writes and write-follows-reads within a client session, when session state is preserved. | Typical interactive applications; session tokens matter when work moves between clients or regions. |
| Consistent prefix | Reads do not observe writes out of order, but can lag and may not see a recent write immediately. | Ordered updates where monotonic sequence matters more than immediate visibility. |
| Eventual | Replicas converge if writes stop, but reads can be stale and may not preserve ordering. | Counters, likes, and other state that tolerates temporary inconsistency. |

Strong consistency is the clearest way to request the newest committed value, but it requires coordination and has availability and latency implications, especially across distant regions. It is not automatically the right choice for every item. Bounded staleness allows an explicit lag bound, often expressed in time or versions, but the exact supported bounds depend on configuration and API. Validate the account's regions and service limits before designing around a particular bound.

Session consistency is a common default for the NoSQL API because it gives a client a useful read-your-writes experience without requiring global linearizability. The SDK handles session tokens in normal client flows. When an application switches SDK instances, worker processes, or user devices, it may need to propagate session state if those separate clients must see each other's writes immediately. Without shared token context, the service still honors the configured guarantee but the application cannot assume all independent clients form one session.

Consistent prefix preserves the order in which writes were made, while allowing a reader to see an older prefix. Eventual has the weakest ordering expectation: a client can observe changes in different orders or see an older value, with convergence when updates cease. These levels should not be interpreted as relaxing item-level atomicity or accepting partially written JSON; rather, they describe visibility across replicas and reads.

## Scope and deployment interaction

A consistency level governs reads; writes are committed according to the service's replication protocol and account configuration. A read's guarantee applies within the operation's scope, which in NoSQL is especially important when work crosses logical partition boundaries. A query spanning multiple partitions should not be casually treated as one globally atomic snapshot. Transactions and stored procedures have their own single-logical-partition scope.

The account's default consistency applies to clients unless a supported SDK-level override is used. Overrides cannot make the account's underlying write configuration behave as though it had a different global replication architecture. After changing defaults, restart or recreate client instances as required by the SDK so they pick up new settings. Some APIs map or expose consistency semantics differently; the five-level model should be taught as Cosmos NoSQL semantics, not assumed identical for every compatibility API.

Region topology matters. With weaker-than-strong consistency, writes can be acknowledged locally while replication to other regions proceeds asynchronously. A client that writes in one region and immediately reads in another may depend on replication lag. Strong consistency can add inter-region coordination and may have restrictions on supported region combinations or counts. Current limits and SLA implications are configuration-specific; review them before promising a geographic latency or availability target.

## Make the guarantee explicit in code

For every important workflow, answer: can this read return stale data; can it read a value older than one it already saw; must an update appear before another update; and must a second device see the first device's write immediately? Examples: a product description may tolerate eventual propagation; a shopping cart may need session read-your-writes; a workflow state transition may require a conditional write and conflict handling in addition to a consistency level. A consistency level does not replace optimistic concurrency with ETags, idempotency keys, or business validation.

Tests should include multiple SDK clients and regions where relevant. A single client repeatedly reading its own writes will make session guarantees look like strong consistency. Simulate a client handoff, a regional failover, and delayed replication. Log chosen consistency, session-token handling where relevant, region preference, and operation latency so incidents can be connected to actual guarantees.

## Common mistakes

- Treating "session" as a user-wide session automatically shared by every device or backend process.
- Assuming a lower consistency level changes the atomicity boundary or guarantees for multi-partition queries.
- Believing strong consistency is a free correctness setting with no regional latency or availability trade-off.
- Applying the NoSQL API's five levels to all Cosmos compatibility APIs without checking their mappings.
- Using consistency to solve lost updates when an ETag condition or transaction is what the invariant needs.

## Production notes

Choose the weakest guarantee that still satisfies a stated invariant, but document the invariant and validate behavior with the real SDK. Measure read latency and RU consumption at the selected level; strong and bounded staleness reads can use more resources than weaker levels. Include regional topology, failover, client session propagation, and API-specific behavior in design reviews.

## Consistency is not concurrency control

A consistency level answers what version a read may observe across replicas. It does not define how two concurrent writers should update the same item, how duplicate requests are recognized, or whether a business operation is valid. For lost-update protection, read the item's ETag and issue a conditional replace or patch. If the condition fails, fetch the latest version and apply a domain-specific merge. For commands such as “reserve only if stock is positive,” use a conditional write or a transaction within the designed partition boundary.

Consistency requirements are often mixed within one product. A user profile page might tolerate eventual propagation of a noncritical preference, while checkout confirmation requires a reliable read-your-writes path. Document the guarantee at the operation boundary, including what happens when a client moves between devices or regions. Avoid choosing strong consistency globally simply because one workflow needs fresh data; stronger levels affect more reads and may constrain the regional design. Conversely, do not weaken a level based on a benchmark if the application is relying on session behavior implicitly.

Validate the consistency setting after deployment. Account defaults, client-level overrides, session tokens, region preferences, and SDK instance lifetime all affect observed behavior. Tests should use independent clients, inject delays, and verify allowed outcomes rather than expecting one deterministic interleaving. Keep the expected stale-read window explicit for bounded staleness and eventual designs. This gives product and operations teams a concrete contract for user-facing refresh behavior and incident diagnosis.
