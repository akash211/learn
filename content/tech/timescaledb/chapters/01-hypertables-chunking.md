# Hypertables and Chunking

A hypertable is the TimescaleDB abstraction for a time-series relation. Applications query one logical table, while the extension stores rows in a collection of ordinary PostgreSQL tables called chunks. The chunks have non-overlapping ranges on a time dimension and may also be divided by a space dimension such as device or tenant hash. This arrangement is useful because a query for a short interval need not inspect every historical row, and old data can be managed in units much larger than individual tuples.

## From a table to a hypertable

Define a regular relation with the types, constraints, and defaults your application needs, then convert it using the syntax supported by the installed extension. In current releases, the common API is `create_hypertable`; newer releases also provide declarative `CREATE TABLE ... WITH (tsdb.hypertable, ...)` options, whose exact syntax is version-dependent.

```sql
CREATE TABLE sensor_readings (
  time        timestamptz NOT NULL,
  device_id   bigint NOT NULL,
  temperature double precision,
  humidity    double precision,
  PRIMARY KEY (device_id, time)
);

SELECT create_hypertable('sensor_readings', by_range('time'));
```

The relation must have a time column whose values identify when the observation occurred. Choose `timestamptz` for instants exchanged across time zones, and store UTC instants rather than local wall-clock strings. The hypertable time dimension is not necessarily the time the row arrived: late-arriving events still belong to the chunk for their event timestamp. This distinction matters for backfills, retention, and freshness calculations.

Older API examples often show `create_hypertable('table', 'time')`. Do not copy syntax blindly: signatures and migration guidance changed across releases. Check the installed version with:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';
```

and consult documentation for that version before production conversion. Conversion of a populated table may require a migration plan and locks; test it on a copy and understand whether the API migrates existing rows or requires an explicit migration option.

## What chunks buy you

A chunk is a physical PostgreSQL table for a bounded portion of the partitioning space. Inserts are routed to the chunk matching the row's timestamp. The extension maintains chunk metadata, creates chunks as needed within configured limits, and can prune chunks when the planner can prove a query's time predicate excludes them. A query with `WHERE time >= $start AND time < $end` is therefore the canonical form.

Chunks preserve much of the PostgreSQL table model: indexes and constraints exist on chunk storage, catalog inspection still applies, and PostgreSQL transactions still govern writes. The hypertable is not a distributed in-memory time-series engine. Every chunk consumes catalog entries, relations, indexes, planning work, locks, and maintenance. Millions of tiny chunks can make the system slower even if each contains few rows. The objective is a manageable number of chunks, not one chunk per device or per minute.

If there is a second dimension, it is generally a space partitioning dimension with a bounded number of partitions. A common motivation is isolating write contention or distributing data by tenant or device hash. It does not mean creating a separate partition for each distinct device. High cardinality causes a fan-out of chunks over time and can overwhelm catalogs and planning. Space partitioning also increases the number of chunk indexes and the number of chunks a time-range query may visit.

## Constraints and keys

Unique indexes on partitioned data need to include the partitioning columns so uniqueness can be enforced locally. TimescaleDB has had specific rules for hypertable unique constraints; commonly, the time column must be included, and any space partitioning columns may also be required. A primary key on `id` alone may therefore be invalid or fail to provide global uniqueness. An application can use a globally unique identifier and separately enforce the business key, but it must not assume that a local index proves uniqueness across all chunks.

For example, `(device_id, time)` is useful when the access path filters by device and time. It does not guarantee uniqueness of `(device_id, time)` unless that is the actual intended identity. For upserts, the conflict target must match a valid unique constraint. Decide the event identity and deduplication policy before bulk loading; adding an index after millions of rows have arrived is costly.

Foreign keys, triggers, generated columns, and table alterations interact with PostgreSQL and extension version support. Validate the exact operation against the target version, particularly when a migration tool expects a plain PostgreSQL table. Do not assume every third-party extension, logical replication feature, or ORM schema diff recognizes the hypertable abstraction equally well.

## Reading and managing chunks

Use the TimescaleDB information views and functions available in your installed version to inspect chunk ranges, sizes, and compression status. `show_chunks('sensor_readings')` is a familiar helper for listing chunks, while `chunks_detailed_size` and hypertable metadata views are useful in versions that expose them. Confirm signatures in the installed extension: introspection APIs have evolved.

Chunk pruning is only as good as the predicate. Keep the partition column bare in range comparisons. Wrapping it in a function, casting it inconsistently, or querying without a time bound can force many chunks to be considered. A query that scans years of data may still be correct and may still benefit from storage layout, but a hypertable does not magically turn a broad scan into a point lookup.

## Common mistakes

- Treating the extension as a separate service and forgetting it shares PostgreSQL memory, CPU, WAL, connections, and failure modes.
- Using ingestion time when product semantics require event time, or the reverse.
- Adding one space partition per tenant or device without calculating chunk fan-out.
- Expecting a unique index on a non-partition key to provide global uniqueness.
- Applying a migration tested only against PostgreSQL without checking extension compatibility.

## Production notes

Keep the logical table name stable for application queries, but monitor the physical chunks and extension version. Make time filters explicit in the application's common query paths. Ensure schema changes propagate as expected, and test restore and upgrade procedures with the extension installed. Hypertables are most valuable when the dataset is large enough for bounded chunks and time-oriented lifecycle operations to justify the added extension dependency. For a small table with ordinary access patterns, a regular PostgreSQL table is simpler.

## Migration and application contract

Plan how existing application code will discover and interact with the converted relation. Most SQL continues to address the hypertable name, but code that directly inspects `pg_class`, creates per-table triggers, or assumes a single physical relation may need adjustment. Migration scripts should be idempotent and should be tested against realistic data volume, because lock duration and index creation can dominate the migration. For a live system, a staged process can create a new hypertable, dual-write or backfill in bounded ranges, compare counts and checksums, then switch readers. The exact safest procedure depends on write rate and supported extension migration APIs.

Keep an explicit uniqueness and late-data contract in the application. A timestamp may be corrected or replayed; deciding whether that is a duplicate, an update, or a second event is a domain rule. The database key should encode the rule and satisfy partition constraints. This prevents an otherwise healthy chunk layout from becoming a source of silent duplicate readings.
