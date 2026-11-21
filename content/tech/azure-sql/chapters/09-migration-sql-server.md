# Migration from SQL Server

Moving a workload from SQL Server to Azure SQL Database is a platform migration, not just a backup upload. The destination is a database-scoped managed service; it does not provide every SQL Server instance feature or administrative permission. A successful project inventories dependencies, assesses compatibility, chooses a data movement method, tests application behavior and rehearses cutover and rollback. Keep Azure SQL Managed Instance and SQL Server on Azure Virtual Machines in scope when instance-level capabilities or operating-system control are requirements.

## Discover and assess

Start with a full inventory: databases, sizes, compatibility levels, collations, users and roles, SQL Agent jobs, linked servers, cross-database references, CLR, Service Broker, replication, file access, server-level triggers, credentials, encryption configuration, backup jobs and application connection behavior. The source database alone may not capture dependencies owned by the instance or by external services. Map each dependency to a supported Azure SQL Database capability, a redesign, or an alternative target.

Microsoft Data Migration Assistant (DMA) can assess SQL Server database compatibility and identify blocking or partially supported features for Azure SQL targets. DMA's report is a useful starting point, not a complete test suite or guarantee. Microsoft has evolved migration tooling, so check current recommendations for Azure SQL migration; Azure Database Migration Service and other supported tools may be appropriate depending on source version, destination and downtime constraints. Do not assume an assessment tool's presence means it is the newest supported path. Preserve the assessment output and adjudicate every finding with an owner.

Classify blockers by impact: schema changes, unsupported syntax, instance dependencies, runtime behavior, security model, operational needs and performance. Test the actual application with representative credentials and workload. Static assessment cannot uncover every dynamic SQL branch, rarely used report, batch job or implicit dependency. Observe production behavior over a representative cycle and inspect Query Store, traces and job schedules where available.

## Compatibility level and SQL behavior

Azure SQL Database's compatibility level influences cardinality estimation and query optimizer behavior for a database. It is separate from the engine version and service tier. A migration can preserve a lower compatibility level to reduce plan changes, then raise it after testing. Keeping an older level forever may prevent newer optimizer improvements and features; raising it without Query Store review can trigger plan regressions. Capture critical workload behavior before and after a change and have a rollback strategy.

Check collations, database-scoped configuration, isolation settings and deprecated features. Azure SQL Database supports much T-SQL, but system stored procedures and server-level DMVs differ. Code that uses `USE` to switch among databases, three-part names across databases, `tempdb` assumptions, `xp_cmdshell`, local file paths, SQL Server Agent or Windows authentication may require redesign or a different service. Elastic jobs, Azure Automation, application schedulers or external orchestration can replace some scheduling use cases, but they have their own semantics and reliability requirements.

Cross-database access is a frequent migration issue. Azure SQL Database does not behave like a conventional SQL Server instance where any database can be addressed with a three-part name. Elastic Query and external data sources can support specific scenarios, but they are not a universal substitute for local joins. Consider consolidating related data, using APIs, materializing data or selecting Managed Instance where instance-level semantics are important.

## Data movement and cutover

Choose the migration method based on data size, downtime budget, source availability, network bandwidth, feature support and the desired cutover mechanics. Offline movement can be simple for smaller databases if downtime is acceptable. Online or low-downtime migration methods require ongoing change capture or replication, supported source/destination combinations, and a carefully synchronized cutover. Azure SQL Database supports certain import/export and copy workflows, but not every native SQL Server backup/restore path. Verify current tooling and limitations before estimating duration.

For any approach, plan data consistency and validation. Compare schema, object counts and important aggregates; run application smoke tests and query checks. Validate permissions and principal mappings because source logins, SIDs and Windows groups do not transfer automatically in the same way to database-scoped Entra identities. Create the destination users and grants explicitly. Decide how to handle logins, secrets, linked service connections, jobs and data encryption keys.

Cutover should have a written sequence: stop or quiesce writes where required; apply final changes; validate data synchronization; switch DNS or application configuration; monitor errors and latency; and preserve the source until acceptance. Include idempotent deployment steps and a rollback decision point. A rollback after the destination accepts writes may require reverse data movement or reconciliation, not merely switching the connection string back.

## Post-migration validation and performance

Do not assume that identical T-SQL produces identical performance. The new tier has different compute, IO, concurrency and resource governance. Capture plans and Query Store data on the source, then compare the destination using representative scale and concurrency. Update statistics and create only justified indexes. Check parameter sensitivity, implicit conversions, collation behavior, connection pooling, retry handling and client TLS settings. Tune capacity only after you identify the limiting resource and compare query-level evidence.

Validate availability, backup retention, PITR, geo-resilience, network access, auditing, diagnostic exports, alerts and restore process. Platform-managed backups replace some engine maintenance tasks but do not replace an organization's recovery test. Confirm deployments and administrative runbooks no longer rely on host access or unbounded instance rights.

### Common mistakes

- Treating DMA as a complete proof of compatibility or using an outdated migration workflow without checking support.
- Assuming a native `.bak` restore or every SQL Server instance feature works in Azure SQL Database.
- Changing compatibility level and tier simultaneously, making regressions hard to attribute.
- Forgetting jobs, users, linked servers, cross-database dependencies and application retry behavior.
- Declaring cutover complete without checking data correctness, security, recovery and workload latency.

### Production notes

Maintain a dependency register with findings, decisions and test evidence. Keep staging representative in data shape and concurrency, while protecting sensitive data. Rehearse both cutover and rollback with explicit ownership. Reassess whether Managed Instance or SQL Server on Azure VMs is the safer target if database-scoped redesign costs or feature gaps outweigh PaaS benefits.

## Migration governance and proof

Assign an owner to each assessment finding and classify it as resolved, redesigned, accepted or a reason to select another target. Record evidence from source inspection, test runs and operational interviews; do not close an item merely because the application compiles. Use a migration rehearsal to measure data movement, final synchronization, validation, DNS or configuration change, and rollback decision time. Check the destination's resource metrics while the full application workload runs, since a test using only a few hand-written queries misses connection pools and scheduled jobs. Freeze schema changes during the final cutover window or ensure they are reproducibly deployed to both sides. After acceptance, remove temporary migration credentials, firewall rules and staging data according to policy.
