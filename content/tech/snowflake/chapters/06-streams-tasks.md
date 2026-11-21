# Streams, Tasks and CDC Orchestration

Snowflake can run a change-data-capture pipeline without an external scheduler: a stream records what changed in a table, and a task runs SQL when there is something to do. The pair is small and sharp. It is also easy to leave silently broken, because a failed task does not page anyone and a stale stream does not announce itself.

## Streams record offsets, not data

```sql
CREATE STREAM raw.events_stream ON TABLE raw.events;

SELECT METADATA$ACTION, METADATA$ISUPDATE, METADATA$ROW_ID, *
FROM raw.events_stream;
```

A stream is not a copy of the changed rows. It holds an offset into the source table's change tracking, plus the metadata needed to reconstruct the delta: `METADATA$ACTION` (`INSERT` or `DELETE`), `METADATA$ISUPDATE` (true for both halves of an update, which appears as a delete plus an insert), and `METADATA$ROW_ID`.

The offset advances when a DML statement that reads the stream commits. That is the mechanism and the trap: a `MERGE` from a stream consumes the changes as part of its own transaction, so if the transaction rolls back, the offset does not move and the changes are still there for the next attempt. Good. But `SELECT * FROM stream` in a worksheet consumes nothing, which is why you can inspect a stream repeatedly without losing data.

A stream can be standard or append-only. On ordinary tables, a standard stream records net inserts, updates and deletes; an append-only stream returns inserted rows only, which is cheaper for append-only ELT but cannot represent deletes. Stream types and change tracking vary by source object: views, dynamic tables, external tables and directory tables have different supported combinations, so do not assume a standard table stream definition applies to all of them.

## Staleness is the failure mode

A stream can only reconstruct changes while the source table's time travel still covers them. If nobody consumes it for longer than `DATA_RETENTION_TIME_IN_DAYS`, the stream becomes stale and any query against it fails with `STALE_STREAM`. There is no repair: you must recreate the stream and you have permanently lost the delta for that window.

This is why the retention setting on a source table is a pipeline parameter, not a housekeeping detail. A task that runs hourly with one day of retention tolerates a day of failure; a task that has silently failed for three days on a table with one-day retention has already lost data.

For ad-hoc point-in-time diffs — "what changed in the last hour" without a persistent object — the `CHANGES` clause does the same job:

```sql
SELECT * FROM raw.events
  CHANGES (INFORMATION => DEFAULT)
  AT (OFFSET => -3600);
```

## Tasks

```sql
CREATE TASK raw.merge_events
  WAREHOUSE = wh_load
  SCHEDULE = '5 MINUTE'
  WHEN SYSTEM$STREAM_HAS_DATA('raw.events_stream')
AS
  MERGE INTO analytics.events t
  USING (
    SELECT *
    FROM raw.events_stream
    WHERE NOT (METADATA$ACTION = 'DELETE' AND METADATA$ISUPDATE)
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY event_id ORDER BY source_updated_at DESC) = 1
  ) s
  ON t.event_id = s.event_id
  WHEN MATCHED AND s.METADATA$ACTION = 'DELETE' THEN DELETE
  WHEN MATCHED THEN UPDATE SET t.payload = s.payload, t.loaded_at = CURRENT_TIMESTAMP()
  WHEN NOT MATCHED THEN INSERT (event_id, payload, loaded_at)
       VALUES (s.event_id, s.payload, CURRENT_TIMESTAMP());

ALTER TASK raw.merge_events RESUME;
```

Three details in that block are load-bearing. First, tasks are created **suspended**; a task that was never resumed is the most common reason a pipeline "does nothing". Second, `WHEN SYSTEM$STREAM_HAS_DATA(...)` stops the task from waking a warehouse on an empty schedule — without it you pay for a warehouse resume every five minutes regardless. Third, a key can appear several times in one stream batch (an insert followed by an update), so the `QUALIFY` dedupe takes the latest change per key; `MERGE` with duplicate source rows fails with "unstable row" errors.

