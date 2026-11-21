# Caching: Result, Local Disk and Metadata

"It was fast the second time" is the most common performance observation in Snowflake, and it has three different causes depending on how the second run differed from the first. Snowflake has no single cache; it has three, at three layers, with different lifetimes and different costs.

## The three caches

| Cache | Where it lives | Lifetime | Survives suspend | Costs compute |
| --- | --- | --- | --- | --- |
| Result cache | Cloud services layer | 24 hours, invalidated by DML | Yes | No |
| Local disk cache | Warehouse nodes (SSD) | Until warehouse suspends | No | No (reads are free) |
| Metadata cache | Cloud services layer | Managed by Snowflake | Yes | No |

The distinction that matters operationally: the first two are what make the second execution fast, and only one of them is tied to a specific warehouse.

## The result cache

Every query result is retained for 24 hours in the cloud services layer. If the identical statement runs again and the underlying data is unchanged, Snowflake returns the stored result without starting a warehouse. Each successful reuse resets the 24-hour retention window, up to a maximum of 31 days from the original execution.

```sql
-- Both of these are served from the result cache the second time
SELECT region, sum(amount) FROM sales GROUP BY 1;
SELECT region, sum(amount) FROM sales GROUP BY 1;   -- identical text

-- This is a different query and misses
select region, sum(amount) from sales group by 1;   -- same semantics, different text
```

Matching is literal: the query text must be identical. A BI tool that injects a comment with the current timestamp, or changes whitespace or case, defeats the cache on every run. Session settings that affect the result must also match, and the executing role must have the required privileges (for `SHOW` queries, it must match the role that created the result).

Invalidation is blunt: any DML or DDL against any table referenced by the query clears its cache entry, even if the changed rows would not have affected the result. A table loaded every five minutes therefore has no useful result cache for queries over it. This is why "cache the aggregate in a table" often beats "hope the result cache holds".

Two further conditions matter. The query must not use functions Snowflake treats as non-deterministic, and the session settings that affect results — timezone, date output format — must match. Changing `TIMEZONE` between runs produces different output and so cannot reuse.

`RESULT_SCAN(LAST_QUERY_ID())` is a separate mechanism worth knowing: it lets a client page through or re-filter the result set of the previous query in the same session without re-executing it, which is how tools implement "export these results" cheaply.

## The local disk cache

When a warehouse reads a micro-partition, it keeps the columns it read on the local SSD of its nodes. The next query on the same warehouse that needs the same columns reads from SSD instead of object storage — a very large difference in latency, and the reason an ad-hoc exploration gets faster as you go.

This cache is per warehouse and does not survive suspension. `ALTER WAREHOUSE ... SET WAREHOUSE_SIZE` also starts new nodes, so a resize empties it. And a query routed to a different warehouse — because the driver specifies a different one, or because a multi-cluster warehouse started a second cluster — may find a cold cache.

The query profile reports the effect directly as `Percentage scanned from cache` on the scan operator. A repeat query showing 95% is reading SSD; the same query after a suspend shows 0% and takes several times longer while scanning the same partitions. That difference is I/O, not a change in the data or the plan.

Because the cache is keyed by the columns and partitions read, a *different* query can still benefit: two reports over the same table that both touch `region`, `amount` and `order_date` share the cached columns wherever their partition ranges overlap. This is why a dashboard often warms up for its whole workload after the first few charts load.

## The metadata cache

The optimiser's pruning decisions need per-partition min/max values. Those live in the metadata service and are cached in the cloud services layer, which is why planning a query against a table with hundreds of thousands of partitions takes milliseconds rather than a metadata scan.

You cannot influence this cache, but it explains two observations. Planning time stays flat as tables grow, and `EXPLAIN` is cheap even on enormous tables. It also explains why a table that has just been written has metadata available immediately: metadata is committed as part of the write, not computed lazily.

## Choosing the right explanation

When someone reports "it was fast yesterday", the diagnostic is a sequence of questions:

1. **Was it the same statement text?** If not, the result cache was never in play.
2. **Did the underlying table change in between?** A load, an `UPDATE`, even a `TRUNCATE` invalidates the result cache for every query over that table.
3. **Was it the same warehouse?** Different warehouse means a cold local disk cache.
4. **Was the warehouse suspended between runs?** Then the local disk cache is gone, and the first query afterwards is the cold one.
5. **Did it queue?** A cached-looking query that took 40 seconds probably spent 39 of them waiting.

`QUERY_HISTORY` distinguishes the cases: a result-cache hit shows zero bytes scanned, zero partitions scanned, and a duration measured in milliseconds, with no warehouse credited. A local-cache hit shows the same partition count as the cold run but a high cache percentage and much lower execution time.

## What caches do not do

They do not fix a query that reads the wrong partitions. A cold scan of 8,000 partitions is slow on the first run and fast on the second only because the second run reads the same 8,000 partitions from SSD. The work is still wrong; it is just cheaper to repeat.

They also do not help across warehouses, and this is a design consideration rather than a nuisance. Splitting a workload across many small warehouses to isolate teams also splits the cache, so each warehouse pays the cold-start cost. Consolidating a team's similar queries onto one warehouse is often a bigger win than resizing it.

## Common mistakes

- Benchmarking a change with the result cache on, so the "after" measurement never executes.
- Concluding that a query is optimised because it runs in 200 ms — it may be returning a cached result from before the data changed.
- Adding `USE_CACHED_RESULT = FALSE` to production sessions to "get fresh data". The cache is invalidated by DML; disabling it just makes everything slower.
- Expecting an auto-suspended warehouse to come back warm. It comes back in seconds with an empty SSD.
- Assuming a result cache entry belongs to a warehouse. It belongs to the account, which is why a suspended warehouse still answers cached queries instantly.

## Production notes

For benchmarking, wrap the session in `ALTER SESSION SET USE_CACHED_RESULT = FALSE;` and run against a warehouse dedicated to the test, then drop it. For dashboards, prefer a scheduled aggregate table over reliance on the result cache if the underlying table is loaded more often than the dashboard is viewed. And when a warehouse's suspend timeout is set very low — 60 seconds on an interactive warehouse — the team pays a resume penalty and a cold cache on every lull; 5 to 10 minutes is usually cheaper in total credits than constant restarts.
