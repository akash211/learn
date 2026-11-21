# Downsampling and Rollup Query Patterns

Downsampling reduces the number of points returned or retained by grouping raw observations into larger time buckets. It is essential for charting years of data without reading and returning every sample. A correct rollup preserves the statistics needed by downstream queries; a compact but mathematically lossy summary can create deceptively wrong dashboards.

## Start from the question

A chart showing a signal's average and range can often use a five-minute aggregate containing `count`, `sum`, `min`, and `max`. A query can then compute the weighted average across those buckets. A chart that needs the exact 95th percentile cannot derive it by averaging per-bucket percentiles. Keep a mergeable histogram or sketch if approximate percentiles are acceptable, or retain enough raw data to compute exact values over the required horizon.

```sql
SELECT time_bucket(INTERVAL '5 minutes', time) AS bucket,
       device_id,
       count(*) AS n,
       sum(temperature) AS temperature_sum,
       min(temperature) AS low,
       max(temperature) AS high
FROM sensor_readings
WHERE time >= $1 AND time < $2
GROUP BY bucket, device_id;
```

The mean is `sum(temperature_sum) / sum(n)` only if null values were counted consistently. SQL `count(*)` includes rows with null temperature; use `count(temperature)` if the denominator should include only measured values. Missingness is a statistical decision, not merely SQL syntax.

## Align buckets and ranges

Use `time_bucket` consistently across materialized and ad hoc queries so rollup boundaries match. A query for a partial interval at either edge can produce buckets that include observations outside the requested interval if the filter is applied after aggregation. Filter raw rows by the requested half-open range before grouping. If the product wants complete calendar buckets, expand the range to bucket boundaries explicitly and document that behavior.

For timezone-specific calendar reporting, choose a timezone-aware bucket definition supported by the extension version. A day in a local timezone can differ in elapsed duration during daylight-saving changes. Store timestamps as instants, group using the intended reporting timezone, and test transition dates. Avoid silently mixing UTC aggregates with local calendar labels.

## Hierarchical rollups

A typical storage design keeps raw data for a short interval, a five-minute or hourly continuous aggregate for medium history, and a daily rollup for long history. Higher levels can be built from lower-level aggregates only when stored measures are composable. Count and sum combine by addition. Minimum and maximum combine by min/max. Average requires sum and count. Variance requires an appropriate mergeable state; exact distinct count cannot generally be reconstructed from counts of distinct values in smaller buckets.

When defining each layer, specify the refresh horizon and data availability order. The lower aggregate must be complete for the range being rolled up. If raw retention removes data before the first aggregate refresh completes, the missing history is unrecoverable from the derived layer. A controlled backfill should populate coarse layers and validate counts before retention is enabled.

## Choosing output resolution

A chart with 1,000 horizontal pixels rarely needs one million returned rows. Select a bucket width based on both visible resolution and signal behavior, or use a multiresolution strategy that returns roughly a bounded number of points. Fixed widths such as 5 minutes or 1 hour are easy to cache and compare; adaptive widths can better match arbitrary ranges but complicate caching and semantics. Return the bucket start and the statistic's meaning, not just an unlabeled number.

Min/max envelopes preserve spikes better than averages alone. If a downsampled line uses only the mean, a short-lived high or low event may disappear. For monitoring, return min, max, last, and count where the consuming visualization benefits. `last` is not necessarily equivalent to the observation closest to the bucket end if ordering and null handling are ambiguous; use a supported ordered aggregate or explicit query pattern and verify the result.

## Continuous aggregates versus ad hoc aggregation

A continuous aggregate is useful when many clients repeatedly ask for the same grouping. Ad hoc `time_bucket` aggregation is simpler for occasional or variable-resolution queries. Materialization costs storage and refresh work, and it fixes a particular grain and set of dimensions. Do not create one view per dashboard without measuring overlap. Use query plans to see whether the materialized result is actually selected and whether recent raw data is also scanned.

## Common mistakes

- Averaging averages instead of weighting by observations.
- Counting rows when null measurements should be excluded.
- Averaging percentiles or distinct counts as though they were additive.
- Filtering only after aggregation and accidentally including out-of-range rows.
- Returning far more samples than the display or consumer can use.

## Production notes

Maintain a data dictionary for every rollup: bucket width, timezone, null semantics, statistics, and freshness target. Test summaries against raw source data for randomized intervals, including partial boundaries and missing values. Downsampling is an information-loss contract; choose the loss deliberately.

## Resolution selection and spike preservation

For monitoring data, an average alone is often a poor downsampling rule. Suppose a one-second spike occurs in a five-minute interval: the mean can nearly erase it. Returning minimum and maximum alongside an average gives a compact envelope that preserves evidence of excursions. For counters, use a difference or rate that accounts for resets and wraparound; summing counter samples is usually meaningless. For gauges, last-value, mean, and range answer different questions and should not be conflated.

Some visualizations use algorithms that select representative points rather than fixed bucket aggregates. Those can preserve shape for rendering but are not interchangeable with statistical summaries used in alerts or billing. Label the output accordingly and do not reuse a display-only decimation as an authoritative report. Choose rollups from the intended consumers, and keep raw data for the horizon needed to investigate anomalies or recompute derived metrics.

Before removing raw history, compare rollups against source rows over random time ranges and boundary cases. Include buckets partially overlapping a requested interval, missing data, nulls, late corrections, and daylight-saving transitions. A successful SQL execution is not evidence that the summary has the intended meaning; automated comparison tests should encode the aggregation contract.

## Query efficiency

Push selective predicates—device, tenant, and time bounds—into the source scan before grouping, and confirm chunk pruning in the plan. Avoid casting or wrapping the partition timestamp in a way that obscures the range. For long history, query the coarsest appropriate continuous aggregate and use raw data only for the recent tail. The application can stitch resolutions at a clear boundary, but it must avoid overlapping buckets or leaving a gap at that transition.

Cache keys should include the time range, resolution, timezone, filters, and aggregation version. Changing a rollup definition changes the meaning of cached output even if the query URL is unchanged. Versioning the contract makes gradual migrations safer and helps explain discrepancies when a dashboard result differs from a prior report.
