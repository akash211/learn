# Cost Engineering: Credits, Suspension and Attribution

Snowflake's bill has three components and they behave differently: compute is credits per warehouse-second, storage is bytes per month including time travel and fail-safe, and serverless features bill credits outside any warehouse. Compute dominates almost everywhere, and compute is a function of two numbers you control — how large the warehouse is, and how long it runs.

## The unit of compute

A credit is consumed per hour at a rate set by warehouse size, and each size doubles the last:

| Size | Credits per hour | Relative scan throughput |
| --- | --- | --- |
| `XSMALL` | 1 | 1× |
| `SMALL` | 2 | ~2× |
| `MEDIUM` | 4 | ~4× |
| `LARGE` | 8 | ~8× |
| `XLARGE` | 16 | ~16× |
| `2XLARGE` | 32 | ~32× |

Billing is per second with a 60-second minimum each time a warehouse starts. So a `4XLARGE` running for ten minutes consumes about 21 credits, and an `XSMALL` woken for six seconds consumes one credit-minute's worth. The minimum matters more than it looks: a warehouse that suspends after 60 seconds of idle and is woken every few minutes by a polling dashboard pays the minimum repeatedly, and the total can exceed a medium warehouse left running.

Throughput does not scale linearly with size in practice. Doubling helps when the query is a parallel scan over many partitions; it barely helps when the bottleneck is a serial step, a skewed join, or a spill that is caused by the query shape. The economics are simple: doubling is worth it only if runtime more than halves.

## Auto-suspend is the main lever

```sql
ALTER WAREHOUSE wh_bi SET
  AUTO_SUSPEND = 300
  AUTO_RESUME = TRUE;
```

`AUTO_SUSPEND` measures idle time, not elapsed time: the countdown starts when the last query finishes, and a running query prevents suspension. Setting it to 60 seconds is aggressive — every lull costs a resume and an empty local disk cache. Setting it to 600 is conservative and usually cheaper for interactive warehouses used in bursts throughout the day. Setting it to `NULL` means the warehouse never suspends, which is occasionally correct for a 24/7 loader and almost never correct for anything else.

A warehouse that is running with no queries is the largest single source of avoidable spend in most accounts, and it is invisible on any dashboard that charts query duration.

## Resource monitors are brakes, not budgets

```sql
CREATE RESOURCE MONITOR mon_bi
  WITH CREDIT_QUOTA = 500
  TRIGGERS
    ON 90 PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND;

ALTER WAREHOUSE wh_bi SET RESOURCE_MONITOR = mon_bi;
```

A monitor applies to warehouses — one, or all of them at account level — and its quota resets each interval. `SUSPEND` waits for running queries to finish before suspending; `SUSPEND_IMMEDIATE` cancels them. The immediate variant is the one that stops a runaway, and the one that will page you at an inconvenient time.

Two limitations to design around. Monitors do not cover serverless features — Snowpipe, automatic clustering, search optimisation, materialized view maintenance — so a workload can exceed its apparent budget without touching a monitor. And a monitor on a shared warehouse suspends everyone's work, which makes it a blunt instrument for a multi-team warehouse. Per-warehouse monitors plus separate warehouses per team is the combination that actually localises the blast radius.

## Attribution

Cost without attribution becomes an argument. Three views do most of the work:

```sql
-- Warehouse-level spend, minute by minute
SELECT warehouse_name, start_time,
       credits_used_compute, credits_used_cloud_services
FROM snowflake.account_usage.warehouse_metering_history
WHERE start_time >= DATEADD(day, -7, CURRENT_TIMESTAMP())
ORDER BY credits_used_compute DESC;

-- Storage, split into active, time travel and fail-safe
SELECT table_catalog, table_schema, table_name,
       active_bytes, time_travel_bytes, failsafe_bytes
FROM snowflake.account_usage.table_storage_metrics
ORDER BY active_bytes DESC
LIMIT 20;
```

`WAREHOUSE_METERING_HISTORY` says which warehouse spent the credits but not which query. Joining `QUERY_HISTORY` to it gives an approximation — attribute warehouse-seconds proportionally to each query's execution time — and `QUERY_ATTRIBUTION_HISTORY`, where available, does the attribution directly, including serverless consumption.

After that, the reliable technique is **warehouse per workload**, because the warehouse name is the cost dimension that already exists. `WH_LOAD`, `WH_BI`, `WH_DS`, `WH_ADHOC` — four rows in a report, each owned by a team, each with its own monitor. Object tags add a second dimension for shared warehouses, but tags on tables do not attribute credits from a query that joined six of them; they attribute storage and governance.

## Where the money actually goes

In rough order of frequency, the patterns that dominate a bill:

1. **An always-on warehouse** for a workload that runs four hours a day.
2. **A dashboard refreshing every five minutes** with a query that changes text each time, so no result cache and a warehouse resume per refresh.
3. **Full scans on large tables** because a filter is wrapped in a function or a `VARIANT` path, so every run reads everything at `LARGE`.
4. **A warehouse sized for the worst query** all day, when only the nightly rollup needs it.
5. **Unbounded time travel** on tables that are rewritten nightly, so both active and time-travel storage grow without limit.
6. **Serverless features left on** — automatic clustering on a table whose key is wrong, search optimisation on a table nobody searches.

Each has a structural fix rather than a discipline fix: schedule the warehouse, materialise the dashboard's aggregate, fix the predicate, use a separate warehouse for the heavy job, reduce retention on rebuild-heavy tables, drop the unused service.

## Guardrails worth setting

```sql
ALTER WAREHOUSE wh_adhoc SET
  STATEMENT_TIMEOUT_IN_SECONDS = 1800
  STATEMENT_QUEUED_TIMEOUT_IN_SECONDS = 60;
```

`STATEMENT_TIMEOUT_IN_SECONDS` kills a query that would otherwise scan for an hour; `STATEMENT_QUEUED_TIMEOUT_IN_SECONDS` stops an ad-hoc user from occupying a queue indefinitely. Neither improves performance — they cap the tail, which is what a budget needs.

Also cap concurrency where it is accidental: a BI tool with a connection pool of 40 against one `SMALL` warehouse will queue, and the usual response is to resize rather than to fix the refresh schedule.

## Common mistakes

- Resizing down to save money without checking whether the query now spills to remote storage, which is slower and often costs more in wall-clock terms than it saves.
- Setting `AUTO_SUSPEND = 60` on a warehouse used in bursts and counting the savings while ignoring the resume minimum and cold cache.
- Reading `CREDITS_USED` from `WAREHOUSE_METERING_HISTORY` and assuming it is the whole bill; serverless consumption lives elsewhere.
- Attributing cost by schema when the warehouse is shared, which attributes nothing.
- Leaving `RESOURCE MONITOR` quotas unset because "we would notice". Nobody notices a 30% monthly increase.
- Treating a clone as free forever. It is free until it diverges, and a clone that receives a full nightly load diverges completely.

## Production notes

Review cost weekly at warehouse granularity and monthly at query-hash granularity, top twenty by credits. Alert on any warehouse whose running-hours exceed its query-hours by a factor you choose — that is idle spend, and it is always fixable. Set storage retention per table class rather than per account. And when a cost anomaly appears, look first at what changed in scheduling and refresh frequency; the query text usually did not change, the cadence did.