Tasks can form a DAG with `AFTER`:

```sql
CREATE TASK analytics.build_daily
  WAREHOUSE = wh_transform
  AFTER raw.merge_events
AS INSERT INTO analytics.daily SELECT ... FROM analytics.events;
```

Only the root has a schedule; children run when the predecessor succeeds. Creating a child task does not require a schedule, and a failure upstream skips the downstream tasks rather than running them on stale input — which is the correct default, though it means one failed root silently disables a whole branch.

## Serverless versus warehouse tasks

A task either names a warehouse or runs as a serverless task with Snowflake-managed compute. Warehouse tasks give you control over size and visibility in `WAREHOUSE_METERING_HISTORY`, and are right for heavy transformations. Serverless tasks are right for short, frequent, sporadic work where a warehouse resume would dominate the runtime; their cost appears in its own history rather than in warehouse credits.

Task settings that matter:

| Setting | Effect |
| --- | --- |
| `SCHEDULE` | `CRON` expression or `n MINUTE` interval; minimum granularity is one minute |
| `ALLOW_OVERLAPPING_EXECUTION` | Default false; true lets a slow run overlap the next |
| `USER_TASK_TIMEOUT_MS` | Kills a run that exceeds the limit |
| `SUSPEND_TASK_AFTER_NUM_FAILURES` | Stops a repeatedly failing task instead of retrying forever |

Leaving `ALLOW_OVERLAPPING_EXECUTION` false is the right default for `MERGE` pipelines: overlapping runs compete for the same rows and can deadlock on the same partitions. It is the wrong default for a long-running aggregation that must not be skipped, where a shorter schedule than the runtime means runs are constantly cancelled.

## Operating the pipeline

`TASK_HISTORY` is the only reliable source of truth:

```sql
SELECT name, state, scheduled_time, completed_time, error_code, error_message
FROM TABLE(information_schema.task_history(
  scheduled_time_range_start => DATEADD(hours, -24, CURRENT_TIMESTAMP())))
ORDER BY scheduled_time DESC;
```

States are `SUCCEEDED`, `FAILED`, `SKIPPED`, `CANCELLED`. A run of `SKIPPED` on a child task usually means the root failed or the `WHEN` condition was false. `GRAPH_RUN` groups a DAG execution, which is how you trace one bad night end to end.

There is no automatic retry. The next scheduled run happens, and if the cause was transient it will heal; if the cause was a schema change, every subsequent run fails identically. Alert on `FAILED` counts per task per hour, and separately on "no successful run in N periods", because the second catches a task that was suspended and never resumed.

## Where tasks stop being the right tool

Tasks are a scheduler inside the warehouse: they can run SQL, call stored procedures, and chain within a DAG. They are not a general orchestrator. Cross-system dependencies, retries with backoff, alerting, backfills over a date range, and visibility across a hundred pipelines are all weaker than in Airflow or Dagster. The pragmatic split is common: external orchestration for the pipeline graph, tasks and streams for the intra-warehouse CDC steps that benefit from running close to the data with no network hop.

## Common mistakes

- Creating a task and forgetting `ALTER TASK ... RESUME`, then debugging the SQL for an hour.
- Consuming a stream with `SELECT` and assuming the offset advanced.
- Merging from a stream without deduplicating keys, producing "unstable row" failures under normal update traffic.
- Setting a one-minute schedule with a two-minute runtime and overlapping execution enabled, so runs fight each other.
- Leaving a table's retention at one day while the task has a five-day failure budget.
- Alerting on task failures but not on staleness, so a suspended task is discovered by an analyst, not by monitoring.

## Production notes

Name tasks by target, not by schedule (`merge_events`, `build_daily`), because schedules change. Keep DAG depth shallow: each `AFTER` hop adds a failure point and a delay. Store the `WHEN` predicate on every stream-driven task. And build one dashboard that shows, per pipeline: last successful run, rows merged in the last 24 hours, stream staleness in hours, and warehouse credits. That single view catches most silent failures before the data does.
