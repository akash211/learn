# Backups and Point-in-Time Recovery

A backup is useful only if it can be restored to a consistent database within the required recovery time and point. MySQL backup planning combines a base backup with binary-log retention for point-in-time recovery (PITR), plus tested procedures for credentials, configuration, encryption, and application cutover. A replica is not a backup: accidental deletes and corruption can replicate.

## Logical dumps with mysqldump

`mysqldump` produces SQL statements that recreate schema and data. For InnoDB, `--single-transaction` provides a consistent snapshot without locking all tables for the duration, assuming no incompatible DDL changes occur during the dump. It does not create a consistent snapshot of nontransactional tables in the same way. Use explicit database selection and include routines, events, and triggers when needed.

```sh
mysqldump --user=backup --single-transaction --routines --events \
  --triggers --databases appdb > appdb.sql
```

Large logical dumps can be slow to restore because they replay SQL and rebuild indexes. They are portable and inspectable, and are practical for smaller databases or selective exports. Protect dump files as production data, handle credentials through a secure mechanism rather than command-line passwords, and capture errors and exit status. Compression saves space but adds CPU and does not replace encryption at rest or in transit.

## Physical backups with XtraBackup

Percona XtraBackup takes physical hot backups of InnoDB data files and prepares them by applying redo needed to make the copied pages consistent. It can be much faster for large datasets than replaying SQL, but its compatibility requirements matter: match the XtraBackup release to the MySQL or Percona Server version, and check supported storage engines and features. Managed database services may not permit it; use the provider's supported backup mechanism instead.

A physical backup is not immediately equivalent to a running data directory. Preparation is part of the procedure, and restore should be performed to a clean target with correct ownership, configuration, and version compatibility. Protect the backup and its metadata, including the binlog coordinates or GTID information needed to continue recovery.

## Binary logs and PITR

The binary log records transactions after the base backup point. To recover to a time before an accidental change, restore a valid base backup to an isolated server, then replay binlog events only up to a selected time or position before the destructive transaction. Test the exact tooling and event-boundary procedure; do not improvise against the only production copy. A target timestamp can be ambiguous under clock changes or long transactions, so transaction identifiers, GTIDs, and careful event inspection may be needed.

```sh
mysqlbinlog --start-datetime='2026-05-10 00:00:00' \
  --stop-datetime='2026-05-10 14:32:00' binlog.000123 | mysql
```

This illustrates syntax, not a complete recovery runbook. The server and client versions, binlog format, time zone, event positions, and target state all matter. Never replay untrusted or unreviewed logs directly into a production endpoint. Preserve binlogs continuously and ensure their retention exceeds the maximum interval between base backups plus the required recovery window.

## Consistency and verification

For a consistent logical backup, coordinate transactional snapshots, DDL freezes or controls, and non-InnoDB tables. For physical backups, follow the tool's prepare procedure and capture the correct metadata. Encrypt and transfer backups to a failure domain separate from the database. A backup stored only on the same volume does not protect against volume loss or account compromise.

A restore test is the evidence that a backup works. Regularly restore into an isolated environment, verify expected databases, tables, row counts or application checks, and measure recovery time. Track restore duration and data age against recovery time objective (RTO) and recovery point objective (RPO). Include encryption-key access and infrastructure provisioning in the test; a technically sound backup that cannot be decrypted during an incident is unusable.

## Restore drills and recovery choices

Practice both full-instance restore and selective recovery. A full restore answers whether the service can return within its RTO; selective recovery answers whether a small set of rows can be recovered without overwriting valid changes committed after the incident. Selective extraction is not always safe to merge: foreign keys, generated values, and subsequent updates can make a restored row inconsistent with current state. Restore to a separate instance, compare with current production, and apply an application-aware reconciliation procedure.

For a physical backup, preserve the exact backup tool version, configuration, preparation logs, and metadata. Make sure the target has sufficient space for data, temporary files, redo application, and restored indexes. Validate server startup on the intended MySQL release and check that required plugins, character sets, time zones, grants, and replication settings are present. A copied data directory without compatible configuration or encryption keys may not be usable. Keep key material separate but accessible under the incident procedure.

If the backup is taken from a replica, document whether replication was stopped or coordinates were recorded consistently, and confirm the process did not skip transactions. Backups should be isolated from source credentials and deletion privileges when possible. Use immutable or versioned storage against accidental or malicious deletion. Alert on unusual backup size drops or missing logs, because a job can succeed while silently omitting a schema.

Define the recovery target in business language: which committed work may be lost, and how quickly service must resume. Recovery teams need authority to stop writes, choose the target, and communicate uncertainty. Rehearse a clean restore and a deliberately interrupted restore so operators learn how to resume or discard partial state. Record measured durations and revise the runbook after every exercise.

Recovery tooling deserves version control just like application code. Keep tested commands and configuration alongside the runbook, but never commit passwords, encryption keys, or customer data. Pin compatible client and backup utility versions in the recovery environment and periodically verify they remain available when production credentials or cloud accounts rotate. Restrict who can initiate destructive restore or cutover actions, while ensuring an emergency operator can obtain the required approvals without an unavailable dependency.

For binlog replay, preserve the original files and hash or otherwise inventory the received set before analysis. Run `mysqlbinlog` against a copy in a sandbox first, inspect output around the target transaction, and account for session settings embedded in events. A recovery rehearsal should include a deliberately malformed or missing log segment so the team learns to detect a broken chain rather than silently claiming a precise recovery point.

## Production notes

- Use least-privilege backup accounts and secure credential files or an approved secrets mechanism.
- Monitor backup completion, size anomalies, binlog disk consumption, and restore-test results.
- For point-in-time recovery, preserve base-backup metadata and every required binlog without gaps.
- Document how to keep the application from writing to the recovered instance before validation and cutover.

## Common mistakes

- Treating a successful dump command as proof of a valid, restorable backup.
- Forgetting stored routines, events, triggers, grants, or other required objects.
- Using `--single-transaction` while assuming it makes nontransactional tables consistent or prevents DDL races.
- Deleting binary logs before confirming all backups and consumers no longer need them.
- Restoring over the source before checking the recovered data and the selected recovery point.
