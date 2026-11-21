# Ingestion Throughput and Upserts

Ingestion throughput is constrained by the whole PostgreSQL path: network and serialization, parsing, transactions, WAL, indexes, replication, checkpoints, and storage. A hypertable routes rows into chunks but cannot compensate for one-row commits, excessive secondary indexes, oversized payloads, or a downstream consumer that retries without idempotency. Design the ingestion contract and benchmark the complete system.

## Batch writes

For bulk loading, PostgreSQL `COPY` is usually more efficient than sending one `INSERT` per row. Use the driver’s binary or text COPY support where available, and stream in bounded batches rather than buffering an unbounded dataset in application memory. A transaction that is too small pays commit overhead repeatedly; one enormous transaction retains locks and snapshots, can create large rollback costs, and may delay maintenance. Choose batch and transaction sizes from observed throughput, latency, and recovery behavior.

```sql
COPY sensor_readings (time, device_id, temperature, humidity)
FROM STDIN WITH (FORMAT csv);
```

For event-by-event ingestion, multi-row `INSERT` statements reduce round trips. PostgreSQL prepared statements can reduce parse overhead, but plan caching and parameter typing should be tested on skewed data. Keep connection pools bounded; opening a connection per batch can cost more than the insert itself. If producers arrive in bursts, a broker such as Kafka can buffer and absorb backpressure, but the consumer must still use bounded batches and commit offsets only after durable database success.

## Transaction and WAL costs

Each committed transaction incurs WAL and synchronization work. Grouping independent rows into moderate batches can improve throughput substantially, while very large transactions increase crash recovery and replication lag. Index maintenance occurs for every inserted row and every chunk; only create indexes that serve a known query. Measuring raw insert speed with indexes dropped is not a realistic production benchmark if those indexes are required.

Monitor WAL generation, checkpoint activity, disk latency, replica lag, and transaction duration while load testing. Settings that change durability or WAL behavior are not safe generic throughput knobs. Preserve the failure guarantees your application requires, and change checkpoint or WAL settings only with PostgreSQL-specific operational expertise.

## Idempotency and conflict handling

At-least-once delivery means a consumer may retry after a timeout even if the database committed. Deduplication requires a stable event key and a unique constraint that is valid for the hypertable's partition dimensions. A common design includes `(device_id, time, sequence_no)` or a source event ID combined with the partition time. Then:

```sql
INSERT INTO sensor_readings (time, device_id, temperature, humidity)
VALUES ($1, $2, $3, $4)
ON CONFLICT (device_id, time) DO UPDATE
SET temperature = EXCLUDED.temperature,
    humidity = EXCLUDED.humidity;
```

This example is valid only if the conflict target matches a defined unique constraint and its partition key rules. Upsert is more expensive than append because it checks indexes, may lock existing rows, and writes a new tuple version for updates. For immutable event logs, rejecting duplicates or using `DO NOTHING` may be cheaper and clearer. For corrections, decide which source is authoritative and whether an older event can overwrite a newer measurement.

Retries should be bounded and classify errors. A serialization or deadlock failure may be retryable; a bad timestamp, invalid constraint, or missing chunk is not repaired by immediate infinite retry. Ensure batch-level idempotency and report partial success precisely. If a batch is all-or-nothing, a single malformed row can roll back the entire transaction; a staging table and validation step may be better for noisy sources.

## Late data and chunk creation

Event-time partitioning sends late rows to historical chunks. Those writes may touch cold storage, and chunks might already be compressed or eligible for retention. Define allowed lateness and route older corrections deliberately. Backfills should be paced to avoid overwhelming current ingest, and use `COPY` or staged tables when appropriate. Creating chunks on demand is convenient, but synchronized bursts across many new time/space partitions can create catalog and DDL pressure. Pre-creation strategies exist in some versions; use only after confirming current APIs and operational behavior.

## Instrumentation and benchmarking

Measure rows per second and p95/p99 end-to-end latency, not just database execution time. Record batch size, transaction duration, conflict rate, WAL rate, replica lag, CPU, I/O, and the ratio of retries to accepted rows. Benchmark with indexes, policies, compression jobs, and representative network conditions enabled. Include failure injection such as consumer restart, lost acknowledgement, and temporary database unavailability to verify offset and deduplication correctness.

## Common mistakes

- One transaction per row for a high-rate stream.
- One massive unbounded transaction for an entire historical import.
- Treating `ON CONFLICT` as free or assuming a non-partition-key conflict target works globally.
- Committing broker offsets before the database transaction is durable.
- Benchmarking an empty table without indexes or concurrent policy jobs.

## Production notes

Set explicit limits for batch size, retry count, and queue depth. Backpressure should be visible before the database runs out of connections or disk. Throughput targets are meaningful only alongside durability, duplicate semantics, and recovery objectives.

## Staging and data validation

A staging table is useful when input quality is uncertain or rows need normalization before insertion. Load quickly with `COPY` into staging, validate timestamps, required columns, units, and deduplication keys, then insert valid records into the hypertable in bounded transactions. Quarantine invalid rows with a reason code rather than discarding them silently. If staging is unlogged for speed, understand that its contents are lost after a crash and ensure the upstream source can replay them. Do not make staging the only durable copy of events.

Batching has a latency trade-off: larger batches improve throughput but increase the time before the first event becomes queryable. Tune batch flush interval and maximum rows together. Under load, flush on whichever limit occurs first, and expose queue depth so the system can apply backpressure. Include end-to-end event age in dashboards; a high rows-per-second metric can coexist with unacceptable freshness if buffered batches are delayed.

## Operational limits and observability

Track rejected rows separately from retryable database failures. A rising constraint violation rate can indicate a producer schema rollout or clock problem rather than insufficient database capacity. Preserve representative failed payloads with sensitive fields redacted so engineers can debug safely. Track accepted events by event time and ingestion time to detect clock skew and unexpected late arrival.

Set limits at each buffering layer. If a Kafka consumer can accumulate an unbounded local queue while the database is unavailable, recovery may exhaust memory before the database comes back. Bound queue depth and batch size, pause consumption when necessary, and ensure the broker retention period exceeds the expected outage and replay window. Once service resumes, ramp catch-up traffic instead of instantly overwhelming the database with the entire backlog.

For bulk backfills, coordinate with normal producers and policy jobs. Throttle by rows or WAL volume, observe replica lag, and pause when latency or free disk crosses a guardrail. A backfill that completes quickly on the primary but leaves replicas hours behind is not a successful ingestion plan.
