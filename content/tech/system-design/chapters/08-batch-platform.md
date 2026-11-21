# Designing a Batch Data Platform

This is the first full worked design. The brief: land **140 GB/day** of product events plus a
**1.1 TB/day** logical change-data-capture feed into a lake that already holds **300 TB**, keep
analysts within an hour of current data, and support a **500 GB Parquet backfill** without
breaking the morning reports.

## Requirements and constraints

| Requirement | Target |
|---|---|
| Freshness | Events queryable within 60 minutes of arrival; CDC within 2 hours |
| Volume | 140 GB/day raw events, 1.1 TB/day logical CDC |
| Lake size | 300 TB, growing ~80 TB/year |
| Consumers | 30 analysts, 12 dashboards, 6 scheduled models |
| Retention | 3 years queryable, 7 years in archive |
| Backfill window | 4 hours, no impact on live dashboards |
| Cost | Storage + compute under $8,000/month |

Constraints that shape the design: the source database is a production Postgres primary that must
not take analytical load; the team is three data engineers; object storage is the only storage
that scales to 300 TB at this budget.

## Architecture

```
Postgres --CDC--> object store (raw, immutable, JSON/Avro)  <- events from Kafka
                        |
                        v
              Spark: parse, dedupe, conform  ->  silver (Parquet, partitioned)
                        |                              |
                        |                              v
                        |                     gold marts (aggregated, 500 GB)
                        v                              |
              quarantine (bad records)                 v
                                              warehouse external tables -> BI
Airflow orchestrates; a catalog (Iceberg/Delta) tracks partitions and snapshots.
```

Four properties make this maintainable:

1. **Raw is immutable.** Every byte that arrives is kept for 30 days, unparsed, in the producer's
   format. If the parse is wrong, reprocess from raw rather than reconstructing from a lossy
   derived table. 140 GB/day × 30 = **4.2 TB** of landing zone, cheap at object-storage prices.
2. **Every layer is derived and rebuildable.** Bronze (raw), silver (conformed), gold (aggregated)
   can each be dropped and rebuilt from the one below.
3. **Writes are partition-scoped and idempotent.** A job replaces exactly one `event_date`
   partition. Re-running a day produces the same result.
4. **The warehouse reads, it does not store.** External tables over Parquet keep one copy of the
   data; copying 300 TB into a warehouse doubles cost for no benefit.

## File layout and the small-file problem

140 GB/day of JSON compresses roughly 4× to Parquet: **35 GB/day**. Partition by
`event_date` and, within a day, by `event_hour`:

```
s3://lake/silver/events/event_date=2026-11-21/event_hour=14/part-00003.parquet
```

Per hour that is `35 GB ÷ 24 = 1.46 GB`, and at a 512 MB target file size, about **3 files per
hour, 70 per day**. That is healthy: a query for one day touches 70 files, and per-file overhead is
negligible.

Now consider what happens without compaction. A streaming ingest writing every five minutes
produces 288 files/day; over a year, **105,000 files** for one table. Object-store LIST calls and
per-file overhead turn a 20-second query into a two-minute one. Compaction merges small files into
512 MB–1 GB files on a schedule, and it is not optional at this volume.

Partition granularity is a trade. Hourly partitions make backfills precise and pruning sharp, but
multiply file count by 24. Daily partitions are simpler and keep file sizes healthy when volume is
lower. Choose the coarsest partition that still lets a typical query prune to under ~10% of the
data: at 140 GB/day, daily is right, and hourly is only needed if most queries are intraday.

## The 300 TB lake

The lake is 300 TB because it holds ~3.8 years at the current growth rate:

```
events : 140 GB/day × 365 ÷ 4 (Parquet)  = 12.8 TB/year
CDC    : 1,100 GB/day ÷ 6 × 365          = 66.8 TB/year
total                                    = 79.6 TB/year
300 TB ÷ 79.6 TB/year                    ≈ 3.8 years
```

That arithmetic drives two policies. Retention: keep 3 years hot and tier the remaining 0.8 years
to infrequent access, which at 60% of bytes tiered reduces storage from `300,000 × $0.023 =
$6,900` to `120,000 × 0.023 + 180,000 × 0.0125 = $5,010` per month. Compaction and CDC volume:
CDC is 84% of growth, so a schema change that drops unused columns from the CDC projection saves
more than anything done to the event stream.

## The 500 GB backfill

The task: rebuild 180 days of a sessions table, 500 GB of Parquet, inside a four-hour window.

