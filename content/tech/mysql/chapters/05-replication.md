# Replication, GTIDs, Lag, and Failover

MySQL replication transmits database changes from a source to one or more replicas. It supports read scaling, recovery options, and data movement, but asynchronous replication is not a consensus protocol and does not by itself guarantee that a promoted replica contains every acknowledged transaction. Design replication together with the application's consistency needs, backup plan, and failover controller.

## Binary log and replica apply

The source writes committed changes to its binary log (binlog). A replica connects, fetches events through its receiver/I/O thread into a relay log, then applies them using its applier. These stages can lag independently: network transfer may be behind, or the relay log may be current while applying changes is slow. Traditional status output exposes source coordinates and replica I/O/SQL state; newer MySQL 8.0 versions also support replication connection and worker status tables in Performance Schema. Inspect both transport and apply progress.

```sql
SHOW REPLICA STATUS\G
```

`Seconds_Behind_Source` is an estimate and can be `NULL`; it is not a complete freshness guarantee. Clock differences, idle periods, and queue behaviour complicate interpretation. Track retrieved and executed GTID sets or log positions, relay-log growth, worker errors, and application-specific freshness probes. A replica can report a healthy thread while serving data that is too stale for a particular decision.

## Binlog formats

The binlog supports replication and point-in-time recovery. `STATEMENT` logs SQL statements, `ROW` records row changes, and `MIXED` chooses between statement and row logging. Row-based logging is the common recommendation for predictable replication because it avoids many statement nondeterminism hazards; it can produce larger logs for bulk updates. Statement-based logging can be compact but depends on deterministic statements and compatible execution context. Configure deliberately and test CDC consumers, which may depend on row images and format details.

```sql
SHOW VARIABLES LIKE 'binlog_format';
SHOW VARIABLES LIKE 'binlog_row_image';
```

The binary log is distinct from InnoDB redo. Redo supports local crash recovery; binlogs record transactions for replication and recovery across time. Both consume disk and must be retained or purged according to replicas, backup policy, and CDC consumers. Do not delete active binlog files manually; use configured expiration and verify every consumer can progress.

## GTIDs simplify transaction identity

Global Transaction Identifiers (GTIDs) identify transactions independently of file-and-position coordinates. In MySQL 8.x, GTID-based replication makes it easier to re-point a replica or provision one from another server because the servers can compare executed transaction sets. `gtid_mode` and `enforce_gtid_consistency` must be configured in a supported transition sequence; changing them on a live topology is a migration, not a casual toggle.

```sql
SELECT @@GLOBAL.gtid_executed, @@GLOBAL.gtid_purged;
```

GTIDs do not automatically resolve conflicting writes in a multi-writer topology. Standard source-to-replica replication is commonly deployed single-writer. Promoting a replica and allowing writes on both old and new sources can create divergent histories. A failover system must fence the former primary or otherwise ensure it cannot continue accepting writes.

## Semi-synchronous replication and acknowledged durability

With asynchronous replication, a source can acknowledge a commit before a replica has received or applied it. Semi-synchronous replication can wait for a replica acknowledgement that it has received and logged an event before acknowledging the client, reducing the window of loss in some failures. It does not mean the replica has executed the transaction or that a quorum has committed it. Behaviour may fall back to asynchronous operation after configured timeouts, depending on configuration, and it adds commit latency.

Specify the recovery-point objective that the topology must meet, and test loss of source, network partition, and replica outage. Managed services implement their own durability and failover guarantees; compare their actual contract with the server-level feature rather than assuming the words “semi-sync” imply zero data loss.

## Lag and apply throughput

A replica may lag because of source write volume, network capacity, storage latency, a long transaction, or limited parallel apply. MySQL supports parallel replication workers; options such as `replica_parallel_workers` and commit-order preservation affect concurrency and ordering semantics. More workers do not guarantee faster apply if changes contend on the same rows or bottleneck on storage. Measure before tuning, and validate behavior for your server release and workload.

Read-after-write consistency needs a policy. Route a user's immediate read to the source, wait until a replica has executed the relevant GTID, or accept staleness explicitly. A generic round-robin reader endpoint cannot promise session consistency unless the routing layer tracks replication progress.

## Failover safely

Failover is a data-integrity operation. Detect source failure, choose the most advanced eligible replica, prevent the old source from accepting writes, promote, reconfigure remaining replicas, and only then restore application write traffic. Verify executed GTID sets and understand any transactions lost or in flight. A DNS update alone does not fence an old writer. Automated failover can reduce recovery time but must be tested during partitions and partial failures, not just a clean process stop.

## Topology and replication filters

A replica can be configured for read-only behaviour, but administrative privileges and configuration determine whether a local session can still write. Enforce write routing and access policy as well as setting `read_only` and `super_read_only` where appropriate. A replica accidentally accepting local writes can diverge; downstream replication and failover then become harder to reason about. Treat source identity, role changes, and promotion state as controlled orchestration data.

Replication filters can omit databases or tables, but they complicate failover and can create cross-schema inconsistency when transactions touch multiple objects. Document filters precisely and test them against DDL and row-based events. A downstream replica, backup process, and CDC consumer may have distinct retention and format needs. If filtered replicas are not intended as promotion candidates, encode that restriction into automation rather than relying on a runbook footnote.

Replication channels allow a server to connect to multiple sources in supported configurations, but multi-source ingestion does not automatically merge conflicting schemas or writes. Define ownership of each replicated dataset and watch channel-specific receiver and applier status. Account for replication credentials, TLS, network ACLs, and stored secrets during credential rotation. A topology diagram should show write authority, event flow, retention, promotion candidates, and which clients read from each node.

## Production notes

- Monitor replica freshness, not only replication thread state; alert on lag and relay-log growth against workload-specific limits.
- Keep binlog retention long enough for backups and consumers, with capacity alarms.
- Record failover runbooks with fencing, promotion criteria, and reconciliation steps.
- Use TLS, accounts restricted to replication privileges, and network controls for replication channels.

## Common mistakes

- Treating `Seconds_Behind_Source = 0` as proof of linearizable reads.
- Confusing relay-log receipt with transaction apply and visibility.
- Assuming semi-sync means a transaction is executed on a replica before source acknowledgement.
- Promoting a replica without fencing the former source.
- Deleting binlogs needed by an offline replica, backup, or CDC consumer.
