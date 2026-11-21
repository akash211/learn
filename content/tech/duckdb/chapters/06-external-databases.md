# PostgreSQL, SQLite, Iceberg, and Delta

DuckDB can reach beyond its own database file through extensions. This makes it a useful local query and export engine across sources, but an extension is an integration boundary with its own version, authentication, type mapping, pushdown, and transaction behavior. Directly querying an external database is not the same as copying it into DuckDB.

## PostgreSQL through the postgres extension

The `postgres` extension (sometimes described through the `postgres_scanner` functionality) attaches a PostgreSQL database so its tables can be queried with SQL. Install/load the extension for the DuckDB version and attach using a libpq connection string or URI. Prefer read-only attachment when the job only needs to extract data.

```sql
INSTALL postgres;
LOAD postgres;
ATTACH 'host=localhost dbname=app user=reader' AS pg (TYPE postgres, READ_ONLY);
SELECT count(*) FROM pg.public.events;
```

The exact attach options and catalog naming depend on extension version. Do not place passwords in a literal connection string: errors and SQL logs may expose it. Use secrets, `.pgpass`, environment-provided credentials, or an approved credential manager. Restrict attached schemas where possible and give the account least privilege.

A query against an attached PostgreSQL table may scan rows from PostgreSQL at execution time. Some filters and projections may be pushed down; not every DuckDB operator can be translated into remote SQL. Inspect the plan and compare network traffic and source load. If a table is read repeatedly for a substantial local transformation, copy a consistent snapshot into a DuckDB table or Parquet files rather than re-fetching it every run.

```sql
CREATE TABLE local_events AS
SELECT * FROM pg.public.events
WHERE event_date >= DATE '2025-01-01';
```

That creates a local copy, with freshness determined by the extract time. Design incremental loads and checkpoints explicitly. A successful query does not establish a cross-system transaction that atomically couples a PostgreSQL update with a DuckDB file write.

## SQLite and other databases

The SQLite extension can attach or scan SQLite databases in supported versions. This is useful for migration, audit, and analytics over an application database snapshot. It does not make DuckDB a drop-in SQLite replacement: SQLite has a row-oriented transactional workload and broad embedded ecosystem; DuckDB targets analytical scans. For any external database extension, test how the source's types, collations, constraints, and transactions map into DuckDB.

Extensions for other sources may be available, but names and status can change. Check the installed version's extension catalog and documentation rather than assuming a third-party connector ships everywhere. Some integrations are read-only, some support writes, and some operate through files or catalogs rather than a live database connection.

## Iceberg and Delta Lake readers

Iceberg and Delta Lake are table formats that add metadata and transaction logs around data files, typically Parquet. Their readers let DuckDB query table snapshots through supported extensions, often with catalog or storage configuration. The extension, catalog, and version combination determine which operations work; support for reading a snapshot is not equivalent to complete write, merge, streaming, or maintenance support.

The key idea is metadata resolution. Querying a table name requires discovering the current snapshot and its files, not merely globbing every Parquet object in a directory. Respect the table format's catalog and snapshot semantics; do not bypass the log and read a raw directory if deleted or superseded files could be included. For cloud tables, configure `httpfs`/credentials and catalog access independently.

Before adopting an extension in a production pipeline, test representative operations: list namespaces/tables, resolve the expected snapshot, filter by partition columns, read evolved schemas, handle deletes, and confirm authentication and refresh behavior. If writing is required, verify that the exact extension/version supports the needed commit protocol and concurrency semantics; do not infer it from successful reads.

## Choosing direct scan or local copy

Direct scan is attractive for one-time extraction, smaller tables, and fresh reads. Local materialization is preferable for repeated joins and aggregates, resilience to network outages, reproducible snapshots, and predictable query latency. Materialization costs storage and introduces a freshness boundary, so record extraction timestamp, watermark, and source query. For large exports, query only required columns and rows and write Parquet where downstream engines benefit.

Cross-database type mapping deserves explicit tests. PostgreSQL `NUMERIC`, timestamps with time zones, arrays, enums, and custom types may not preserve exactly the semantics a destination expects. Compare row counts, null counts, min/max, and checksums on a sample. A cast that makes a query run can still lose precision.

## Common mistakes and production notes

- Assuming PostgreSQL scanner access means all joins and filters run remotely.
- Using a read-write external attachment without intending to modify the source.
- Assuming a Delta or Iceberg extension supports every table-format operation.
- Reading raw Parquet under a table root while ignoring snapshot metadata and deletes.
- Exposing passwords in connection strings, logs, notebooks, or error reporting.

Keep network access and credentials scoped to the job. Pin extension versions along with DuckDB itself, and verify extensions in the actual deployment image rather than on a developer laptop. The boundary between source and local copy is a data-contract decision: document freshness, schema conversion, retries, and what happens if the source changes during extraction.

## Consistency, pushdown, and security at connector boundaries

A live remote scan can see source changes across statements unless connector transactions guarantee a stable snapshot. For a multi-query extract, determine whether queries share one PostgreSQL transaction or whether the source can change midway. A local `CREATE TABLE AS` snapshot gives repeatable work after it completes, but extraction still needs a consistency plan. Capture a watermark or use source-side snapshot semantics where available.

Pushdown is both a performance and an observability issue. A plan may reveal that a filter runs locally after remote rows arrive, increasing network transfer and PostgreSQL load. Test pushdown for the specific predicate, cast, and join shape; do not assume behavior from a different extension release.

External integrations expand process authority: PostgreSQL credentials may write source tables, cloud credentials may read buckets, and extensions execute native code. Use read-only roles, narrow schemas and buckets, least privilege, approved builds, and secrets scoped to the job.

## Testing extension compatibility

A local success is only a first test. Run the same query using the exact DuckDB package, extension repository, operating system, and credentials used in deployment. Verify that the extension can be installed or loaded in the network-restricted environment and that startup does not depend on an interactive prompt. Record which source table and snapshot were read.

If the plan fetches more data than intended, prefer a source-side view or a narrower predicate that the connector can push down, then confirm with source metrics. This protects both network cost and the operational database from accidental full scans. Coordinate extraction windows with source owners when analytical reads could compete with application traffic.
