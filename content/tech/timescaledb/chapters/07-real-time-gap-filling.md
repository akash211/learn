# Real-Time Aggregation and Gap Filling

Time-series charts often need regular buckets even when no event arrived during part of the interval. SQL `GROUP BY` normally emits only buckets containing rows. TimescaleDB provides `time_bucket` and gap-filling functions to align observations, fill missing buckets, and optionally carry values forward or interpolate. Correctness depends on distinguishing a genuinely missing observation from zero, null, and an estimate.

## Bucketing timestamps

`time_bucket(INTERVAL '5 minutes', time)` assigns each timestamp to a five-minute boundary. The result can be grouped with dimensions such as device:

```sql
SELECT time_bucket(INTERVAL '5 minutes', time) AS bucket,
       device_id,
       avg(temperature) AS mean_temperature
FROM sensor_readings
WHERE device_id = 42
  AND time >= $1 AND time < $2
GROUP BY bucket, device_id
ORDER BY bucket;
```

Use a half-open time range and ensure the query's bucket alignment matches the dashboard. `time_bucket` has overloads and timezone-related behavior that can vary by version; for local calendar buckets, explicitly specify the intended timezone using a supported signature. Daylight-saving transitions make a local day or hour different from a fixed UTC duration. Product requirements should state whether the bucket is elapsed time or wall-clock calendar time.

## Gap filling

The TimescaleDB `time_bucket_gapfill` function generates missing time buckets in supported query contexts. It can take `start` and `finish` bounds to constrain the output:

```sql
SELECT time_bucket_gapfill(INTERVAL '5 minutes', time,
                           start => $1, finish => $2) AS bucket,
       device_id,
       avg(temperature) AS mean_temperature
FROM sensor_readings
WHERE device_id = 42
  AND time >= $1 AND time < $2
GROUP BY bucket, device_id
ORDER BY bucket;
```

The gapfill function is not a generic table function and has restrictions around query structure, grouping, and supported types. Use explicit bounds rather than expecting the server to infer the full desired range from sparse rows. Test the start and finish boundary, especially when the requested end falls midway through a bucket. Newer APIs may differ; check the installed extension version.

A generated empty bucket typically has a null aggregate. That is often the most honest representation: no sample means no measurement. Converting null to zero with `COALESCE` is appropriate only when zero is semantically equivalent to no event, as in some event counters. A zero temperature or zero revenue is a value, not necessarily a missing-data marker.

## LOCF and interpolation

`locf` (last observation carried forward) fills a gap with the last known non-null value. It can be used as an expression over the bucketed aggregate in the gapfill query:

```sql
SELECT time_bucket_gapfill(INTERVAL '5 minutes', time,
                           start => $1, finish => $2) AS bucket,
       locf(avg(temperature)) AS carried_temperature
FROM sensor_readings
WHERE device_id = 42
  AND time >= $1 AND time < $2
GROUP BY bucket
ORDER BY bucket;
```

LOCF is a domain assumption: it says the previous value remains valid until superseded. It may be suitable for a slowly changing gauge, but not for a rapidly fluctuating sensor or a cumulative counter that resets. Options such as treating nulls as values and providing a seed value are version-specific; inspect `locf` signature and behavior. The first gap may have no prior observation inside the requested range, so a seed or a query that fetches a preceding sample may be necessary.

`interpolate` fills missing values by estimating between known values. It is appropriate only when interpolation makes sense for the measured quantity and sampling process. Linear interpolation across a long outage can fabricate a smooth trend where the system actually had no data. Bound the maximum gap or expose whether a point is observed versus estimated. Function overloads, type support, and previous/next lookup arguments differ across releases; verify supported syntax.

## Real-time continuous aggregates

A continuous aggregate may materialize historical buckets and, when real-time aggregation is enabled, combine those results with raw data newer than the materialization watermark. This avoids waiting for the next refresh policy for the newest data, but it adds work to query the raw tail and does not mean every recent row is guaranteed visible in every release/configuration. Defaults changed over time. Inspect the view's real-time setting and query plan, and decide whether lower freshness latency justifies the extra query cost.

Gap filling over aggregates also needs a clear coverage range. A materialized view may have no row for a missing bucket, and a refresh cannot invent measurements. Gapfill can create the bucket at query time; LOCF and interpolation can then transform the null only according to their semantics. Ensure the continuous aggregate has covered the requested historical window and the raw tail begins at the expected boundary, or the combined result can contain gaps or duplicates.

## Performance and validation

Gapfill expands output proportional to the number of requested buckets times grouping cardinality. A one-minute grid across a year for thousands of devices can be enormous even when the source is sparse. Filter dimensions tightly, limit requested time ranges, and aggregate at a coarser grain when the UI does not need every point. Compare row counts and latency with an explicit calendar table or application-side fill for unusual use cases.

Validate with synthetic series containing an initial gap, middle gap, final gap, null measurements, late arrivals, and daylight-saving boundaries. Check whether the result is observed, carried, or interpolated and label it accordingly in downstream APIs.

## Common mistakes

- Treating missing samples as zero without domain justification.
- Applying LOCF to values that do not remain stable between samples.
- Assuming interpolation represents measured reality.
- Omitting explicit time bounds and generating huge bucket ranges.
- Believing a real-time aggregate removes all refresh and freshness concerns.

## Production notes

Return a quality indicator or provenance flag if downstream users might confuse estimates with observations. Document bucket timezone and interval in API contracts. Time buckets are part of data semantics, not merely presentation formatting.

## API and chart semantics

A chart endpoint should communicate its resolution and data quality. Consider returning `bucket_start`, `bucket_end`, the statistic, and a status such as observed, carried, interpolated, or empty. If the API returns only a number, downstream consumers can mistake an estimated point for a sensor reading. A client that overlays alarms should often use raw observations or a conservative summary rather than interpolated values.

Gapfill queries can be expensive when a requested range contains many groups. Estimate output cardinality as number of buckets multiplied by requested devices, and enforce a server-side maximum range or resolution. Pagination is awkward for a dense regular grid, so query design should bound both axes. For large dashboards, precomputed aggregates and a smaller per-request device set are often safer than generating every missing bucket on demand.

When a gapfill query groups by more than one dimension, ensure the generated grid is intended for every dimension value. If a device has no rows anywhere in the interval, it may not appear unless the query is anchored to a device inventory or calendar relation. For complete fleet-wide grids, join against the authoritative device set and define how retired devices are treated.
