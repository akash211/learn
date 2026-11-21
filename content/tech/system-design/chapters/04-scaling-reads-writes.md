# Scaling Reads and Writes

Scaling is not one decision. Reads and writes have different bottlenecks, and the cheapest
technique that removes the current bottleneck is almost always better than the most scalable one.
This chapter works through the order of operations, with the numbers that tell you when to move
to the next step.

## Measure the ratio first

The running product does 30,000 profile reads/s and 400 profile writes/s — a **75:1** read-to-write
ratio. A single Postgres primary with 16 cores handles roughly 5,000–8,000 simple indexed writes
per second before commit latency becomes the constraint, and perhaps 20,000–40,000 primary-key
reads per second if they hit cache. So:

- Writes: 400/s is 5–8% of one primary's capacity. There is no write problem.
- Reads: 30,000/s is at or beyond one primary's comfortable ceiling. The read path is the problem.

Optimising writes here would be effort spent on the wrong axis. This is the most common
interview mistake: reaching for sharding when the workload is read-heavy and a cache plus a
replica would do.

## Read scaling, in cost order

**1. Cache the hot set.** With 2 million catalog items at 12 KB and a 92% hit rate, origin traffic
falls from 30,000/s to 2,400/s. That single change removes the bottleneck for the price of a
16 GB Redis instance. Chapter 5 covers invalidation.

**2. Add read replicas.** Asynchronous streaming replication sends every write to N followers,
which serve reads. Four replicas at 8,000 reads/s each give 32,000/s of read capacity with
headroom. The cost is **replication lag**: a replica is typically 10–500 ms behind under normal
load and seconds behind during bulk loads.

Lag is a correctness issue, not just a freshness one. Read-your-writes breaks the moment a user
updates their profile and the next read hits a lagging replica. Three fixes, in order of
preference:

- **Session pinning**: after a write, route that user's reads to the primary for a short window
  (say 2 seconds), or until the replica's applied LSN passes the write's LSN.
- **Sticky routing by cookie**: cheap but wrong for shared devices and long sessions.
- **Synchronous commit to one replica**: removes the window, adds write latency and reduces
  availability if that replica fails.

```python
def read_conn(user_id: int, last_write_ts: float, now: float):
    """Route to the primary for 2s after a user's own write."""
    if now - last_write_ts < 2.0:
        return primary_pool
    return replica_pool
```

**3. Denormalise for the read shape.** A page assembled from nine tables costs nine round trips.
A materialised read model costs one lookup and is rebuilt asynchronously. This trades freshness
for latency, explicitly.

**4. Shard reads only as a last resort.** Sharding is expensive: cross-shard queries, rebalancing,
and a distributed transaction problem. It belongs after caching, replicas and read models.

## Write scaling

Writes scale along three axes: bigger hardware, less work per write, and more primaries.

**Vertical first.** A 32-core, 256 GB instance is usually cheaper than eight 4-core instances
plus the operational overhead, and it postpones sharding by years. When a single insert is
fsync-bound, faster disks and group commit help more than more nodes.

**Reduce work per write.** Every secondary index, trigger, foreign-key check and synchronous
replica adds cost. The 4,860 events/s append path should touch one table and one index; a
`SELECT` before every `INSERT` to "check existence" doubles the round trips for no correctness
gain if the key is unique.

**Batch.** 4,860 individual inserts/s is 4,860 network round trips. Batches of 500 rows cut that
to ten, and `COPY`/`execute_values` style bulk loads are an order of magnitude faster per row.
The trade is latency and blast radius: a failed batch is 500 rows to retry, which is why the
batch must be idempotent.

## Sharding: choosing the key

When one primary genuinely cannot hold the write volume or the data, partition the data across
independent primaries. The partition key decides everything that follows.

| Strategy | Strength | Weakness |
|---|---|---|
| Hash of key | Even distribution; simple routing | Range queries fan out; resharding moves ~50% of keys when doubling |
| Range (e.g. user_id 0–1M) | Efficient range scans; easy splits | Hot spots on sequential keys (new users all land last) |
| Directory / lookup table | Flexible placement, easy migration | The directory is a single point of failure and a latency hop |
| Geographic | Data residency; locality | Uneven population; cross-region queries |

For 300 million users at 1 KB each, 300 GB fits comfortably on one node and sharding would be
premature. For the event archive at 51 TB/year, sharding by `user_id` is natural because every
hot query is scoped to a user. With 64 shards: 300M ÷ 64 = **4.7 million users per shard**;
140 GB/day ÷ 64 = **2.2 GB/day per shard**. Both are comfortable.

Hash sharding distributes evenly but destroys locality. `hash(user_id) % 64` sends a user's
events to exactly one shard — good — while a query for "all events in Germany last week" now
touches all 64. That query belongs in the columnar archive, not the sharded store, and saying so
is part of the design.

```python
import hashlib

def shard_for(user_id: int, shards: int = 64) -> int:
    """Stable across processes and languages; do not use hash() (randomised per process)."""
    digest = hashlib.blake2b(str(user_id).encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") % shards
```

Python's built-in `hash()` is salted per process for strings, so two services would route the
same key to different shards. That bug is silent until a rebalance.

## Resharding without downtime

Doubling 16 shards to 32 moves about half the keys under modulo hashing. The migration:

1. Add the new shards and enable **dual writes** to old and new locations.
2. Backfill each new shard from its source shards, with a recorded high-water mark.
3. Verify row counts and checksums per key range.
4. Flip reads, keep dual writes for a cooling period, then stop writing to the old placement.

Consistent hashing with virtual nodes reduces movement to roughly `1/N` of keys when adding a
node, at the cost of a more complex routing layer. For 64 shards and a handful of moves a year,
explicit range mapping in a small config table is easier to reason about and to roll back.

## Hot keys and fan-out

A single celebrity with 50 million followers breaks any per-key partition. If a post fans out on
write, that is **50 million row inserts for one event** — at 5,000 writes/s, 10,000 seconds of
work for one post. No amount of sharding fixes a key that is itself the workload.

The standard fix is a hybrid: fan out on write for accounts below a threshold (say 100,000
followers), and merge on read for accounts above it. The reader queries their precomputed
timeline plus the recent posts of the few large accounts they follow, then merges by timestamp.
The threshold is chosen from the write budget: 100,000 followers × 1 post/minute = 1,667
writes/s, about a third of one primary.

Other hot-key mitigations: add a random suffix to the key and aggregate across `key-0…key-9`
on read; cache the hot key with a short TTL and request coalescing; or split the entity by time
(`celebrity:42:2026-11`) so writes spread across partitions.

## Common mistakes

- **Sharding before measuring.** If one primary is at 20% CPU, the problem is a query, not capacity.
- **A random or sequential shard key.** Random scatters a user's data; sequential creates a hot
  last shard for every new row.
- **Ignoring replication lag in the read path.** The bug appears only after a user edits their
  own data, which is exactly the flow QA tests least.
- **Cross-shard joins in the hot path.** Scatter-gather across 64 shards turns a 5 ms query into
  the slowest shard's latency, every time.
- **Rebalancing without a rollback.** Once reads move, going back requires the old placement to
  still be complete and current.

## Production notes

Alert on p99 per shard, not just the aggregate — a single hot shard hides inside a healthy
average. Track replication lag as a first-class SLI and gate read routing on it. And keep the
shard map in version control: it is configuration that determines where every row lives.
