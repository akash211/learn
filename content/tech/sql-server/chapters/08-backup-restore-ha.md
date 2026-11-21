# Backup, Restore and High Availability

Backups are the foundation of recoverability; high availability reduces downtime but does not replace backups. SQL Server's recovery model determines log behavior and point-in-time recovery options. A correct design starts with recovery point objective (RPO) and recovery time objective (RTO), then proves that the required restore sequence can meet them.

## Recovery models and backup chain

The **SIMPLE** recovery model allows log truncation after checkpoints and does not support log backups, so point-in-time recovery is unavailable. **FULL** supports log backups and point-in-time restore, but the log continues to grow unless log backups are taken and other reuse blockers are cleared. **BULK_LOGGED** can reduce logging for certain bulk operations, but point-in-time recovery within a log backup containing minimally logged operations has restrictions. Recovery model selection is not merely a storage setting; it defines the recovery contract.

A typical FULL model strategy uses periodic full backups, optional differential backups, and frequent transaction-log backups. A differential contains changes since the last full backup. Restore the chosen full, then the applicable differential, then every subsequent log backup in order, using `NORECOVERY` until the final restore. `STOPAT` supports point-in-time recovery when the log chain and required backups are intact. A copy-only full backup does not reset the differential base.

```sql
BACKUP DATABASE Sales TO DISK = 'E:\\backup\\Sales_full.bak'
  WITH CHECKSUM, COMPRESSION;
BACKUP LOG Sales TO DISK = 'E:\\backup\\Sales_log.trn'
  WITH CHECKSUM, COMPRESSION;
```

Backup destinations and syntax must be adapted to the host and security model. Maintain backup history and retention, keep copies outside the database host or failure domain, and protect encryption keys and certificates. `RESTORE VERIFYONLY` checks backup readability and some structure, but it does not prove that a complete database can be recovered. Restore drills are the proof.

## Log reuse and recovery

`sys.databases.log_reuse_wait_desc` explains why a log cannot currently truncate, with causes including `LOG_BACKUP`, `ACTIVE_TRANSACTION`, availability replica lag and replication. A full disk is not fixed by repeatedly shrinking the log; identify the reuse blocker, take the needed backup or resolve the transaction/replica issue, then size the log for normal peak usage. Pre-size it and choose growth increments thoughtfully.

## Availability groups and failover

Always On availability groups replicate database log records to secondary replicas. Synchronous commit waits for the synchronous replica to harden log before the primary acknowledges a commit, improving potential data-loss protection at the cost of latency and availability dependencies. Asynchronous commit reduces that coupling but can lose recent transactions on forced failover. Automatic failover requires an appropriate synchronous configuration and health conditions. Readable secondaries, backup preference and listener behaviour are configuration choices with version, edition, cluster and service-specific limits.

An availability group is not a backup. It can replicate accidental deletes, logical corruption and unwanted schema changes. Maintain independent backups and practice recovery from them. Log shipping and failover clustering are different HA approaches: clustering protects an instance through shared or replicated storage, while log shipping restores log backups to another database, typically with a deliberate failover process.

## Validate the recovery objective

Track backup age, job status, file size, checksums and log backup gaps. Periodically restore to an isolated host, run `DBCC CHECKDB` on the restored copy where feasible, validate application-level data, and measure elapsed recovery time. `msdb` backup history is useful but can be purged or lost with the instance; external job monitoring should preserve evidence. Test encrypted backup key recovery, credentials, DNS/listener changes and application reconnection as part of an HA drill.

A restore plan should also specify the order and destination of filegroups when piecemeal restore is part of the design. Keep backup media readable with checksums, but remember that checksum validation detects some corruption rather than proving semantic correctness. Document who can access backup encryption certificates and where their private keys are retained. A key stored only on the failed server is not a recovery strategy. For availability groups, monitor both log send and redo queues: a secondary can have received log but still be behind in applying it, affecting read freshness and failover readiness.

## Common mistakes

- Assuming a full backup alone supports point-in-time restore under FULL recovery.
- Switching to FULL and never taking the first full backup or subsequent log backups.
- Shrinking a log instead of resolving the reuse wait and setting a sustainable size.
- Treating an availability group replica as protection against user error or corruption.
- Claiming a backup is recoverable because the job succeeded or `RESTORE VERIFYONLY` passed.
- Designing RPO and RTO from product labels rather than measuring restores and failovers.


## Availability groups: commit, health and data movement

An availability group protects a set of user databases through log transport and redo on secondary replicas; it is not storage replication of every instance-level object. Logins, SQL Agent jobs, credentials, linked servers, certificates and server configuration need their own synchronization or deployment plan. A listener provides a stable client endpoint, but DNS caching, connection retry and read-only routing configuration affect application behavior after failover. Test actual client drivers and connection strings, not just the cluster role transition.

Synchronous commit waits for a synchronous secondary to harden log before acknowledging a commit. This can support automatic failover with no data loss when the replica is synchronized and health conditions are met, but network latency and replica availability become part of the commit path. Asynchronous commit allows the primary to acknowledge before remote hardening and is appropriate over distance or where primary availability dominates, with potential data loss on forced failover. “Synchronous” does not mean zero latency or unconditional automatic failover; inspect synchronization state, failover mode, quorum and health configuration.

`sys.dm_hadr_database_replica_states` exposes per-database synchronization state and log send/redo queue information. A secondary can have received log but not yet redone it, so a readable secondary may be stale and failover readiness may differ from send status. `sys.dm_hadr_availability_replica_states` and cluster health events add replica-level context. Capture interval trends, not a single queue snapshot. Backup preference is a policy signal, not a guarantee that a particular backup runs on the intended replica; verify job logic and backup history.

## Restore sequence is the recovery contract

Under FULL recovery, establish the log chain with a full backup and then recurring log backups. Restore a selected full using `NORECOVERY`, optionally restore a differential based on that full, then apply subsequent log backups in order. The final log restore can use `STOPAT` and `RECOVERY` to open at a point in time. A copy-only full does not become the differential base. Keep backup files, encryption certificates and private keys beyond the failure domain of the database host. `RESTORE VERIFYONLY` is a useful media check but not proof of a functioning database or correct application data.

A recovery drill should restore to an isolated target, measure time, run integrity checks as appropriate, validate application-level records and test credentials and key recovery. Confirm actual RPO from backup intervals and actual RTO including DNS, application reconnect and validation. Check `sys.databases.log_reuse_wait_desc` for log reuse blockers rather than shrinking the file. Availability groups can replicate deletes or corruption, so independent, protected backups and restore exercises remain mandatory. Record who owns the procedure and make the latest successful drill discoverable during an outage.
