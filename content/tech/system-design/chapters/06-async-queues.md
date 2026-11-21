# Asynchronous Processing, Queues and Delivery Claims

Asynchrony is how a system absorbs work it cannot do in the request. The decision to go async is
a decision to accept eventual completion, and with it a set of obligations: durable handoff,
retry, deduplication, ordering, and a way to see work that is stuck.

## Should this be asynchronous at all?

Make the call on three questions:

- **Does the caller need the result to respond?** Sending a welcome email does not. Charging a
  card does.
- **Can the work fail independently?** A thumbnail transcode can retry for an hour; a checkout
  cannot hold an HTTP connection for an hour.
- **Is the arrival rate spiky relative to the work rate?** 4,860 events/s at peak against 1,620/s
  average is a 3× burst that a queue absorbs and a synchronous service must provision for.

If the answer to all three is no, a queue adds a hop, a serialisation format and a failure mode for
nothing. Synchronous calls are easier to trace.

## Queue or log

| Property | Queue (SQS, RabbitMQ) | Log (Kafka, Kinesis) |
|---|---|---|
| Consumption | Message deleted after ack | Retained; each consumer tracks an offset |
| Readers | Competing consumers, one gets each message | Many independent consumer groups, each sees all |
| Replay | Not after deletion | Rewind an offset and reprocess |
| Ordering | Best-effort or per-group with limits | Strict within a partition |
| Retention | Minutes to days | Days to weeks, configurable |
| Best for | Task distribution, work queues | Event streams, fan-out, event sourcing, replay |

The choice follows from the access pattern. "Send this email once, retry until it works" is a
queue. "Every downstream team needs every event, and a new team will want to replay last week" is
a log.

## Delivery semantics, stated honestly

- **At-most-once**: ack before processing. Messages can be lost, never duplicated. Acceptable for
  metrics where a lost sample is noise.
- **At-least-once**: ack after processing. Nothing is lost; duplicates are possible whenever an
  ack is lost, a consumer crashes after processing but before committing, or a rebalance
  reassigns a partition mid-batch.
- **"Exactly-once"**: a delivery claim that is true only inside a boundary that can coordinate
  the commit. Kafka transactions can atomically write output records and commit consumer offsets
  for a read-process-write loop where the sink is also Kafka. They cannot make an HTTP call to a
  payment provider and a database insert atomic.

So end-to-end exactly-once, across arbitrary systems, is not achievable. What is achievable is
**exactly-once effects**: at-least-once delivery plus idempotent processing, so a duplicate has
no additional effect.

## Idempotency in the consumer

Every message needs a stable identity that survives retries. Generate it at the producer — a
UUIDv7 or a natural key such as `(order_id, event_type, version)` — and never at the consumer,
where a redelivery would produce a new id and defeat deduplication.

Then make the write idempotent, in one of three ways:

1. **Upsert on a natural key.** `INSERT … ON CONFLICT (event_id) DO NOTHING` — the second
   delivery is a no-op.
2. **Conditional update.** `UPDATE … WHERE version < :incoming_version` — replays of older
   versions are ignored, and out-of-order delivery is handled.
3. **A dedupe table with a window.** Record `(consumer, message_id)` and skip if present. At
   140 million messages/day and ~100 bytes per key, one day of keys is **14 GB** — fine in a
   table with a 48-hour TTL, not fine to keep forever.

```python
def handle_event(conn, event: dict) -> None:
    with conn.transaction():
        inserted = conn.execute(
            """
            INSERT INTO processed_events (event_id, consumer, processed_at)
            VALUES (%s, %s, now())
            ON CONFLICT (event_id, consumer) DO NOTHING
            RETURNING event_id
            """,
            (event["event_id"], "session-builder"),
        ).fetchone()
        if inserted is None:
            return                      # duplicate: the effect already happened
        apply_event(conn, event)        # same transaction as the dedupe row
```

The dedupe row and the effect must commit together. If they are separate transactions, a crash
between them either loses the effect or applies it twice — the exact problem the table was meant
to solve.

## The transactional outbox

