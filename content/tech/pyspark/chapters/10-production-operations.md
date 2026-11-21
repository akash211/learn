# Production Operations, Monitoring and Failure Modes

A PySpark job that works on a sample is only part of the way to a job that runs nightly for two
years. The rest is sizing, idempotency, layout maintenance, and knowing what each error message
means at 3 a.m.

## Sizing the cluster

Work backwards from partition size, not from "give it as much as possible".

1. Estimate the largest shuffle partition: `shuffle_bytes / spark.sql.shuffle.partitions`.
2. Target 100–200 MB per task. That fixes the partition count.
3. Give each core 4–8 GB of heap, so 3–5 concurrent tasks fit comfortably.
4. Add 10% overhead (more for Python and Arrow work).
5. Add driver memory for the plan, broadcast collection and any `collect()`.

```python
spark.conf.set("spark.executor.cores", "5")
spark.conf.set("spark.executor.memory", "20g")
spark.conf.set("spark.executor.memoryOverhead", "4g")     # >= 10%, more with pandas UDFs
spark.conf.set("spark.sql.shuffle.partitions", "2000")
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.parallelismFirst", "false")
```

A 20 GB / 5-core executor gives 4 GB per concurrent task. A 64 GB / 16-core executor gives 4 GB
per task too, but one GC pause stops sixteen tasks instead of five.

Dynamic allocation (`spark.dynamicAllocation.enabled=true`) releases idle executors, with
`executorIdleTimeout` (60 s), `minExecutors`, `maxExecutors`. It requires an external shuffle
service (`spark.shuffle.service.enabled=true`) or shuffle tracking, otherwise released executors
take their shuffle files with them and reducers fail with `FetchFailedException`.

## Idempotency

Every production job will be re-run — after a failure, a backfill, or an upstream correction. A
job that appends blindly duplicates data.

- **Partition overwrite, dynamic.** `spark.sql.sources.partitionOverwriteMode=dynamic` makes
  `write.mode("overwrite")` replace only the partitions present in the new data. In the default
  `static` mode it replaces the whole table.
- **MERGE for upserts.** Delta `MERGE INTO` (or Iceberg `MERGE`) handles inserts, updates and
  deletes in one transaction. It needs a unique key and deduplicated source rows, or it fails with
  "multiple source rows matched".
- **Deterministic dedupe.** `dropDuplicates(["id"])` keeps an arbitrary row. Use a window —
  `row_number() over (partition by id order by updated_at desc) = 1` — instead.
- **Idempotent writes on object storage.** Delta and Iceberg commit atomically via a log. Plain
  Parquet overwrite is not atomic: a failed job can leave a half-written table. Write to a
  temporary prefix and swap, or use a table format.
- **Delta idempotent append.** `txnAppId` / `txnVersion` options make a retried append a no-op
  when the same version is replayed. This is the cheapest way to make a streaming or scheduled
  append exactly-once.

## File layout maintenance

Layout decays. Every incremental write adds files; every `MERGE` rewrites some and leaves others;
small batches produce small files. Maintenance is a scheduled job, not a one-off:

| Task | Cadence | Tool |
|---|---|---|
| Compact small files | daily/weekly | `OPTIMIZE` (Delta), `rewrite_data_files` (Iceberg), repartition + rewrite |
| Cluster for skipping | after compaction | `ZORDER BY (filter_col)` / liquid clustering |
| Vacuum old files | weekly | `VACUUM` — default retention 7 days; time travel breaks past it |
| Recompute statistics | after big changes | `ANALYZE TABLE ... COMPUTE STATISTICS FOR ALL COLUMNS` |
| Check partition cardinality | monthly | count directories; a table with 500k partitions is a design bug |

Watch for the two opposite failures: one giant file (no read parallelism) and a million tiny
files (planning time, listing cost, per-file overhead). The target is 128 MB–1 GB files, a few
thousand per table.

## Monitoring

The Spark UI is for diagnosis; monitoring needs numbers over time. Three levels:

**Event logs.** `spark.eventLog.enabled=true` with `spark.eventLog.dir` on durable storage, read
by the History Server. This is the only record of a finished job — the live UI disappears with
the driver.

**Metrics per stage.** From the REST API (`/api/v1/applications/{appId}/stages`) or a listener:

- input bytes and records,
- shuffle write / read bytes,
- spill (memory and disk),
- GC time as a fraction of task time,
- task duration max / median (skew ratio),
- failed tasks and stage retries.

