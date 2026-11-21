# Time Travel and VACUUM

Every successful Delta commit creates a versioned table snapshot. Time travel lets a reader query a retained version or timestamp, which is valuable for debugging, audit comparisons and repeatable data analysis. It is not a backup system and does not mean every historical row remains available forever: the log may retain a reference to a removed file only while the actual file still exists.

## Read an earlier version

Spark's Delta integration supports version-based and timestamp-based reads, for example:

```python
old = (spark.read.format("delta")
       .option("versionAsOf", 120)
       .load(path))

at_time = (spark.read.format("delta")
           .option("timestampAsOf", "2026-02-15T09:00:00Z")
           .load(path))
```

SQL supports `VERSION AS OF` and `TIMESTAMP AS OF` in compatible runtimes. Timestamp lookup maps a requested time to a commit based on table history and commit timestamps; it is not event-time reconstruction. If source rows have business timestamps, a historical table version tells you what the table contained at a commit, not necessarily what the source system believed at a particular event time.

A version read is especially useful for comparing before and after a bad batch. Once a problem is identified, restore or replay should be a deliberate write, not merely a reader option. `RESTORE` availability and syntax vary by engine; it creates a new version that reverts logical contents to an earlier state rather than rewinding the commit sequence. The restore itself becomes part of history.

## History is not an infinite archive

The log contains commit metadata and the actions needed to reconstruct snapshots. Checkpoints accelerate state reconstruction; log retention settings govern how much of the transaction history remains. Separately, data-file retention determines whether files removed from the active snapshot remain physically present and readable. A table can still show old commit metadata while the data needed for that version has already been deleted, making that historical version unusable.

A crucial distinction:

- **Log cleanup** concerns old transaction JSON/checkpoint history and the ability to inspect or reconstruct older versions.
- **`VACUUM`** removes obsolete data files no longer referenced by the current snapshot, after a retention safety interval.

Neither policy should be confused with a backup, legal hold or source-of-truth archive.

## What VACUUM does

When an update or overwrite replaces a file, the transaction marks that file as removed. It is no longer part of the current snapshot, but remains in storage until eligible for vacuum. A command such as `VACUUM table RETAIN 168 HOURS` removes eligible unreferenced files older than the retention cutoff. Exact implementation and safety checks vary; the common default retention is seven days, but jobs and platform settings can differ.

Retention protects readers and long-running writers that may still be using an older snapshot. If a process starts from version *v*, takes several hours to finish, and the files from *v* are deleted before it completes, that process can fail. Short retention also shortens the practical time-travel window and can make rollback impossible. Delta commonly enforces a minimum retention interval by default; disabling the safety check is dangerous and should not be treated as routine tuning.

Before vacuuming, consider the longest query, stream micro-batch, maintenance operation and recovery workflow. Ensure no client depends on old files. Then verify what the operation will remove using a dry-run mode where the implementation supports it. Keep external backups and recovery copies for requirements that exceed table retention.

## Recovery and restore

If a bad load committed at version 200, inspect history and compare version 199 with 200. If the table needs to be reverted, a supported restore operation can produce version 201 with file actions that make the old snapshot current again—provided its files still exist. If vacuum already removed them, restore may fail or leave you with no safe table-level recovery. The recovery path may then require recreating from a separate backup or source.

Similarly, deleting recent data via `DELETE` does not instantly erase its bytes from old Parquet files. It creates a logical change in the current snapshot; old files can persist until rewrite and vacuum. This is useful for time travel but may conflict with privacy or regulatory erasure obligations. Such obligations require coordinated retention, rewrite/purge procedures and confirmation of physical deletion, including backups and replicas where relevant.

## Common mistakes

- **Treating `VACUUM` as table optimization.** It deletes obsolete files; it does not compact active small files.
- **Assuming a timestamp read is source event time.** It selects a committed table version by commit timestamp.
- **Running `VACUUM RETAIN 0 HOURS` to reclaim space quickly.** This can delete files needed by active readers or rollback paths.
- **Assuming `RESTORE` can resurrect vacuumed files.** A log reference cannot recreate missing data.
- **Equating logical delete with erasure.** Removed rows can remain in old files until physically rewritten and expired.

## Production notes

Set retention from a recovery objective, not from storage-cost intuition alone. Keep a runbook that states what versions can be queried, how to restore, who approves destructive vacuuming, and which independent backup covers longer retention. Monitor both table history and storage footprint; a growing history may call for checkpoint/log policy review, while large obsolete data volume may call for scheduled vacuum after safety checks. Test recovery in a non-production copy before shortening retention.

## Designing a retention window

Retention should cover more than the normal query duration. Include the time to detect a bad result, investigate it, obtain approval, restore or replay, and validate downstream consumers. A seven-day default is a common starting point in Delta workflows, not a universal service-level commitment; some systems need much longer protection. Account for the slowest stream micro-batch, scheduled backfill, long-running BI query and maintenance job that can still hold a snapshot.

A practical policy separates routine table retention from archival backup. Keep the former long enough for ordinary time travel and safe readers; use independent object versioning, snapshots, replicated backups or replayable source data for disaster recovery and legal obligations. Object-store lifecycle rules must not delete files that the Delta table still references, nor should they race with vacuum. Record retention changes in a reviewed config, alert on unexpected file disappearance, and periodically test both version reads and a restore on an isolated copy. The test should prove data availability, not only that a command completes.

## Time travel as a debugging workflow

When a metric changes unexpectedly, pin both the suspect and preceding versions, then compare the smallest useful slice: affected keys, partitions and aggregates. This avoids confusing a source-data difference with a query-code change. Capture the table version alongside every downstream report or model build that may need to be reproduced. A timestamp alone is weaker when several commits land close together or clocks and time zones are misunderstood.

For repair, prefer a new, auditable commit through a supported restore or recomputation path. Decide explicitly what to do with valid commits that happened after the faulty one; reverting the entire table can discard their changes. If only a subset is wrong, a targeted correction may be safer than whole-table restore, but it must use business keys and preserve invariants. Once the repair is validated, retain its source evidence and note the versions involved. Time travel is most useful when history, files and operational metadata are preserved together, which is why retention policy belongs in the incident plan.