**Check the row size is plausible.** 17.5 million sessions/day × 180 days = **3.15 billion rows**;
`500 GB ÷ 3.15 billion = 159 bytes/row`. Reasonable for a wide session row with a few dozen
nullable columns.

**Estimate from measured throughput.** A worker sustains ~8 MB/s of Parquet write on this data:

```
8 workers × 8 MB/s = 64 MB/s aggregate
500,000 MB ÷ 64 MB/s = 7,812 s ≈ 2.2 hours
+30% for skew and task startup ≈ 2.8 hours
```

That fits the 02:00–06:00 window. A single giant job would have no resumability, no progress
visibility, and would fail at 90 minutes with no record of where it stopped.

**Make the unit of work a partition.** One task per day (180 tasks), each writing to a shadow
partition. Each task is retryable, bounded, and parallelisable to a controlled degree:

```python
def backfill_day(day: str, table: str) -> None:
    with spark_session() as spark:
        df = (spark.read.parquet(f"s3://lake/silver/events/event_date={day}")
                   .transform(build_sessions)
                   .withColumn("loaded_at", F.current_timestamp()))
        (df.writeTo(table)                         # Iceberg table
           .option("fanout-enabled", "true")
           .overwritePartitions())
        record_progress(day, rows=df.count(), status="done")
```

Iceberg's dynamic partition overwrite replaces only the partitions present in the write, so
re-running a day does not touch its neighbours. Without that, a retry of day 47 after day 48 has
landed either duplicates or deletes the wrong data.

**Manage the shared resource.** Run the backfill on a separate Spark cluster or a dedicated
warehouse sized for throughput. If it must share, cap it at 40% of workers and accept a longer
runtime. Measure the first three partitions, extrapolate, and publish the estimate before the job
reaches production tables.

**Validate before swapping.** Row count per day within 0.1% of source, uniqueness of `session_id`,
no nulls in required columns, and a checksum on a 1% sample. Then swap or insert, and reconcile
totals against the source.

## Orchestration

Airflow owns scheduling, retries and data intervals. Three rules keep a DAG operable:

- **Idempotent tasks.** A task re-run for the same interval must produce the same partition. Retries
  are automatic; correctness under retry is a design property.
- **The data interval is the unit.** `{{ ds }}` identifies the partition; never use "yesterday" or
  wall-clock time inside a task.
- **SLA and freshness alerts.** Alert when a partition is not complete by 06:00, and when the
  newest partition's `max(ingested_at)` is more than 90 minutes old. Freshness is a product
  promise, so it needs a monitor, not a dashboard nobody opens.

Backfills are a first-class CLI operation with a date range, a concurrency limit and a dry run,
not a hand-edited DAG.

## Data quality as a gate

Six checks catch most pipeline breaks, and they are cheap:

| Check | Example | Catches |
|---|---|---|
| Freshness | newest partition < 90 min old | stalled producer, broken schedule |
| Volume | rows within ±20% of 7-day median | partial load, duplicated load |
| Schema | expected columns and types | upstream change, parse regression |
| Uniqueness | `event_id` distinct | duplicate ingest, replay bug |
| Referential | `user_id` exists in dim_user | join drift, late dimensions |
| Distribution | null rate per column < 5% | silent parse failure |

Failures route records to a quarantine table with the reason, and the pipeline continues on the
good 99%. Halting the whole batch for 0.2% malformed events means no data for anyone; quarantining
means data for everyone plus a work item.

## Cost

```
storage (tiered)             $5,010/month
Spark 64 cores × 3 h/day     $576/month   (192 core-hours/day × $0.10)
warehouse 20 credits/day     $1,800/month ($3/credit)
total                        ≈ $7,400/month
```

Under the $8,000 target with 8% headroom. The largest line is storage, which is why tiering and
CDC projection matter more than cluster tuning.

## Common mistakes

- **No raw layer.** Every parse bug becomes an unrecoverable data loss.
- **Overwriting partitions non-atomically.** Readers see half a day of data; a failed job leaves a
  corrupt partition with no way to tell.
- **Small files forever.** The query gets slower every month and nobody knows why.
- **Backfilling into the live table.** Dashboards read partial results all morning.
- **No progress table.** The job fails at 90 minutes and restarts from zero.

## Production notes

Keep a control table of `(dataset, partition, status, rows, bytes, started_at, finished_at)` and
drive both the UI and the alerts from it. Snapshot the lake (Iceberg/Delta) so a bad write can be
rolled back in minutes rather than rebuilt in hours. And record the row-count-per-partition history
— it is the cheapest anomaly detector you will ever build.
