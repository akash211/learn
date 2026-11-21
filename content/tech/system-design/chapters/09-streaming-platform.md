# Designing a Streaming Data Platform

The batch platform answers questions hourly. Some questions cannot wait: fraud signals, live
dashboards, alerting, personalisation. This design turns the same **140 GB/day** event stream into
sub-five-second aggregates, with replay and exactly-once effects — and it starts by sizing the log.

## Requirements

| Requirement | Target |
|---|---|
| Throughput | 1,620 events/s average, 4,860/s peak |
| Latency | event visible in aggregates within 5 s (p95) |
| Ordering | strict per `user_id`, none globally |
| Replay | reprocess any of the last 7 days |
| Correctness | no lost events; duplicate effects impossible |
| Availability | 99.9% ingest; consumers may lag during recovery |

## Sizing the log

```
average bytes/s = 140 GB ÷ 86,400 s     = 1.62 MB/s
peak bytes/s    = 1.62 × 3              = 4.9 MB/s
retention       = 140 GB/day × 7 days × 3 replicas = 2.94 TB
```

Throughput is not the constraint — 4.9 MB/s is trivial for a modern broker. The partition count is
driven by **consumer parallelism** and ordering, not bytes. With 32 partitions:

```
peak per partition = 4.9 MB/s ÷ 32 = 0.15 MB/s
events per partition at peak = 4,860 ÷ 32 = 152/s
```

152 events/s per partition is far below what a Python consumer handles (~200/s per process with a
database round trip), so one consumer per partition suffices, and 32 gives room for a consumer
group of 24–32 with rebalance headroom. A common error is to size partitions for today's bytes and
discover that consumer parallelism — not bandwidth — is the wall.

Broker disk: 2.94 TB across 6 brokers is ~500 GB each, leaving room for a broker failure that
triggers reassignment. Three replicas with `min.insync.replicas=2` survives one broker loss
without losing acknowledged writes.

## Keys, ordering and hot partitions

Partition by `user_id`, because every stateful operation — sessions, per-user counters, feature
computation — needs one user's events in order on one consumer. Ordering is then guaranteed per
user and nowhere else, which is exactly the requirement.

The cost is hot partitions. If 1% of users generate 30% of events, and one automated client emits
5,000 events/s, that single key lands on one partition and saturates it while 31 sit idle. There is
no partition count that fixes a single hot key; the fixes are at the producer:

- **Split the key** for machine-generated traffic: `user_id:shard` with a random suffix, accepting
  that per-user order is lost for those events.
- **Rate-limit or batch at the edge** so one client cannot monopolise a partition.
- **Isolate** high-volume clients into a separate topic with its own consumer group.

Monitor per-partition byte rate, not just topic total. A 32× imbalance is invisible in the
aggregate and obvious per partition.

## Event time, watermarks and late data

Processing time is when the consumer saw the event; event time is when it happened. Mobile clients
buffer offline and upload hours later, so the two diverge, and any window computed on processing
time is wrong during a backlog.

Use event time with a watermark: "assume no event older than 10 minutes will arrive". Windows close
when the watermark passes their end. The trade is explicit:

| Allowed lateness | State retained | Late data |
|---|---|---|
| 0 | Smallest | Dropped or processed as new |
| 10 min | Moderate | Most mobile retries captured |
| 2 hours | Large | Captures offline batches; costly state |
| 24 hours | Very large | Better handled by a batch correction |

At 3.5 million active users, a one-minute tumbling window keyed by user needs one state entry per
active user per window. With 200 bytes of value plus ~100 bytes of key and index overhead,
`3.5M × 300 B ≈ 1.05 GB` of state — comfortable in RocksDB on the workers. A 24-hour window over
the same key space is not the same object; it accumulates per-event state and grows with traffic,
not users.

The practical pattern is a **lambda-ish split**: the stream computes a fast approximation for the
live dashboard, and the hourly batch job recomputes the same aggregate from the full dataset. The
serving layer reads the batch value for closed hours and the streaming value only for the current
hour. This is honest — the numbers converge — and far cheaper than holding a day of state for
perfect streaming correctness.

