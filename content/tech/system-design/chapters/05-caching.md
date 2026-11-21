# Caching Strategies and Invalidation

A cache is a copy of data that is allowed to be wrong. Every design decision follows from how
wrong, for how long, and what happens when the copy is missing. Teams that add a cache without
answering those three questions get a system that is faster in the demo and inconsistent in
production.

## When a cache is the right tool

Four conditions should hold together:

1. **The read ratio is high.** 30,000 reads/s against 400 writes/s means each cached value is
   read many times before it changes.
2. **The hot set fits.** The catalog is 2 million items at 12 KB — 24 GB raw — but 20% of items
   serve 90% of reads, so the hot set is 4.8 GB. With 2–3× allocator and metadata overhead,
   budget 14.4 GB and choose 16 GB of memory.
3. **Staleness is tolerable and bounded.** A 60-second TTL on a product description is fine; a
   60-second TTL on an account balance is a bug.
4. **The origin can survive a miss.** If every request misses at once, the database must not fall
   over — which is a capacity statement, not an aspiration.

If the hit rate would be low, or the data changes on every read, the cache adds a hop, a failure
mode and an invalidation problem for nothing. Measure the hit rate before celebrating the cache:
a 40% hit rate on a 20 ms origin saves 8 ms of average latency and doubles the number of moving
parts.

## The patterns

| Pattern | How it works | Use when | Cost |
|---|---|---|---|
| Cache-aside | App reads cache; on miss reads origin and populates | Default for most read paths | App owns invalidation; first reader pays latency |
| Read-through | Cache library loads from origin on miss | You want the logic in one place | Less control over what gets cached |
| Write-through | Write to cache and origin synchronously | Reads must see the new value immediately | Higher write latency; cache holds writes it may never serve |
| Write-behind | Write to cache, flush to origin asynchronously | Very high write rates, loss tolerable | Data loss on cache failure |
| Refresh-ahead | Refresh hot keys before expiry | Latency-sensitive, predictable access | Wasted refreshes for keys that cool down |

Cache-aside dominates because it fails gracefully: if Redis is down, the application reads the
origin. Write-behind is the one to treat with suspicion — it turns the cache into a system of
record, and caches are evicted under memory pressure by design.

## Invalidation, in order of reliability

**TTL.** The simplest bound: a value is at most T seconds stale. Choose TTL from the product's
tolerance, not from a round number. A 60-second TTL on 4.8 GB of hot data at 30,000 reads/s
means each hot key is read hundreds of times per TTL, which is why the hit rate stays high.

**Delete on write, after commit.** The write path updates the database, commits, then deletes the
key. Delete *after* the commit, not before, and not inside the transaction — otherwise a
concurrent reader can repopulate the cache from the pre-commit state and leave a stale value with
a fresh TTL.

The classic race is real:

```
Reader: miss -> read DB (old value) ---------------------> write cache (old)
Writer:              update DB -> commit -> delete cache
```

The cache now holds the old value until the TTL expires. The practical mitigations are a short
TTL (bounding the damage), delayed double-delete (delete, wait ~500 ms, delete again), or
versioned keys (below).

**Versioned keys.** Include a version in the key — `product:42:v17` — and bump the version on
write. Readers holding the old key get a miss and reload; no delete is needed and no race can
leave a stale value under a current key. The cost is orphaned old keys, which TTL cleans up:

```python
def get_product(conn, product_id: int) -> dict:
    version = conn.get(f"product:{product_id}:ver") or "1"
    key = f"product:{product_id}:v{version}"
    cached = redis.get(key)
    if cached:
        return json.loads(cached)
    row = load_from_db(product_id)
    redis.set(key, json.dumps(row), ex=300)
    return row
```

**Change-data-capture invalidation.** When many services write the same table, application-level
deletes are unreliable — one writer will forget. Consume the database's change log and delete or
refresh keys from a single consumer. This is eventually consistent by the CDC lag (typically
under a second), which is usually better than the minutes a missed delete would cost.

## Stampede, penetration and avalanche

Three failure modes account for most cache incidents.

**Stampede (thundering herd).** A hot key expires and 5,000 concurrent requests all miss and hit
the origin at once. With a 30,000/s read rate and a single hot key, that is a self-inflicted
outage. Fixes:

- **Single-flight**: one loader per key, others wait on its result. A per-key lock in the
  application is enough for a single process; Redis `SET NX` coordinates across processes.
- **Probabilistic early refresh**: refresh before expiry with a probability that rises as the
  deadline approaches — `ttl = -beta * delta * ln(random())`, where `delta` is the recompute time.
- **Serve stale on error**: keep a stale copy with a shorter secondary TTL and return it if the
  origin fails, while logging the staleness.

```python
import math, random, threading

_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()

def single_flight(key: str, loader, ttl: int = 300):
    value = redis.get(key)
    if value is not None:
        return json.loads(value)
    with _guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        value = redis.get(key)          # double-check: another thread may have filled it
        if value is not None:
            return json.loads(value)
        fresh = loader()
        # jitter the TTL by ±10% so keys written together do not expire together
        redis.set(key, json.dumps(fresh), ex=int(ttl * random.uniform(0.9, 1.1)))
        return fresh
```

**Penetration.** Requests for keys that do not exist bypass the cache every time — a scraper
enumerating `product:999999999` turns a cache into a database load generator. Cache the negative
result for a short TTL (30–60 s), and for very high-cardinality keys put a Bloom filter in front.
One million negative entries at ~100 bytes is 100 MB, cheap insurance.

**Avalanche.** Many keys expire simultaneously — often because they were all written at the same
moment after a deploy or a bulk load. Jitter every TTL by ±10%, and warm the cache before
shifting traffic to a new instance.

## Cache coherence with replicas

A cache in front of a lagging replica inherits the replica's staleness: user updates a profile,
the cache is deleted, the next read misses, hits a replica that has not applied the write, and
caches the old value for the full TTL. The TTL no longer bounds staleness at 60 seconds — it
bounds it at replication lag plus 60 seconds, and if the replica is five minutes behind, that is
five minutes.

Options: read-through to the primary on miss for keys the user just wrote (session pinning from
Chapter 4), version keys derived from the write's LSN, or accept the staleness and document it
as part of the consistency contract.

## What not to cache

- **Authorisation decisions**, unless the invalidation is tied to the permission change event.
  A revoked user with a cached "allowed" is a security incident.
- **Money.** Balances, totals and eligibility for payouts need a consistency story stronger than
  a TTL.
- **Anything you cannot name an invalidation trigger for.** If the answer to "how does this key
  get updated?" is a shrug, the cache is a bug with a latency benefit.

## Common mistakes

- **Caching before measuring.** A cache on a path with a 30% hit rate adds a dependency and saves
  little.
- **Deleting the cache before the transaction commits.** The classic stale-forever-until-TTL bug.
- **A single TTL for everything.** Hot and cold data have different change rates; use two classes.
- **No jitter.** Synchronised expiry turns a deploy into a stampede.
- **Treating Redis as durable.** Persistence is best-effort; eviction is by design. Never make it
  the only copy.

## Production notes

Track hit rate, p99 latency and evictions per instance, and alert on a hit-rate drop — it usually
precedes an origin overload by minutes. Keep cache keys versioned by schema so a deploy that
changes the value shape does not serve old JSON to new code. And load-test the origin with the
cache disabled: that is the capacity you actually have when Redis fails.