The other half of the problem is producing reliably. A service that writes to its database and
then publishes to a broker has two systems and no atomic commit: publish can fail after the
commit (lost event) or succeed before a rollback (phantom event).

The outbox pattern removes the dual write. Write the event into an `outbox` table in the same
transaction as the business change, then have a relay publish rows and mark them sent:

```sql
CREATE TABLE outbox (
  id          BIGSERIAL PRIMARY KEY,
  aggregate   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX ON outbox (id) WHERE published_at IS NULL;
```

The relay publishes in id order and updates `published_at`. Duplicates are possible if the relay
crashes between publishing and marking — acceptable, because consumers are idempotent.

## Ordering, partitions and workers

Ordering is per key, not global. In a log, all events for `user_id=42` must land in the same
partition, which means the partition key is `user_id` and the ordering guarantee is exactly
"per user". A global order would require one partition and cap throughput at one consumer.

Sizing the consumer group from the numbers: 4,860 events/s at peak, and a Python worker that
sustains **200 events/s** per process for this payload (a realistic figure once JSON parsing,
validation and a database round trip are included):

```
workers = 4,860 ÷ 200 = 24.3 → 25 at peak, 9 at average
```

Run 25–30 and let the autoscaler follow **consumer lag**, not CPU. Lag is the backlog in
messages or seconds; CPU is a proxy that lies when the bottleneck is I/O or a downstream lock.

Partition count caps consumer parallelism: 24 partitions cannot be consumed by 30 workers, and
the extra six sit idle. Chapter 9 sizes partitions properly; the rule here is that partitions
must be at least the peak worker count you intend to run.

## Retries, poison messages and dead letters

Retries must be bounded, spaced and jittered:

```python
import random, time

def with_retry(fn, attempts=5, base=0.5, cap=30):
    for attempt in range(attempts):
        try:
            return fn()
        except RetryableError:
            if attempt == attempts - 1:
                raise
            delay = min(cap, base * 2 ** attempt)
            time.sleep(delay * random.uniform(0.5, 1.5))   # jitter avoids synchronised retries
```

Three rules that prevent most queue incidents:

- **Classify errors.** A malformed message will never succeed; retrying it five times wastes
  capacity and delays everything behind it. Send it to a dead-letter queue on the first
  non-retryable error.
- **Bound the retry budget.** Five attempts with exponential backoff is roughly 15 seconds of
  effort; beyond that, a human should look. Retrying for hours hides an outage.
- **Make the DLQ actionable.** A dead-letter queue nobody reads is a data-loss mechanism with
  extra steps. Alert on depth and on the age of the oldest message, and have a replay tool that
  takes a message id range.

Redelivery also happens without error: a visibility timeout shorter than the processing time hands
the same message to a second worker. Set it above the p99 processing time, and stay idempotent.

## Backpressure and load shedding

A queue does not create capacity; it defers the moment when demand exceeds it. If producers
sustain 4,860/s and consumers handle 4,000/s, the backlog grows by 860 messages/s — 74 million a
day — and the system is failing slowly rather than loudly.

Choose a policy: scale consumers, drop low-value events, sample, or shed load at the edge with a
429. Whatever the choice, alarm on **time since the oldest unprocessed message** rather than queue
depth alone; depth without arrival rate tells you nothing about when the backlog clears.

## Common mistakes

- **Acking before processing.** Turns at-least-once into at-most-once and loses work on crash.
- **Publishing to the broker before committing the database write.** The phantom-event half of
  the dual-write problem.
- **"Exactly-once" as a claim about a system that spans a database and a third-party API.**
- **Idempotency keys generated in the consumer.** The redelivery gets a new key and duplicates.
- **Unbounded retries with no DLQ.** One poison message blocks a partition forever.
- **Autoscaling on CPU.** Consumer lag is the signal that maps to user-visible delay.

## Production notes

Instrument four things per consumer group: lag in messages, lag in seconds, processing p99, and
DLQ depth. Keep the dedupe window longer than the maximum replay window — if you can replay seven
days and you dedupe for one, a replay duplicates six days of effects.
