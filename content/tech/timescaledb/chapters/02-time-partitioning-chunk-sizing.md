# Time-Based Partitioning and Chunk Sizing

Chunk interval is a workload parameter, not a universal calendar choice. It determines how much data lives in each physical chunk and how many chunks are created over the retention horizon. Too-small chunks multiply indexes, relations, catalog work, planning, and policy scheduling. Too-large chunks keep more data and indexes active at once, weaken pruning granularity, and may make maintenance or compression less convenient.

## Pick a first interval from data volume

Start with write rate, average row width, index overhead, retention, and query windows. A rough model is:

`chunk bytes ≈ rows per second × seconds in interval × (heap bytes per row + index bytes per row)`

This estimate is approximate. TOAST, fillfactor, index fragmentation, tuple headers, WAL, and compression all affect physical size. Measure actual chunk relation sizes after a representative workload rather than trusting a row-width spreadsheet. A reasonable initial goal is chunks whose active indexes fit comfortably in memory, rather than a fixed number of days for every installation.

For example, if a stream writes 1,000 rows per second and a target chunk is roughly 5 GB including indexes, estimate the interval from measured bytes per row, then test adjacent interval choices. A few GB is a starting hypothesis, not a TimescaleDB requirement. A workload with dozens of indexes or wide JSON payloads will behave differently from narrow measurements with one composite index.

## Query windows and time boundaries

Chunk intervals should align with the windows users actually query and the granularity of retention. If most dashboards request the last six hours, hourly chunks can prune sharply but may create excessive relations at high volume. If operators retain years and usually query months, daily or weekly chunks may be a better compromise. A query spanning multiple chunks is normal; the cost is not simply the count of chunks because pruning and parallelism matter, but every additional relation adds overhead.

Use half-open ranges consistently:

```sql
SELECT time, device_id, temperature
FROM sensor_readings
WHERE time >= timestamptz '2026-06-01 00:00:00+00'
  AND time <  timestamptz '2026-06-02 00:00:00+00';
```

This avoids overlap at boundaries and makes chunk pruning straightforward. Avoid predicates such as `date(time) = DATE '2026-06-01'` when a direct range is available. It can prevent the planner or extension from using the partition constraint as effectively, and it makes timezone assumptions implicit.

## Active working set and memory

The hottest chunks and their indexes compete for PostgreSQL shared buffers and operating-system cache with the rest of the database. If a new chunk is larger than available cache, common queries can repeatedly touch cold index pages. Conversely, making every chunk tiny can produce a large number of btrees and additional metadata. Think in terms of the active working set: how many recent chunks are written concurrently, which indexes are touched, and how much memory is actually available after accounting for other databases, connections, and the operating system.

Chunk interval also affects maintenance boundaries. Compression or columnstore conversion generally works on older chunks after ingestion has slowed; large intervals delay the age at which an entire chunk becomes eligible. Retention policies remove chunks as units, so a very large interval can retain more data than the nominal retention cutoff until the boundary is crossed. The precise timing depends on policy scheduling and whether the cutoff is based on chunk range or row timestamps.

## Changing interval and space partitions

Newly created chunks use the current interval; changing chunk interval does not repartition existing chunks. That is useful for gradual tuning: adjust the interval, observe new chunk sizes, then decide whether old data requires migration. Repartitioning historical data is a substantial copy-and-rewrite operation with temporary disk, WAL, index rebuilds, and validation costs.

Space partitioning multiplies chunk count. With `S` space partitions and `T` time intervals, the rough upper bound is `S × T` chunks for a fully populated horizon. A sparse workload may create fewer, but design for the high-water mark. Add a space dimension only when it solves a concrete issue such as distributing writes across hot keys, and benchmark its effects on query fan-out. Hash partition counts are not free knobs: changing them can affect future layout and may not reorganize existing data.

## Measure and iterate

Observe chunk size distributions, number of chunks created per day, planning time, index cache behavior, write latency, and query plans. Use `EXPLAIN (ANALYZE, BUFFERS)` on representative queries; compare planned and actual chunk scans, not just elapsed time in a warm cache. TimescaleDB views and helpers for chunk sizes vary by release, so inspect the installed catalog views and extension documentation. PostgreSQL relation sizes can also be inspected via `pg_relation_size` and `pg_total_relation_size` on chunk relations.

Run load tests with realistic late data, uneven device rates, and backfills. A uniform synthetic generator hides skew: one high-rate tenant can create a much larger hot chunk and dominate index maintenance. Test the interval at peak ingest and during the largest expected query, and include policy jobs and vacuum in the test window.

## Common mistakes

- Selecting “one day” because it sounds natural, without estimating bytes and indexes.
- Setting intervals so small that thousands of chunks must be planned or maintained.
- Ignoring index bytes when estimating the active working set.
- Assuming an interval change rewrites old chunks.
- Forgetting retention and compression cadence when choosing boundaries.

## Production notes

Document the rationale for the interval and revisit it after data volume or query mix changes. Alert on unexpected chunk-count growth and skewed chunk sizes. A well-sized chunk is one that fits the workload's memory, query, and lifecycle constraints; it is not necessarily a particular number of hours or gigabytes.

## A concrete sizing loop

Use a repeatable loop rather than a one-time guess. First, load a representative interval and measure total heap and index bytes. Second, calculate how many chunks the retention horizon and any space partition count would create. Third, execute the most common short-range and long-range queries while ingestion continues. Fourth, review planning time, active index residency, and policy job duration. Then change the interval for future chunks and repeat. Keep the tested assumptions—row rate, index set, cache size, lateness—next to the chosen value so a later operator knows when to revisit it.

Remember that a chunk boundary is based on the time dimension, not on a fixed row count. Bursty traffic and seasonal peaks can make equally long intervals differ substantially in bytes. Track p50 and p95 chunk sizes, not only the average, and account for a large tenant or device that writes far above the fleet median. An outlier can exhaust space or create a hot index even though the average chunk looks healthy.
