# Capacity Estimation with Worked Arithmetic

Capacity estimation is not forecasting. It is the discipline of replacing adjectives with
multiplications you can defend, so that the architecture follows from the numbers instead of
from taste.

## The only conversions you need

| Quantity | Value | Use |
|---|---|---|
| Seconds per day | 86,400 | average QPS from daily volume |
| Seconds per month | ~2.6 million | monthly cost and quota maths |
| Days per year | 365 | retention and growth |
| 1 KB | 1,000 bytes | event sizing (decimal; be explicit if you mean KiB) |
| 1 TB | 1,000 GB | storage |
| Peak factor | 2–5× average | provision for peak, not mean |

Two habits make estimates trustworthy. First, **state the assumption next to the number** — "1 KB
per event, JSON with a 300-byte payload" — so a reviewer can challenge the input rather than the
conclusion. Second, **round aggressively and keep one significant figure in the conclusion**:
"about 1,600 events/s" is more honest than "1,620.37", because the input was never that precise.

## The running case

A product event stream: 3.5 million daily active users, 40 events each per day, 1 KB per event.

```
events/day   = 3,500,000 × 40            = 140,000,000
average QPS  = 140,000,000 ÷ 86,400       = 1,620 events/s
peak QPS     = 1,620 × 3                 = 4,860 events/s
ingest/day   = 140,000,000 × 1 KB        = 140 GB/day
avg bandwidth= 140 GB ÷ 86,400 s         = 1.62 MB/s  (~13 Mbps)
peak bandwidth = 1.62 MB/s × 3           = 4.9 MB/s   (~39 Mbps)
```

Three conclusions fall straight out of this. Ingest bandwidth is trivial; no network
engineering is required. 1,620 events/s is comfortable for a single well-tuned Postgres
instance, but 4,860/s at peak plus five-year retention is not, so the stream needs a log and a
columnar archive. And the daily event count is large enough that per-event overhead matters:
at 1 KB, a 100-byte increase in payload is a 10% storage increase.

## Storage: raw, compressed, and replicated

Raw JSON kept for a year:

```
140 GB/day × 365 = 51,100 GB = 51.1 TB/year
```

Columnar storage changes the number substantially. Parquet with zstd on JSON-shaped events
typically achieves 3–6×; assume **4×**, which is deliberately conservative:

```
51.1 TB ÷ 4 = 12.8 TB/year of curated Parquet
```

Now add the second source, a change-data-capture feed from the transactional database at
1.1 TB/day logical (uncompressed row images), compressing 6× in Parquet:

```
1,100 GB/day ÷ 6 = 183 GB/day → 183 × 365 = 66.8 TB/year
```

Total lake growth is therefore about **79.6 TB/year** (12.8 + 66.8). A measured lake size of
**300 TB** then implies roughly **3.8 years of retention** at current volume — which is a much
more useful statement than "the lake is big". It tells you the retention policy is the lever: cut
CDC retention from three years to eighteen months and you remove about 33 TB.

Sizing is not complete without replicas. If the object store keeps two copies across regions,
multiply by two; if the warehouse keeps a time-travel window of seven days on a 300 TB table,
budget another 5.8 TB of churn (300 × 7/365). Both belong in the estimate, not in a surprise
invoice.

## Retention and the log

A partitioned log holds recent data with replication. Seven days of the event stream, three
replicas:

```
140 GB/day × 7 days × 3 = 2,940 GB ≈ 2.9 TB
```

That is small next to the lake, which is the point: the log is a transport buffer, not storage.
Sizing it for thirty days "just in case" multiplies the broker disk and the recovery time for no
product benefit. Chapter 9 turns this into a partition count.

## Concurrency and latency

Little's Law relates throughput, latency and in-flight work: `concurrency = throughput × latency`.
At 4,860 events/s with a 150 ms server-side p95:

```
concurrency = 4,860 × 0.15 = 729 requests in flight
```

That number sizes the connection pool and the thread or task count. Add headroom for GC pauses
and slow queries: 1,000 in-flight is a sane pool ceiling. Without the calculation, teams
either set the pool to 20 (and queue) or to 5,000 (and melt the database).

## Caches, indexes and other multipliers

A product catalog of 2 million items at 12 KB each is 24 GB raw. Only a fraction is hot —
assume 20% serves 90% of reads — so the hot set is 4.8 GB. Redis stores objects with roughly
2–3× overhead for allocator fragmentation and key metadata, so budget ~14.4 GB and pick a
16 GB instance. A cache sized to the whole dataset pays for cold data it will evict unused.

The read path follows: 30,000 catalog reads/s with a 92% hit rate leaves 2,400 reads/s at the
database, which one primary plus a read replica handles comfortably.

## Backfills: throughput, not size

A **500 GB** Parquet table covering 180 days of sessions. First check the row size is plausible:
17.5 million sessions/day × 180 days = 3.15 billion rows; 500 GB ÷ 3.15 billion = **159 bytes per
session**, reasonable for a wide-but-sparse session row.

Then estimate duration from measured per-worker throughput, not from hope. If a worker sustains
**8 MB/s** of Parquet write and the job runs 8 workers:

```
aggregate = 8 × 8 MB/s = 64 MB/s
duration  = 500,000 MB ÷ 64 MB/s = 7,812 s ≈ 2.2 hours
```

Add 30% for skew and task startup: **2.8 hours**. That fits a four-hour window with margin, and
the estimate is falsifiable after the first partition — measure it, then extrapolate.

## Cost, as a first-class estimate

Object storage at roughly $0.023/GB-month for standard tier:

```
300,000 GB × $0.023 = $6,900/month
```

Move 60% of that to an infrequent-access tier at $0.0125/GB-month and the bill becomes
`120,000 × 0.023 + 180,000 × 0.0125 = $2,760 + $2,250 = $5,010/month`, a 27% reduction for data
nobody reads weekly. Compute, egress and per-request charges follow the same pattern: estimate
units × unit price, and write the unit price down.

## Assumption ledger

Every estimate should end with a table like this, because it is what a reviewer will attack:

| Assumption | Value | Sensitivity |
|---|---|---|
| Events per user per day | 40 | Doubling it doubles storage and QPS |
| Event size | 1 KB | Linear in storage and bandwidth |
| Peak factor | 3× | Sets provisioned capacity |
| Parquet compression | 4× | 3× adds 4.3 TB/year to the lake |
| CDC compression | 6× | Each 1× change moves the lake by ~13 TB/year |
| Retention | ~3.8 years implied | The main cost lever |

## Common mistakes

- **Averaging without peak.** Provisioning for 1,620/s when the evening peak is 4,860/s produces
  a system that is correct eleven hours a day.
- **Forgetting replication and derived copies.** The lake is not one copy, and the warehouse is
  not free.
- **Quoting a backfill duration with no per-worker throughput.** "About an hour" for 500 GB
  implies 139 MB/s sustained, which is a claim about hardware you have not named.
- **Mixing decimal and binary units.** 300 TB and 300 TiB differ by 10%; pick one and say so.
- **Estimating cost from compute alone.** Storage and egress routinely dominate analytical bills.

## Production notes

Keep the estimation script in the repository next to the design doc, with inputs at the top.
When traffic doubles, re-run it rather than re-arguing. The useful output is not the number — it
is the sentence "at this volume, the binding constraint changes from write throughput to
compaction", which tells you what to build next.
