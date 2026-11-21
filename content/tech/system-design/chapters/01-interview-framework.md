# A Repeatable Framework for Design Questions

A system design question is deliberately underspecified. "Design a ride-hailing service" has no
correct answer, so the interviewer is not grading the diagram — they are grading whether you
convert ambiguity into decisions, and whether the decisions survive a number.

The framework below fits in forty-five minutes, and the same seven steps produce a design doc.

| Step | Time | Output |
|---|---|---|
| 1. Requirements | 5 min | Functional list, non-functional targets with numbers |
| 2. Constraints | 3 min | Scale, budget, team, existing systems, latency budget |
| 3. Envelope | 4 min | QPS, storage growth, bandwidth, cost — rounded |
| 4. Contract and data model | 6 min | API, entities, keys, access patterns |
| 5. High-level design | 8 min | Components and the data flow between them |
| 6. Deep dive | 12 min | One or two components at implementation depth |
| 7. Failure and wrap | 7 min | What breaks, what is sacrificed, what to build first |

## Step 1: Requirements, both kinds

Split requirements into functional (what the system does) and non-functional (how well). Write
the functional list as user-visible verbs with a scope boundary: "post a message to a channel",
"read the last 50 messages", "receive new messages in under two seconds". Then explicitly park
what is out of scope: search, editing history, attachments. Parking scope is a decision, and
interviewers notice when a candidate silently shrinks the problem.

Non-functional requirements must carry numbers, because every later choice depends on them:

- **Scale**: 3.5 million daily active users, 40 events per user per day.
- **Latency**: p95 read under 150 ms server-side; message delivery p99 under 2 s.
- **Availability**: 99.9% for reads (43 minutes of downtime per month), 99.95% for writes.
- **Durability**: no acknowledged write is lost, even across a single data-centre failure.
- **Consistency**: a user always sees their own write; other users may see it within one second.
- **Retention**: messages readable for five years; deleted messages gone within 30 days.
- **Cost**: under $0.40 per active user per month, infrastructure only.

That consistency line is the single most valuable sentence in the requirements, because it
turns a philosophical debate into an engineering constraint: read-your-writes for the author,
bounded staleness for everyone else. It permits asynchronous replication with a session pin.

## Step 2: Constraints you did not choose

State the constraints that remove options before you design:

- The company already runs PostgreSQL and Kafka, and has no Cassandra experience. A design that
  requires an unfamiliar operational skill is a risk, not a neutral choice.
- The team is four engineers. A design with nine services and a service mesh will not be operated well.
- Traffic is 8× peak at a predictable hour; the system can be provisioned for peak, not averaged.
- Data residency requires EU user data to stay in the EU, which forces a regional split.
- Mobile clients are on poor networks; payload size is a latency lever.

Naming constraints early prevents the classic failure of proposing a technically superior design
that the organisation cannot run.

## Step 3: The envelope, before the boxes

Do the arithmetic out loud. For the messaging example:

- 140 million events/day ÷ 86,400 s = **1,620 events/s** average.
- Peak is 3× average → **4,860 events/s**.
- 1 KB per event → **140 GB/day** ingested, 1.62 MB/s average, ~39 Mbps at peak.
- Five years raw is 140 GB × 365 × 5 = **255 TB** before compression.

Rounded numbers are fine and expected: 86,400 seconds per day, 2.5 million seconds per month,
30 days per month, 1 KB = 1,000 bytes. What matters is that the units are named and the
multiplications are visible. Chapter 2 does this in full, including the storage, cache and cost
consequences.

The envelope decides architecture. 1,620 events/s fits comfortably on one well-tuned Postgres
instance; 4,860/s at peak with five-year retention does not. That single comparison is the
argument for a log plus a columnar store, and it took ninety seconds.

## Step 4: Contract and data model

Write the API before the diagram. Three or four endpoints, with the fields that matter:

```python
from dataclasses import dataclass
from datetime import datetime

@dataclass(frozen=True)
class Message:
    message_id: str      # client-generated UUIDv7: sortable, idempotent
    channel_id: str
    author_id: str
    body: str
    created_at: datetime

# POST /channels/{channel_id}/messages
#   Idempotency-Key: <uuid>        -> same key returns the original message
# GET  /channels/{channel_id}/messages?before=<cursor>&limit=50
#   -> {"messages": [...], "next_cursor": "..."}
```

Cursor pagination, not offset: offset makes the database walk and discard rows, and it skips or
repeats items when new messages arrive. A cursor on `(created_at, message_id)` is stable and
index-friendly.

Then the entities and their keys. Which identifier is the partition key? Which access pattern
is hottest? A message table keyed `(channel_id, created_at DESC, message_id)` serves the read
path; a table keyed `(author_id, created_at)` would serve a profile feed nobody asked for.
Chapter 3 generalises this into a selection method.

## Step 5: High-level design

Draw only the components the requirements justify, and label each arrow with what flows on it
and how often. For messaging: an API tier behind a load balancer, Postgres for channel
metadata and recent messages, a partitioned log for fan-out and retention, object storage for
the archive, a cache for hot channels, and a fan-out worker group.

Say why each component exists. "Cache" is not a justification; "channel metadata is read 200×
more often than written and is 2 KB, so it is cached with a 60-second TTL and invalidated on
write" is.

## Step 6: Deep dive where the risk is

Pick the component most likely to fail or most likely to be asked about, and go to
implementation depth: keys, indexes, failure modes, and a code sketch. For messaging that is
fan-out and delivery, not the load balancer.

Use the deep dive to show trade-off reasoning rather than recall. "Fan-out on write costs one
row per recipient, so a channel with 50,000 members costs 50,000 writes per message; fan-out on
read costs one query per reader but makes history assembly the hot path. We fan out on write
below 1,000 members and on read above it, with a per-channel flag."

## Step 7: Failure, operations, and what you would build first

Close the design by naming what happens when each dependency degrades:

- Cache down → reads hit Postgres with a concurrency limit, latency rises, correctness holds.
- Log unavailable → writes queue in the API's local buffer for 30 seconds, then fail fast with a retryable error.
- Replica lag > 5 s → the author's session is pinned to the primary for reads.
- Region loss → RPO 5 minutes (asynchronous replication), RTO 30 minutes (promoted replica).

Then sequence the build: the smallest version that satisfies the functional list, the first
scaling step, and the signal that would trigger the next one.

## Common mistakes

- **Designing components before requirements.** You cannot choose between a queue and a
  synchronous call until you know whether the caller needs the result.
- **Numbers without units, or units without sources.** "A lot of storage" and "we need 300 TB"
  are equally useless if the assumption behind them is invisible.
- **Ignoring the read/write ratio.** Most systems are read-heavy; a design that optimises writes
  for a 100:1 read workload is aimed at the wrong bottleneck.
- **Treating "exactly-once" as a checkbox.** Delivery is at-least-once; exactly-once effects come
  from idempotent handling (Chapter 6).
- **No failure story.** A design with no degraded mode is a design that has not been thought through.

## Production notes

The same seven steps work for a design document, with two changes: the envelope becomes a
spreadsheet someone can re-run, and the failure section becomes a table of alerts and runbooks.
Keep the document to two pages plus appendices; a design nobody reads has no reviewers.

Interviewers consistently reward the candidate who writes down an assumption and checks it
against a number. They discount the candidate who names the most technologies.
