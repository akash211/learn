# Replication, Read/Write Concerns, and Elections

A replica set is a group of `mongod` processes that maintain the same data set. One member is primary and accepts writes; secondaries replicate the primary's oplog and apply operations. A replica set provides redundancy and automatic failover, not a substitute for backups. Replication is asynchronous in the usual configuration, so a secondary can lag and a failover can roll back writes that were acknowledged only by the old primary.

## Replica set shape and oplog

A typical production set has three voting members distributed across independent failure domains. Votes and priorities influence elections, but do not guarantee that a preferred node is always primary. Members exchange heartbeats, compare operation times, and elect a primary when a voting majority can communicate. Arbiters vote but store no data; adding one does not add a durable copy and can complicate failure trade-offs, so use it only for a deliberate topology reason.

The oplog is a capped, rolling log of operations. Secondaries apply it to catch up. If a secondary is offline longer than the oplog window, it may need an initial sync rather than incremental catch-up. Size the oplog to cover expected maintenance and outages at observed write rates, not by copying another cluster's size. Monitor replication lag, oplog window, initial sync progress, disk capacity, and member health.

## Elections and client behavior

When a primary becomes unavailable or steps down, eligible members hold an election. During the transition, writes may fail temporarily; drivers discover the new primary through replica set monitoring and retry supported operations. An election is not instantaneous and applications must tolerate transient errors. Use a replica set connection string with all seed hosts and the correct replica set name, and use a current official driver. Do not pin application writes to one host or manually reconnect only after a fixed delay.

A write acknowledged with `w: 1` can be rolled back if the primary fails before the write reaches a majority. `w: "majority"` waits for majority acknowledgment and reduces that rollback window, at the cost of latency and possible unavailability when a majority is not reachable. The durability relationship with journal acknowledgment depends on server version and configuration; do not assume an independent journal setting has identical behavior across releases.

## Read preference and read concern

Read preference chooses eligible members: `primary` is the default and reads from the primary; `primaryPreferred`, `secondary`, `secondaryPreferred`, and `nearest` permit alternatives. Secondary reads can offload read traffic, but they may be stale. A read from a secondary is not automatically a consistent view of a preceding write from the primary. Use causal sessions and appropriate concerns if an application needs read-your-writes across members, and understand that strict consistency may require reading from the primary.

Read concern specifies what data is visible, independently of which eligible node is selected. `majority` reads majority-committed data; `local` can expose data not yet majority committed; `linearizable` provides a stronger real-time guarantee for certain primary reads. `maxStalenessSeconds` can bound estimated staleness for eligible secondary reads, but it is not a global consistency guarantee. Read preference, read concern, write concern, and session causality work together; selecting a secondary alone does not define consistency.

## Write concern and availability

Write concern controls when the server acknowledges a write. A numeric `w` counts acknowledgments; `w: "majority"` waits for the majority of voting data-bearing members (with topology nuances around arbiters). A write concern timeout is not a cancellation guarantee: the write may later be committed, so the client must treat the result as uncertain and reconcile by stable operation identity. Majority acknowledgment can become unavailable if a voting majority is down; that is an explicit consistency/availability trade-off.

## Common mistakes

- Using a secondary read for an immediate read-after-write path without causality or primary routing.
- Treating replication lag as proof of data loss, or ignoring it because writes still succeed.
- Assuming `w: 1` prevents rollback after primary loss.
- Using an arbiter as though it were another recoverable data copy.
- Treating an election as a zero-downtime event and failing to retry transient errors safely.

## Production notes

Replica-set health is a quorum and data-copy problem: monitor voting majority, replication lag, oplog window, disk, and election events. Test planned stepdowns and member outages with application traffic. Configure drivers with suitable timeouts and retryable writes, and distinguish an operation failure from an unknown outcome. Keep independent backups and test restores; replication faithfully copies accidental deletes and corruption as well as intended writes.
## Follow the write through replication

A write accepted by the primary is recorded in the replica set's operation history and replicated to eligible members. Secondaries fetch and apply operations asynchronously, so “the primary returned success” and “a majority has committed this write” are distinct milestones. With `w: 1`, the caller can get an acknowledgment before a majority has the operation; if the primary is lost before replication catches up, the new primary's history may exclude it and the write can be rolled back. With `w: "majority"`, acknowledgment waits for the configured majority condition, narrowing that risk. Majority is not a promise against every software, operator, or storage failure, so backups and restore tests remain essential.

An application can inspect status from `mongosh`:

```javascript
rs.status()
rs.printReplicationInfo()
rs.printSecondaryReplicationInfo()
```

These commands help reveal member state, optime progress, and the oplog window; output formats and helper availability can vary with version. Compare member optimes and lag over time rather than treating one snapshot as diagnosis. If a secondary falls behind but its needed operations remain in the oplog, it can catch up; if history has rolled off, it may need initial sync, which can place significant load on the source and network.

## Elections and failure domains

An election requires a voting majority to make progress. A three-voter topology spread across independent zones can survive one member failure while retaining quorum, but two members lost together leave no majority. An arbiter supplies a vote, not a data-bearing copy, so it does not increase the number of recoverable copies. Priorities influence election preference but cannot override reachability or eligibility rules. Avoid placing all voters in one rack or cloud zone and then describing the set as fault tolerant.

Drivers use replica-set monitoring to find the current primary and apply retry rules to supported operations. During election, writes can pause or fail transiently; clients need bounded timeouts, retryable operations, and idempotent business requests. An application timeout does not prove that the server did not commit. Record a stable request ID and reconcile by that ID after failover. Test stepdown and member loss with real driver settings, because server availability is only one part of end-to-end recovery.

Use backups independent from the replica set and practice restoration to a separate environment. A replica set promptly reproduces accidental deletes, corrupt application writes, and compromised credentials. Operational readiness includes election behavior, restore procedures, and the time required to rebuild a member—not only green health checks.
