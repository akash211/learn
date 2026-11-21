# Continuous Aggregates and Refresh Policies

A continuous aggregate materializes a query result over a hypertable and incrementally refreshes affected time ranges. It is useful when dashboards repeatedly calculate the same buckets—counts, averages, minima, maxima, or sums—from a large raw table. Instead of scanning years of measurements on every request, the application queries a smaller summary relation. It is not a magical cache: freshness, invalidation, refresh cost, and aggregate semantics must be designed explicitly.

## Define a bucketed view

The canonical time grouping function is `time_bucket`, which aligns timestamps to a fixed interval. A continuous aggregate is declared as a materialized view using TimescaleDB's syntax:

```sql
CREATE MATERIALIZED VIEW device_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', time) AS bucket,
       device_id,
       avg(temperature) AS avg_temperature,
       min(temperature) AS min_temperature,
       max(temperature) AS max_temperature,
       count(*) AS samples
FROM sensor_readings
GROUP BY bucket, device_id
WITH NO DATA;
```

The exact supported query shapes, time bucket expressions, and aggregation functions depend on extension version. `WITH NO DATA` defers initial population so an operator can schedule or issue a bounded refresh. For large history, refreshing everything at creation can compete with production ingestion.

The grouping columns determine the grain. An hourly view by device can answer hourly device metrics and often be rolled up to daily summaries if the stored aggregates are mathematically composable. An average alone is not composable: averaging hourly averages gives incorrect results when bucket sample counts differ. Store `sum` and `count`, then compute `sum(sum) / sum(count)` for a weighted average. Similarly, percentiles and distinct counts need mergeable state or a suitable sketch; retaining only a final scalar can destroy information needed for later rollups.

## Refresh windows and policies

A refresh policy periodically recomputes a range behind the present, leaving the most recent interval for raw queries or a separate real-time path. The classic API is:

```sql
SELECT add_continuous_aggregate_policy('device_hourly',
  start_offset => INTERVAL '30 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes');
```

`start_offset` determines how far back the policy refreshes, and `end_offset` keeps the newest region outside that refresh range. Choose the start offset to cover expected late arrivals and corrections. Choose the end offset to account for ingestion delay and bucket closure. These offsets are not retention settings. Policy syntax and behavior vary by release; inspect the installed function signature and docs before deployment.

Refresh policies are jobs, not synchronous triggers on each insert. A job may run late, fail, or overlap with a backlog. Monitor last run, next run, duration, retries, and refresh failures through the background job views. A short schedule interval does not guarantee results are that fresh if each run cannot finish before the next one. Size the refreshed window and cadence from actual invalidation volume and available I/O.

Manual refresh uses `refresh_continuous_aggregate` with a bounded time range in supported versions. Initial backfills should be divided into manageable ranges. A refresh over a very large range can hold resources and generate significant I/O. Re-run after validating the range and whether the query includes or excludes the upper bound as expected; bucket boundary details matter.

## Invalidation and correctness

When source rows change, the extension tracks regions that may need refreshing. Inserts into recent time ranges are common; corrections to historical data can invalidate old buckets and produce expensive rework. A policy whose start offset is only a day cannot incorporate a correction from a month ago unless a separate manual refresh or wider policy covers it. Document the application's correction horizon and enforce it through data contracts or explicit repair jobs.

Timezone and calendar semantics deserve care. Fixed-duration buckets such as one hour are straightforward for UTC metrics, but local calendar days can have 23 or 25 hours at daylight-saving changes. Use an explicit timezone-aware bucket form supported by your version when product definitions require local days, and test transition dates. Keep bucket type and time zone consistent between ingestion, aggregates, APIs, and reports.

Continuous aggregate configuration can include real-time aggregation behavior, which combines materialized history with raw data newer than the materialization watermark. Defaults and settings have changed across releases. Check whether real-time aggregation is enabled for the view and understand its query plan. If disabled, consumers may see a freshness gap at the newest end; if enabled, recent raw scans can increase latency. This is a deliberate correctness/performance trade-off, not an automatic guarantee of immediate consistency.

## Rollup layers

A common arrangement is raw measurements, a five-minute aggregate, and a daily aggregate built from the first. Each layer has a different retention and refresh horizon. The higher-level view must aggregate valid state from the lower one. Store additive components such as counts and sums; for variance or percentiles use appropriate mergeable representations rather than averaging finalized values blindly.

Inspect the query plan and compare the continuous aggregate with a direct computation for sampled intervals. Include empty buckets and late-arrival corrections in tests. A view that is mathematically correct for ordinary buckets may still fail on null handling, daylight-saving boundaries, or weighted rollups.

## Common mistakes

- Averaging averages without weighting by sample count.
- Setting a refresh window shorter than the real late-data horizon.
- Assuming a policy runs immediately or succeeds every time.
- Enabling real-time aggregation without measuring the raw tail query.
- Refreshing all history in one huge operation.

## Production notes

Track freshness as data: compare the latest expected bucket with the latest materialized bucket and alert on lag. Keep a bounded repair procedure for historical corrections. Version-pin continuous aggregate definitions and test their behavior during extension upgrades, since supported query constructs and defaults can change.

## Access control and schema evolution

Treat the aggregate as a database object with an owner, privileges, and a lifecycle. Grant applications access to the view they need rather than broad rights to internal metadata. Review whether row-level security on the source is applied as expected to the materialized data; materialization can change the security boundary, and behavior is version-specific. Do not expose tenant aggregates without checking that the grouping and access control prevent cross-tenant leakage.

Changing the source schema or aggregate definition can require a view migration, refresh, or rebuild. A refresh policy does not automatically repair a broken definition. Plan changes using a shadow aggregate or a maintenance window when rebuilding large history. Compare the old and new aggregates over representative ranges before switching consumers, and retain the old view until validation finishes.

## Freshness checks

Define freshness in terms of the latest complete bucket, not simply the most recent job success timestamp. A job may succeed while excluding the newest hour by design. Compare expected and materialized bucket ranges, and include correction lag in the service-level objective. Consumers should know if a result is stale rather than silently treating it as current.
