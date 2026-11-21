# Streaming, Auto Loader and Triggers

Streaming on Databricks is Structured Streaming with a managed ingestion front end. The engine is
micro-batch by default, the sink is usually Delta, and the two things that decide whether it
behaves are the **checkpoint** and the **trigger**. Most streaming incidents are one of those two
misconfigured, not a bug in the transformation.

## Sources that matter

| Source | Use |
|---|---|
| `cloudFiles` (Auto Loader) | New files landing in object storage; the default for bronze ingestion |
| Delta table | Incremental reads of another table, including change data feed |
| Kafka / Event Hubs | Event streams with offsets and partitions |
| Kinesis / Pulsar | Cloud-native queues |
| `rate` / `socket` | Development and load testing only |

Auto Loader is the important one. It tracks which files have been ingested, infers and evolves a
schema, and avoids the two classic file-source failures: reprocessing everything on restart, and
listing an ever-growing directory on every batch.

```python
(spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("cloudFiles.schemaLocation", "s3://acme-lake/_schemas/bronze_orders")
    .option("cloudFiles.schemaEvolutionMode", "addNewColumns")
    .option("cloudFiles.schemaHints", "order_ts TIMESTAMP, amount DOUBLE")
    .load("s3://acme-landing/orders/")
    .withColumn("_ingest_time", F.current_timestamp())
    .withColumn("_source_file", F.col("_metadata.file_path"))
    .writeStream
    .option("checkpointLocation", "s3://acme-lake/_checkpoints/bronze_orders")
    .option("mergeSchema", "true")
    .trigger(availableNow=True)
    .toTable("prod.bronze.orders"))
```

Three details in that snippet are doing more work than they look. The **schema location** is where
Auto Loader stores the inferred schema and its evolution history; lose it and the stream starts
over. **`addNewColumns`** lets an upstream addition land instead of failing the pipeline, and
anything it cannot parse goes to `_rescued_data` rather than being dropped. **`_metadata.file_path`**
records provenance, which is the column you will want when a batch of bad records appears.

File detection has two modes. **Directory listing** asks the object store what is new on each
batch: simple, no extra infrastructure, and increasingly expensive as the directory grows because
each listing is a paginated API call. **File notifications** hook SQS/SNS or Event Grid so the
stream is told about new files: cheaper at scale, more setup, and a queue that needs monitoring.
Either way, `cloudFiles.maxFilesPerTrigger` caps how much a single batch consumes.

## Triggers decide the cost model

| Trigger | Behaviour | Use |
|---|---|---|
| Default (micro-batch) | Runs batches back-to-back, sub-second to seconds | Continuous low-latency pipelines |
| `processingTime='5 minutes'` | One batch every interval | Predictable cost, near-real-time |
| `availableNow=True` | Processes all available data, then stops | Scheduled ingestion; the modern replacement for `once` |
| Real-time mode | Long-lived tasks, millisecond latency | Latency-sensitive serving, with operator restrictions |

`availableNow` is the one most teams should default to. It turns a stream into an incremental
batch: the job starts, consumes everything new since the checkpoint, commits, and exits — so a job
cluster can run it every fifteen minutes and cost a fraction of an always-on cluster. You keep
incremental semantics and file tracking; you give up sub-minute latency you probably did not need.

Real-time mode is a genuine differentiator when you need it, but it changes the execution model
and does not support every operator. Check the current support matrix before designing around it.

## Checkpoints are state, not cache

A checkpoint directory holds the offset log, the commit log and, for stateful queries, the state
store. It is how the engine knows what it has already processed and how the Delta sink achieves
exactly-once: the commit is recorded with the batch, so a restart resumes rather than replays.

Rules that prevent most incidents:

- **One checkpoint per query.** Two streams sharing a checkpoint corrupt each other's offsets.
- **Never delete a checkpoint to "reset".** That is a decision to reprocess or lose data, and it
  should be made explicitly, with the target table truncated or deduplicated first.
- **Changing the source or the query shape usually needs a new checkpoint.** Reusing one across a
  changed schema is a common cause of startup failures.
- **Keep it in durable storage**, not on a cluster's local disk.

Exactly-once applies to the Delta write. It does not extend to a `foreachBatch` function that
calls an API, writes to two tables, or publishes to Kafka. Those need idempotency of their own: a
`MERGE` keyed on an event id, an upsert, or a deduplication step downstream.

## State, watermarks and late data

Stateful operations — aggregations, stream-to-stream joins, `dropDuplicates` — keep state per key
across batches. Without a watermark that state grows forever, and the query eventually dies on
executor memory or state store size.

```python
(df.withWatermark("event_time", "2 hours")
   .dropDuplicates(["event_id"])
   .groupBy(F.window("event_time", "10 minutes"), "region")
   .count())
```

The watermark says "accept data up to two hours late, discard older". It bounds state and defines
what "late" means for the business. Choose it from the source's actual lateness, not from a round
number; too tight drops real events, too loose keeps state large.

Stream-to-stream joins require watermarks on both sides and a constraint on the join key range,
otherwise the engine cannot bound the state it must retain.

## Reading Delta as a stream

A streaming read of a Delta table sees new commits as new data. If another writer rewrites files
(`OPTIMIZE`, `DELETE`, a `MERGE` that rewrites), the stream can fail on a metadata change or skip
commits depending on the option in use. `skipChangeCommits` makes the stream ignore file-rewriting
commits and continue with appends, which is often what a downstream consumer wants — but it means
the consumer does not see updates or deletes.

For change propagation, use the change data feed: `readChangeFeed` yields `_change_type`,
`_commit_version` and `_commit_timestamp`, which is the basis for incremental silver models and
for `APPLY CHANGES` in declarative pipelines.

## Monitoring

`StreamingQueryProgress` and the Spark UI's streaming tab give input rows, processing rate, batch
duration and state size. The two metrics worth alerting on are **backlog** (input rate persistently
above processing rate) and **zero input** (the source stopped delivering, which looks identical to
a healthy idle stream).

For Auto Loader in notification mode, watch the queue: a growing SQS or Event Grid backlog with an
idle stream means the notification path is broken, not that there is no data.

Autoscaling a streaming cluster is awkward because load arrives in bursts. Enhanced autoscaling,
where available, sizes from backlog; otherwise a fixed cluster sized to peak backlog is more
predictable than a classic autoscaler that scales down mid-batch.

## Common mistakes

- **`once` in new pipelines.** Use `availableNow`; `once` is deprecated and less flexible.
- **Deleting a checkpoint after a schema change.** Duplicates or silent data loss.
- **`foreachBatch` with `INSERT INTO`.** Retries duplicate rows; use `MERGE`.
- **No watermark on `dropDuplicates`.** Unbounded state and eventual failure.
- **Listing mode on a directory with millions of files.** API throttling and slow batches.
- **Ignoring `_rescued_data`.** Upstream type changes become silent nulls.
- **A continuous cluster for data that arrives hourly.** The most expensive way to be idle.
- **Alerting only on query failure.** A stuck backlog never fails; it just falls behind.

## Production notes

The pattern that holds up: bronze via Auto Loader with `availableNow` on a schedule, silver via a
streaming table or a merge keyed on a deterministic event id, gold via materialised aggregation.
Keep checkpoints and schema locations in a dedicated path per environment, and document the replay
procedure — truncate target, new checkpoint, reprocess from bronze — before you need it.

Set `maxFilesPerTrigger` and the trigger interval together to target file sizes around 128–256 MB
in the sink. Small batches are the main source of the small-file problem, and compaction after the
fact is more expensive than ingesting at a sane cadence.
