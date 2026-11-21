# Change Streams and Operational Tooling

Change streams expose database changes as a resumable stream backed by the replication oplog. They let an application react to inserts, updates, replaces, deletes, and selected database or deployment events without polling every collection. A change stream is useful for cache invalidation, event-driven integration, search indexing, and CDC-like workflows, but it is not a durable business event log with unlimited retention.

## Watching changes

A collection, database, or deployment can be watched with a change stream using an official driver. The shell interface gives a concise example:

```javascript
const stream = db.orders.watch([
  { $match: { "fullDocument.status": "paid" } }
], { fullDocument: "updateLookup" })
```

A change event contains a resume token (`_id`), operation type, namespace, document key, and operation-specific fields. For updates, the default event reports changed fields and removed fields, not necessarily the full resulting document. `fullDocument: "updateLookup"` performs a lookup for the current version, which can be newer than the exact state at update time if further writes occur. Use pre/post images when supported and enabled if the exact before-and-after documents are required, and understand their storage and retention costs.

Persist resume tokens only after the downstream effect is durable. If the process crashes after applying an effect but before saving the token, the event may be replayed; if it saves the token first, it may lose the effect. This is the standard at-least-once processing problem. Make consumers idempotent using the resume token or a business event key, and atomically commit the consumer effect with checkpoint where possible. Change streams can resume only while the required oplog history remains available; expired history requires a resynchronization strategy.

Change streams require a replica set or sharded cluster and sufficient privileges. On sharded clusters, `mongos` merges streams and tracks shard progress. Filtering stages should be pushed into the change stream pipeline where supported to reduce work, but every consumer should still tolerate event ordering, duplicates, and resume failures according to documented semantics.

## Operational shell and commands

`mongosh` is the interactive shell; use it for controlled inspection, scripts, and administration, not as a substitute for deployment automation. Common checks include `db.serverStatus()` for server counters, `rs.status()` and `rs.printReplicationInfo()` for replica-set state, `db.currentOp()` for active operations, and `db.collection.getIndexes()` for index inventory. Their output can be large and privileges vary. Avoid dumping sensitive documents into shell history, tickets, or logs.

Backups are a separate operational system. `mongodump`/`mongorestore` can be appropriate for logical export/import, while filesystem or managed snapshots may better suit larger deployments when coordinated with MongoDB's backup guidance. A backup is proven only by a successful restore test. Point-in-time recovery depends on a compatible base backup and retained oplog/WAL-equivalent history; replication alone is not a backup because it replicates destructive changes.

Upgrade planning should include supported version paths, feature compatibility version (FCV), driver compatibility, backup validation, and a rollback plan. Do not leap directly across unsupported major versions. Review release notes for behavior changes, index build impact, deprecated features, and operational tooling before upgrade.

## Monitoring and incident response

Track availability, primary elections, replication lag, oplog window, operation latency, connection usage, cache eviction, disk free space, index builds, chunk migrations, and change-stream consumer lag. Alert on symptoms tied to user impact and clear thresholds, not every counter fluctuation. During an incident, gather state and preserve logs before changing settings; blind restarts can erase evidence and amplify failover.

## Common mistakes

- Treating change streams as exactly-once delivery or as a replacement for durable domain events.
- Advancing a resume token before downstream effects are committed.
- Assuming update events include the full post-update document by default.
- Depending on oplog history that is shorter than an expected consumer outage.
- Calling a dump or snapshot a backup without doing a restore drill.

## Production notes

Design consumers for replay, duplicates, schema evolution, and resync. Monitor lag relative to oplog retention and alert before a resume token becomes unusable. Use explicit operational identities and least privilege for watchers, backup tools, and administrative commands. Change stream features, pre/post image support, and tooling vary across MongoDB 6.0, 7.0, and 8.0; verify the exact target release and topology. Document who owns each stream, the expected event rate, checkpoint storage, and the recovery-time objective. Include schema-version handling so consumers can safely process events emitted during rolling application upgrades.
## Checkpointing without gaps

A consumer must coordinate its durable output and its resume position. If the output is a search projection keyed by source `_id`, applying an event can be idempotent when the consumer stores a source version or event identity and rejects older updates. Persist the change-stream token only after the projection write is durable. If the destination and checkpoint live in one transactional database, commit them together; across separate systems, use idempotent effects and accept replay. Saving a token before the effect risks a permanent gap, while saving after the effect can cause a duplicate after a crash.

For a full rebuild after oplog history expires, do not simply start a new stream at “now” and scan documents independently: a write occurring between scan and stream start can be missed. Establish a consistent snapshot or a coordinated change-capture boundary, scan to rebuild the projection, then replay changes from that boundary and advance to live processing. The exact mechanism depends on the source topology and tooling; test the handoff for inserts, updates, deletes, and documents changed during the scan. Reconciliation against source records can identify drift that the event path failed to repair.

The oplog window is a finite recovery budget. Estimate the maximum expected outage and event volume, alert when consumer lag approaches the available history, and review disk capacity before increasing retention. A large backlog may take longer to process than the original outage, so capacity planning should include catch-up rate as well as normal event throughput. Monitor last processed time, checkpoint age, resume failures, duplicate rate, and destination lag.

## Operational commands and restore evidence

Useful shell inspections include `rs.status()` for member health, `db.serverStatus()` for counters, `db.currentOp()` for active operations, and `db.collection.getIndexes()` for index definitions. Capture only the fields needed for diagnosis and avoid copying raw customer documents into shared logs. Backups should have an owner, retention policy, encryption and access controls, and a tested restore procedure with a measured recovery time. A successful backup job is not proof that a point-in-time restore can meet the service objective.

For upgrades, test driver/server compatibility, the supported version path, feature compatibility version, backup validity, and rollback limits. Review release notes for changed telemetry or feature defaults and verify automation against the target deployment before rollout. Rehearse restore and consumer resynchronization; these are the operational equivalents of testing application code paths.