**Business-level checks.** Row counts per partition, null rates on key columns, freshness
(`max(ts)`), duplicate rate on the primary key. A job can be fast and wrong; only these catch it.

Alert on trends, not thresholds: a job that takes 40 minutes when its 30-day median is 12 is a
problem even if 40 minutes is "acceptable". Alert on stage retries and executor loss, which
precede most hard failures.

## Failure modes

| Symptom | Usual cause | Fix |
|---|---|---|
| `java.lang.OutOfMemoryError: Java heap space` | partition too large, broadcast too big, `collect()` | raise partition count, lower broadcast threshold, remove `collect` |
| `Container killed ... exceeding memory limits` | overhead: Python workers, Arrow, native | raise `spark.executor.memoryOverhead` |
| `FetchFailedException` | executor lost, shuffle files gone, shuffle service off | enable external shuffle service, reduce dynamic allocation churn |
| `FileNotFoundException` | concurrent overwrite, S3 eventual consistency, non-atomic commit | table format, `_SUCCESS`-style commit, avoid reading while writing |
| `Task not serializable` | closure captures `SparkSession`, client, lock | extract to a module-level function; capture plain data only |
| `AnalysisException: cannot resolve` | schema drift, renamed column, wrong database | fix upstream contract; fail fast with schema validation |
| `Too many open files` | hundreds of thousands of small files | compact |
| `MetadataFetchFailedException` | metastore throttling from partition explosion | reduce partition cardinality |
| Duplicate rows after a retry | non-idempotent append or `foreach` side effect | partition overwrite / MERGE / dedupe key |
| One task running for hours | skew | salting, hot-key split, AQE skew join |

Two of these deserve emphasis because they are misdiagnosed constantly.

`FetchFailedException` is an infrastructure symptom. The map output vanished because an executor
was released, preempted, or died. Retrying usually succeeds, which is why the failure is
intermittent. Fix the shuffle service and the allocation policy, not the query.

`FileNotFoundException` on object storage is a consistency and concurrency symptom. S3 is
read-after-write consistent now, but listing during a concurrent overwrite still shows a
half-committed prefix. Table formats exist to solve exactly this; if you are on plain Parquet,
write to a versioned prefix and point the readers at it.

## Retries and speculation

- `spark.task.maxFailures=4` — a task is retried four times before the stage fails.
- `spark.stage.maxConsecutiveAttempts=4` — a stage is retried four times before the job fails.
- `spark.speculation=false` by default. Enable it when a handful of stragglers dominate:
  `spark.speculation.quantile=0.75`, `spark.speculation.multiplier=1.5`. Speculation duplicates
  work, so it needs idempotent writes — which you have, because of the section above.

Retries are not free: a failed task on a large partition re-reads and re-shuffles. A job that
"succeeds eventually" after twenty retries is a job that will fail when the data grows 20%.

## Deployment

`spark-submit` with `--py-files` for zipped dependencies, `--jars` for JVM UDFs, and
`--archives` for a packed virtualenv or PEX when the cluster does not have your libraries. On
Kubernetes, the image carries the dependencies and `spark.kubernetes.*` settings carry the
placement; on Databricks, job clusters are defined per job and terminated after the run.

Keep the Spark version pinned. Behaviour changes between minor versions — defaults for AQE,
Arrow conversion, ANSI mode, and error messages — and an upgrade is a release, not a patch.

Test at three levels: unit tests on `local[2]` with small fixtures (fast, catch logic), integration
tests on a sample of real data with the real schema (catch format and null issues), and a
production-shaped dry run into a scratch table (catches sizing and permissions). Schema
assertions in the first two prevent most 3 a.m. pages.

## Common mistakes

- Tuning executor memory before knowing the shuffle partition size.
- Running maintenance only when something breaks.
- Treating a job that passes tests on 1% of the data as production-ready.
- Appending without a dedupe key, then "fixing" duplicates with a `distinct()` that costs an
  extra shuffle.
- Leaving `spark.sql.sources.partitionOverwriteMode` at its default in a backfill.
- Ignoring stage retries because the job ultimately succeeded.

## Production notes

Write down, for each job: owner, schedule, SLA, input tables, output tables, expected row count
per run, and the one metric that indicates trouble. Most incidents are diagnosed by comparing
those numbers to the last good run.

Keep a runbook for the failure table above. The difference between a 20-minute incident and a
four-hour one is usually whether the on-call engineer recognises `FetchFailedException` as
infrastructure rather than rewriting the join at 3 a.m.