## Exactly-once effects

A streaming job reads an event, updates state, and writes an output. Three places can go wrong:
the source offset, the state, and the sink.

**Kafka to Kafka** can be genuinely transactional: `confluent-kafka` (and Spark) support
`send_offsets_to_transaction`, committing output records and consumer offsets atomically. A crash
either commits both or neither.

**Kafka to a lake** cannot use that transaction. The sink is an object store, so exactly-once is
constructed from idempotent commits:

1. Checkpoint offsets and state together every 10 seconds to durable storage.
2. Write output files with deterministic names derived from `(partition, checkpoint_id)`.
3. Commit the Iceberg/Delta snapshot only after the files are written and the checkpoint is durable.
4. On restart, replay from the checkpoint and overwrite the same files — same names, same content.

A non-deterministic function (a random UUID, `now()`) in the output breaks step 4: the replay
produces different bytes under the same name. Derive timestamps from the event, not the clock.

**Kafka to an external API** is at-least-once by construction. Make the call idempotent with a key
derived from the event, or accept duplicates and reconcile.

## Replay and backfill

Seven days of retention at 140 GB/day is **980 GB**. Replaying it at a conservative 50 MB/s
sustained:

```
980,000 MB ÷ 50 MB/s = 19,600 s ≈ 5.4 hours
```

That is the real cost of a replay, and it is why retention is a product decision rather than a
storage afterthought. Replays run on a separate consumer group with new output paths — never by
resetting the live group's offsets, which would make the live job reprocess and double-write.

## A Python consumer that survives rebalance

```python
from confluent_kafka import Consumer, KafkaError

consumer = Consumer({
    "bootstrap.servers": BROKERS,
    "group.id": "session-aggregator-v3",
    "enable.auto.commit": False,          # commit only after the sink write
    "auto.offset.reset": "earliest",
    "max.poll.interval.ms": 300_000,      # must exceed worst-case batch time
})

while True:
    batch = consumer.consume(num_messages=500, timeout=1.0)
    if not batch:
        continue
    events = [parse(m) for m in batch if not m.error()]
    write_idempotent(events)              # upsert by event_id, or transactional sink
    consumer.commit(asynchronous=False)   # after the write, never before
```

Three settings carry the correctness. Auto-commit off, because committing before the write loses
events on crash. `max.poll.interval.ms` above the worst-case batch time, because exceeding it
triggers a rebalance mid-batch and the same records are delivered to another consumer. And a
stable `group.id` versioned with the logic (`v3`), so a new deployment starts its own offsets
rather than silently inheriting an incompatible state format.

Rebalances are the most common source of duplicate bursts: partitions move, uncommitted work is
redelivered, and the new owner processes it again. With idempotent sinks this is a non-event; with
`INSERT` it is a duplicate incident.

## Monitoring

| Signal | Alarm |
|---|---|
| Consumer lag (messages) | > 500,000 for 10 min |
| Consumer lag (seconds) | > 300 s for 10 min |
| Watermark delay | > 15 min, meaning late data is not closing windows |
| Checkpoint duration | > 30 s, or 3× the 7-day median |
| Rebalance rate | > 2 per hour — a sign of slow processing |
| Sink commit failures | any, for 5 min |

Lag in **seconds** is the one users feel; lag in messages can look stable while the backlog ages.
Track both.

## Common mistakes

- **Partitioning by `event_id`.** Destroys per-user ordering and makes every stateful operation
  wrong under concurrency.
- **Processing-time windows.** Results change depending on when the job ran.
- **Committing offsets before the sink write.** At-most-once in disguise.
- **Unbounded state.** A window with no eviction grows until the job dies; every stateful operator
  needs a TTL or a watermark.
- **Resetting the live consumer group to backfill.** Double-writes and corrupt aggregates.
- **One partition for a hot key and hoping.** No consumer count fixes skew.

## Production notes

Version the consumer group with the state schema — an incompatible state format after a deploy is
a silent corruption. Snapshot the sink so a bad replay can be rolled back. And rehearse a broker
loss and a checkpoint restore in staging: the recovery path is part of the design, not an
operational detail.
