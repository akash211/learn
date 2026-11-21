# Operating TimescaleDB

Operating TimescaleDB is operating PostgreSQL plus an extension with background jobs and time-series storage features. CPU, memory, connections, WAL, checkpoints, replication, vacuum, disk, and backups are still PostgreSQL concerns. Extension compatibility and policy-job health add additional checks. Operational simplicity depends on choosing a supported extension/server combination and rehearsing changes before production.

## Backups and restore

`pg_dump` makes a logical dump of database objects and data. It is useful for selective export, migration, and restoring into a compatible or newer PostgreSQL environment, but a large dump can be slow and does not by itself provide point-in-time recovery. Ensure the TimescaleDB extension is installed on the target before restoring objects that depend on it, and review extension-specific backup guidance for the release in use.

Physical backups copy the PostgreSQL data directory consistently, commonly using `pg_basebackup` or a mature backup tool, and combined with archived WAL they support point-in-time recovery. Physical recovery is tied to PostgreSQL major-version and cluster compatibility rules. A restore needs the appropriate TimescaleDB binary/library, preload configuration where required, and compatible extension version. A dump that succeeds without the extension or a base backup restored without extension libraries is not a successful service restore.

Choose a recovery point objective and recovery time objective, then test them. Restore a representative backup to an isolated environment, load the extension, check `pg_extension` versions, validate hypertables and policies, and run application queries. Back up WAL continuously if PITR is required. Snapshots alone are not enough unless consistency and WAL requirements are addressed. A backup is evidence of recoverability only after a timed restore test.

## Upgrades and compatibility

There are two upgrade layers: PostgreSQL major version and TimescaleDB extension version. PostgreSQL major upgrades usually require `pg_upgrade` or logical migration; the extension may need a compatible package for source and target, and a supported upgrade sequence. Extension updates commonly use `ALTER EXTENSION timescaledb UPDATE` after installing the new library, but the exact target version, required pre/post steps, and restart needs depend on release. Read the current upgrade matrix and release notes rather than assuming `ALTER EXTENSION` alone completes every migration.

Before upgrade, inventory extension version, policies and jobs, custom functions, dependent extensions, PostgreSQL version, and deployment packaging. Test on a recent clone, including restore, query plans, compression/columnstore, and continuous aggregate refresh. Pause or coordinate background jobs when the documented procedure requires it. Keep a tested rollback strategy; in-place extension changes may not be reversible after catalog migrations.

Avoid installing a different extension version on one replica than the primary unless the vendor explicitly supports the topology and operation. Replication, failover, and managed-service extension availability are version- and provider-dependent. Confirm the extension is available in the failover region before relying on automatic promotion.

## Monitoring

Monitor the ordinary PostgreSQL signals: connections and pool saturation, query latency, locks, CPU, memory pressure, disk and IOPS, WAL volume, checkpoint behavior, vacuum progress, replication lag, and backup age. Add hypertable-specific observations: chunk count and size distribution, rows per chunk, compression/columnstore conversion backlog, continuous aggregate freshness, retention candidates, and background job errors or duration. Job catalog view names vary by TimescaleDB release, so use the views shipped with the installed extension.

`pg_stat_statements` helps identify expensive query fingerprints; `EXPLAIN (ANALYZE, BUFFERS)` reveals whether time pruning, indexes, or aggregate materialization behave as intended. Alert on symptoms with actionable thresholds: oldest retained timestamp unexpectedly moving, a continuous aggregate behind its freshness SLA, a job failing repeatedly, replica lag during compression, or a chunk count growing much faster than expected. Averages hide one hot tenant or a single enormous chunk, so examine distributions.

## When not to use it

Plain PostgreSQL is usually preferable when the dataset is modest, retention is simple, and native range partitioning or ordinary indexes solve the problem. Avoid an extension when deployment environments cannot install or upgrade it reliably, a managed database does not support the needed release, or the team cannot test its restore and major upgrade path. Operational dependencies are part of the architecture.

A columnar analytics store may be better when the workload is dominated by broad scans across many years, high-cardinality grouping over large data, or many concurrent analytical users. Column stores compress and execute wide scans efficiently, while TimescaleDB's PostgreSQL foundation is valuable for relational joins, transactional integration, and mixed OLTP/analytics. Many systems combine them: retain operationally useful recent data in TimescaleDB and export historical or analytical data to a warehouse. Account for replication delay, schema evolution, and duplicated governance.

## Common mistakes

- Treating `pg_dump` as point-in-time recovery or as a substitute for WAL archiving.
- Upgrading PostgreSQL without checking the extension's compatibility matrix.
- Monitoring only PostgreSQL and ignoring extension background jobs and aggregate freshness.
- Assuming compression means backups are smaller, faster, or unnecessary.
- Choosing TimescaleDB for a workload better served by plain PostgreSQL or a columnar engine.

## Production notes

Pin tested versions, maintain a tested restore runbook, and rehearse extension and server upgrades. Alert on database health and data lifecycle outcomes. TimescaleDB simplifies time-oriented operations, but it does not transfer ownership of durability, correctness, and capacity planning away from the operator.

## Capacity and incident response

Plan disk for more than steady-state relation size. WAL retention, checkpoints, temporary query files, backups, replicas, and rewrite or conversion work all need headroom. A retention policy can reclaim old chunks, but a failed job does not prevent data from accumulating. Alert on free space and on estimated time to exhaustion from observed growth. During an incident, identify whether growth comes from heap/indexes, WAL, temporary files, or backup staging before deleting data or changing a policy.

Keep runbooks for a stuck background job, failed continuous aggregate refresh, extension library mismatch after package update, and replica lag caused by bulk maintenance. Record safe actions and escalation conditions. Restarting PostgreSQL may not resolve a failed policy and can worsen availability if replicas or extension versions are inconsistent. Prefer diagnosis from job logs, database state, and release-specific troubleshooting documentation.

Extension upgrades must be included in disaster recovery drills. A restored environment may start with old extension binaries while the catalog records a newer version, or vice versa. Document package installation and configuration order, and validate `CREATE EXTENSION`/`ALTER EXTENSION` state before accepting application traffic. Managed platforms can constrain supported versions and upgrade order; coordinate with provider maintenance windows.

## Managed service and deployment checks

On a managed PostgreSQL service, confirm extension allowlisting, supported versions, preload settings, backup coverage, and failover behavior before designing around TimescaleDB. The provider's maintenance process may upgrade PostgreSQL and the extension on different schedules. Test whether policies and jobs are preserved through failover and whether the standby has the required extension package before promotion.

For self-managed deployments, build extension packages into the same image or repository process as PostgreSQL packages and pin them consistently across primary, standby, and restore hosts. A package update without a coordinated database upgrade can leave a service unable to start or an extension catalog requiring migration. Treat the runtime library as part of the database release artifact.
