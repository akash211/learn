# Micro-Partitions, Clustering and Pruning

Snowflake has no indexes. What it has instead is metadata describing the range of values in every column of every stored file, and an optimiser willing to discard files that cannot contain a match. This is partition pruning, and it is the single largest lever on query cost in the platform — larger than warehouse size, larger than most SQL rewrites.

## What a micro-partition is

When rows are inserted or loaded, Snowflake writes them into micro-partitions: immutable, columnar, compressed units of roughly 50–500 MB of uncompressed data. Rows within a partition are stored in the order they arrived. Columns are stored separately and compressed individually, so a query touching three of forty columns reads roughly three fortieths of the bytes.

Each partition carries metadata per column: minimum value, maximum value, count of distinct values, null count, and additional properties Snowflake uses for pruning and join optimisation but does not expose. There is no way to inspect partitions directly, no `EXPLAIN` node that shows a file list, and no `VACUUM`. The metadata is the index, and it is maintained by the service.

Because partitions are immutable, DML behaves differently from a heap table:

```sql
-- Marks rows in the affected partitions, writes new partitions with the new values.
UPDATE events SET status = 'void' WHERE event_date = '2026-03-01';

-- The old partitions stay readable via time travel until retention expires.
SELECT count(*) FROM events AT (OFFSET => -3600);
```

An `UPDATE` that touches one row in a 200 MB partition still rewrites that partition. A `DELETE` of 90% of a table leaves the old partitions in place, still counted in storage and still scanned until they age out of time travel. Both are reasons to prefer `DELETE` by partition-aligned predicates, or to rebuild the table with `CREATE OR REPLACE ... AS SELECT`.

## How pruning actually decides

The optimiser compares predicate constants against each partition's min/max for the filtered column. If `event_date` ranges from `2026-01-01` to `2026-01-31` in a partition and the query asks for `2026-03-15`, that partition is skipped without being read.

This only works when the predicate is expressed in terms the metadata can be compared against:

```sql
-- Prunes: literal compared to min/max
WHERE event_date = '2026-03-15'

-- Prunes: range
WHERE event_date BETWEEN '2026-03-01' AND '2026-03-31'

-- Does NOT prune: the function hides the column from the range comparison
WHERE date_trunc('day', event_ts) = '2026-03-15'
```

The last form is the classic mistake. It is also the correct fix to rewrite it as a half-open range:

```sql
WHERE event_ts >= '2026-03-15' AND event_ts < '2026-03-16'
```

The same failure appears with implicit casts — `WHERE customer_id = '12345'` on a numeric column, where the string is converted per row — and with predicates on `VARIANT` paths, where the path is resolved at execution rather than compared against typed metadata.

## Natural clustering

Rows are ordered by arrival, so a table loaded in time order is physically clustered on the load timestamp for free. An append-only events table loaded nightly is very well clustered on `event_date` without anyone declaring anything; filters on recent dates prune to a handful of partitions.

That natural order is destroyed by three things: out-of-order backfills, `UPDATE`/`DELETE` churn, and parallel loads of unsorted files. A backfill of two years of history inserted after the fact lands as partitions whose ranges overlap every existing partition, because each file was written in whatever order the load produced. The table now has excellent pruning on nothing.

## Clustering keys

A clustering key tells Snowflake to co-locate similar values so that pruning works on a column that is not the arrival order.

```sql
ALTER TABLE events CLUSTER BY (customer_id, event_date);

SELECT SYSTEM$CLUSTERING_INFORMATION('events', '(customer_id, event_date)');
```

The function returns, among other things, `average_overlaps` (how many partitions overlap on average) and `average_depth` — the average number of partitions that must be read to find one value. A depth of 1 is perfect: each value lives in exactly one partition. Depth in the tens means the key is doing little.

Choosing the key is the whole game:

| Key choice | Effect |
| --- | --- |
| `(event_date)` on a time-series table | Good: matches the dominant filter, bounded cardinality per day |
| `(customer_id, event_date)` | Good when queries filter by tenant first; order matters |
| `(id)` where `id` is unique | Useless: every partition has a narrow range, every range overlaps |
| `(is_active)` | Useless: two values, half the table in each partition |
| `(date_trunc('hour', ts))` | Allowed, but only helps if queries filter on the same expression |

A few rules survive contact with production. Cluster on the columns that appear in selective `WHERE` clauses of expensive queries, not on the primary key. Put the lowest-cardinality, most-filtered column first. Keep the key to two or three columns; Snowflake allows up to four, and each extra column multiplies the maintenance work for diminishing returns. And cluster only tables large enough to matter — a 20 GB table prunes acceptably by accident, and clustering it just adds credits.

## Automatic clustering and what it costs

Once a key exists, Snowflake can recluster in the background as DML degrades the layout. Automatic clustering is a serverless service: it consumes credits separately from any warehouse, and it decides for itself when to run. That means the cost is real but not visible in warehouse metering — it appears in `AUTOMATIC_CLUSTERING_HISTORY`, which is the first place to look when a table's cost does not match its query volume.

Two operational consequences. Clustering is not free, so a key on a table that is never queried with a selective predicate is pure waste. And automatic clustering cannot fix a key that is wrong — it will faithfully maintain clustering on a useless column. Check `average_depth` before and after; if it stays high, the key is the problem, not the maintenance.

## The pruning-to-cost relationship

Pruning reduces the bytes scanned, which reduces both runtime and credits. It is the only optimisation that improves cost and latency together without spending more compute. Resizing a warehouse spends more credits to reduce time; pruning reduces both.

This is why the useful diagnostic is a ratio rather than a duration. In the query profile, `Partitions scanned` against `Partitions total` tells you how much of the table the query actually needed. A scan of 40 out of 12,000 partitions is healthy. A scan of 12,000 out of 12,000 for a query filtering on one day is a layout problem, and no warehouse size will fix it.

## Common mistakes

- Clustering a table before confirming that pruning is the bottleneck. Read the profile first; if the query already scans 2% of partitions, clustering buys nothing.
- Clustering on a high-cardinality unique column because it "feels selective". Uniqueness defeats range pruning — it produces maximum overlap.
- Assuming `CLUSTER BY` changes existing data immediately. It changes future writes; existing rows are reorganised by automatic clustering, which takes time and credits.
- Wrapping filter columns in functions, then concluding that Snowflake "ignores indexes" — there are no indexes, and the function removed the metadata comparison.
- Rebuilding a large table with `INSERT OVERWRITE` and expecting clustering to be preserved. It is preserved only if the new data is written in key order, which a parallel insert does not guarantee.

## Production notes

Track clustering depth as a metric, not a one-off check: `SYSTEM$CLUSTERING_INFORMATION` per large table, weekly. Alert when `average_depth` crosses a threshold you chose from the baseline, and correlate it with load jobs that rewrite history. When a backfill is unavoidable, load into a staging table, sort it, and swap — `ALTER TABLE ... SWAP WITH` — rather than inserting into the clustered table, so the production table never carries overlapping partitions.
