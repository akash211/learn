# Multi-region Distribution and Conflict Resolution

Cosmos DB can replicate data to multiple Azure regions, allowing clients to connect near users and helping an application survive regional outages. Replication topology is an availability and latency design, not merely a geographic checkbox. Specify which regions serve reads and writes, how clients discover endpoints and fail over, what consistency they require, and how simultaneous updates are reconciled.

## Read regions and write regions

A single-write-region account accepts writes in one selected region and replicates them to other regions. Additional regions can serve reads, subject to the selected consistency level and replication delay. This model simplifies conflict handling because concurrent writes are serialized through one write region, but a distant writer may pay network latency and a regional outage can require a write-region failover process.

Multi-region writes allow writes to be accepted in multiple regions, which can reduce write latency for geographically distributed clients and improve write availability during some regional failures. Those writes replicate asynchronously between regions and may race when the same item is updated. Multi-region writes cannot be treated as globally linearizable strong consistency. Route a user's requests consistently to a nearby region where practical; random per-request routing increases cross-region dependencies and conflict opportunities. Failover behavior and SDK endpoint discovery should be tested, not inferred from a healthy dashboard.

With multiple regions, replica lag matters whenever an application writes in one region and reads immediately from another. Session tokens can preserve useful guarantees when the same client session is maintained; crossing independent clients requires explicit session-state design. Design workflows so a write is followed by a read in the same region/session when possible, or tolerate and expose a defined delay. Never build correctness around an undocumented assumption that all replicas become visible at once.

## Conflict resolution

Concurrent updates to the same item may conflict in a multi-write account. Cosmos DB provides a policy for resolving them. The default Last Write Wins (LWW) policy chooses based on a system timestamp or, for the native NoSQL API under supported configuration, a custom numeric conflict-resolution path. Timestamps should not be mistaken for business intent: two legitimate changes may race, and the winner may overwrite a field that should have been merged. Deletes have special resolution behavior and should be tested as part of the conflict model.

A custom conflict policy using server-side merge logic is available only for the native NoSQL API and has configuration constraints, including that it is set when the container is created. If a merge procedure fails or cannot resolve the conflict, the application needs to inspect and repair conflict records through the supported mechanism. Other APIs may expose only their documented resolution choices, and custom behavior must not be assumed portable.

The strongest design is often to avoid conflicts: assign each entity a home region, make updates to distinct items, use append-only records with deterministic IDs, or partition data by the writer's domain. If a user can edit the same profile from two continents simultaneously, define a merge rule per field or present a conflict to the user rather than trusting a generic last timestamp. Counters, inventories, and financial state need operations whose algebra and concurrency semantics are explicitly correct, not just a timestamp winner.

## Regional failure and recovery

A region outage can affect writes, reads, replication, and downstream change-feed consumers differently. Define the recovery objective: acceptable data loss, recovery time, read-only mode, and whether clients automatically switch endpoints. Use the SDK's recommended region configuration and diagnostics. Test planned failover and failback in a safe environment, including requests in flight, retries, session continuity, and idempotency. After restoring a region, observe replication health and conflict rates before resuming normal routing.

High availability also depends on the consistency level, region count, and service guarantees for the account configuration. Strong consistency has more demanding coordination properties than relaxed levels, and multi-region write accounts have specific consistency limitations. Review current service documentation and SLA terms for the exact design. Replication is not a backup: deletion or corruption can replicate. Configure backup and point-in-time recovery separately, and rehearse restoration into an isolated target.

## Latency and cost trade-offs

Adding regions can reduce read distance and improve regional resiliency, but increases replication traffic and can increase provisioned capacity requirements or service charges. Multi-write capability adds conflict-resolution work and operational complexity. Measure end-to-end latency from client to chosen region, then account for replica visibility and failover behavior. An architecture with globally distributed infrastructure but all clients pinned to one distant region has not achieved low-latency access.

## Common mistakes

- Treating multi-region writes as strongly consistent or conflict-free.
- Assuming read availability in a region means writes and change feeds have identical failover behavior.
- Relying on last timestamp to encode a domain merge rule.
- Round-robin routing clients across regions and creating avoidable cross-region reads and write conflicts.
- Treating replication as backup or assuming restored data is automatically application-consistent.

## Production notes

Document a region matrix with read/write routing, consistency, failover trigger, and expected recovery. Log request region, contacted region, retry history, activity ID, and conflict outcomes where available. Test user-visible behavior under lag and regional isolation, not just endpoint health. Revalidate cost and feature availability whenever regions or account configuration change.

## Make regional behavior part of the application contract

A failover plan should specify whether the system fails over reads, writes, or both; who declares an outage; how clients learn the new endpoint; and how traffic returns after recovery. Test connection establishment and DNS or endpoint refresh behavior for the exact SDK. Requests already in flight may time out, be retried, or complete ambiguously. Idempotency and reconciliation remain essential during a regional event, even when the database service itself maintains replicas.

Consider data sovereignty and residency as well as latency. Adding a region places replicated data and service operations in that geography, and the selected regions can affect compliance, latency, cost, and feature eligibility. Document which records may be written where. If clients are routed to the nearest region but user identities can roam, session handoff and home-region policy need deliberate treatment. A region-local read does not automatically meet a business rule about the globally latest value.

Measure application-level latency and stale-read behavior in each region. Network distance, connection setup, client configuration, and replica catch-up can dominate different parts of the request. During failover, observe conflict volume and change-feed progress, then reconcile projections after service recovery. Keep backup restoration separate from regional replication: a restore test should demonstrate that an accidental delete or corrupt deployment can be recovered to a clean target, not merely that replicas remain available.

## Review checklist

For each region, test a client that writes and reads locally, a client that reconnects after failover, and two clients that update the same item concurrently. Record acceptable lag, expected conflict outcome, and the operational owner for switching traffic. Verify that observability reports the region actually serving each request. Repeat the exercise after SDK upgrades or topology changes, because a successful test against one endpoint does not establish behavior in every region.

