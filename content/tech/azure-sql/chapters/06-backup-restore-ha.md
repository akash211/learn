# Backup, Restore and Regional Resilience

Azure SQL Database automates database backups, but automated backup is not the same as a recovery plan. The service can recover from infrastructure faults and offers point-in-time restore, long-term retention options and geo-redundant recovery choices, subject to configuration and service support. Application owners still need to choose recovery point and recovery time objectives (RPO/RTO), verify backup redundancy, understand the target restore topology, and rehearse restoration. A replica is not a backup against accidental deletion or corrupted application logic.

## Automated backups and point-in-time restore

Azure SQL Database performs automated full, differential and transaction log backups to support restore operations. The service manages the backup schedule and chain. Point-in-time restore (PITR) creates a new database restored to a selected time within the configured retention window. It is useful for recovering from a mistaken `DELETE`, faulty deployment or logical data corruption when the desired state is within the retained period. PITR is a restore to a separate database, not an in-place rewind of the running database. Plan the cutover: validate data, redirect clients, reconcile writes that occurred after the restore point, and retire the damaged resource only after approval.

Configure backup retention to match business and regulatory requirements. Short-term retention supports PITR over a finite window; long-term retention (LTR) can retain full backups on a weekly, monthly or yearly pattern for longer periods, depending on service support and policy. LTR is not equivalent to a continuous PITR window. Confirm what backup types and restore targets are available for the selected tier and region. Retention changes can affect future recovery options, so record the policy and audit changes.

Backup storage redundancy determines how backup data is replicated. Locally redundant, zone-redundant and geo-redundant options have different resilience boundaries and availability. If a region-wide incident is in scope, a locally retained backup may not satisfy recovery objectives. Choose redundancy deliberately and ensure compliance allows the selected geography. Validate whether a given configuration can be changed after creation and what transition behavior applies.

## Restore validation and operational playbook

A restore drill proves more than the portal's status field. Choose a recovery scenario, perform the restore to a separate resource, verify schema and data at a known timestamp, run application smoke tests, check identities and network access, and measure elapsed time. PITR restores may not copy every operational setting exactly as expected; validate the resulting tier, network rules, diagnostic settings, authentication and alerting. The restored database can have a different resource identity and endpoint. Document how connection strings, private DNS and secrets will be updated.

Before a production restore, freeze or coordinate writes where necessary. Determine the data-loss window and whether business events after the chosen point can be replayed from an event log or upstream source. Keep the original database available until the restored copy is verified and cutover is agreed. Preserve the incident timeline and point-in-time rationale. Restore permissions should be tightly controlled because recovery creates data-bearing resources.

## Geo-replication and failover groups

Active geo-replication creates a secondary database in another Azure region and asynchronously replicates committed transactions. It can support disaster recovery and, in some architectures, read-only access. Because replication is asynchronous, a forced failover can lose transactions that had not reached the secondary. Planned failover can synchronize data before role change when the primary is available. Application connection behavior and DNS are part of the recovery design, not an afterthought.

Auto-failover groups manage a set of databases and expose listener endpoints for read-write and optionally read-only connections. The group can fail over the databases together and changes the role of the secondary region. Configure the policy and grace period to fit the acceptable outage and data-loss trade-off. Clients must reconnect to the listener, respect DNS TTL and retry transient errors. Test failover and failback because connection pools may retain old addresses and application jobs may not be safe to run in both regions.

Replication is not an independent backup. User error, malicious changes or logical corruption can replicate to the secondary. Keep PITR and LTR policies even when geo-replication is enabled. A failover group also does not automatically replicate every Azure resource dependency: identity assignments, private endpoint/DNS, firewall policy, monitoring, secrets, application compute and downstream services need regional readiness. Maintain a dependency map and recovery runbook.

## Availability zones and service resilience

Some Azure SQL Database tiers support zone redundancy, placing replicas across availability zones within a region. This reduces exposure to a single-zone failure, but it does not protect against regional outages or logical data errors. Availability behavior is service-managed; customers should still understand the selected tier and test client retry and transaction behavior. Review current regional and tier-specific support because capabilities change.

Distinguish service-level availability from application-level recovery. An endpoint that eventually becomes healthy does not guarantee that the application handles in-flight transaction failures correctly. If a connection drops while a write is in progress, the client may not know whether the server committed it. Use idempotency keys, transaction-aware retries and read-after-write verification where needed. Failover tests should cover long-running transactions, background jobs and message consumers as well as simple web requests.

## Recovery objectives and testing

Write down target RPO and RTO and link them to actual service choices. RPO is acceptable data loss; RTO is time to restore service. PITR retention covers recovery from logical incidents, while geo-replication and failover groups target regional availability. These mechanisms have different costs and failure modes. Measure realistic recovery time including decision-making, access approvals, resource provisioning, DNS propagation, application validation and business sign-off.

### Common mistakes

- Treating a secondary replica as protection from logical corruption or accidental deletion.
- Assuming PITR overwrites the existing database or preserves all network and security configuration.
- Enabling a failover group but never testing DNS, connection-pool refresh, permissions and application idempotency.
- Selecting backup redundancy without considering a region outage or data residency.
- Quoting a nominal service recovery objective as a tested application RTO.

### Production notes

Schedule restore and failover exercises and retain evidence: chosen recovery point, elapsed time, data validation, issues, and corrective actions. Rehearse both planned and forced failover in a safe environment. Keep a recovery identity that can restore resources even if the ordinary application identity is compromised, and alert on retention-policy changes.

## Make the recovery target operationally usable

A database restore is only useful if the service can reach the restored endpoint. Prepare templates or scripts for tags, firewall and private endpoint configuration, diagnostic export, alert rules, Entra principals and resource locks. Validate which configuration is inherited and which must be reapplied explicitly after a restore or regional recovery. Keep recovery credentials in a separate administrative boundary from the application's ordinary identity. Use a checklist that records source resource ID, selected timestamp, target region, reason for recovery, approver, data checks and cutover owner. Include cleanup of temporary restored databases after the incident is closed, subject to legal hold and evidence-retention requirements. This operational detail often dominates real recovery time more than the database restore command itself.
