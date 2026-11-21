# ETL, Bulk Loading and Change Capture

SQL Server supports ETL from simple bulk-load commands to the legacy SQL Server Integration Services (SSIS) platform. Choosing a pattern depends on source volume, latency, transformations, restartability and operational ownership. The important design is not merely how data enters a staging table, but how each load is validated, made idempotent and exposed downstream without losing or duplicating changes.

## Bulk load and staging

`BULK INSERT` loads a file into a table and offers options for field/row terminators, error files, batch size, format files and locking. `bcp` is a command-line utility for bulk copy in and out. `OPENROWSET(BULK...)` can expose file content through a query in supported configurations. File access occurs from the server or service context, not necessarily from the interactive client. Azure storage and managed SQL services have distinct authentication and feature requirements.

```sql
BULK INSERT staging.orders
FROM 'D:\\landing\\orders.csv'
WITH (FIRSTROW = 2, FIELDTERMINATOR = ',', ROWTERMINATOR = '0x0a',
      TABLOCK, ERRORFILE = 'D:\\landing\\orders_errors');
```

Real CSV can contain quoted delimiters and embedded newlines, so simple terminators may not parse it correctly; use a supported CSV format option or a robust ingestion tool. Load into a staging schema, preserve raw values where practical, validate counts and types, then merge or replace target data inside a controlled transaction. Batch size trades transaction-log pressure against throughput and atomicity. Minimal logging is conditional on recovery model, table/index state, locking and operation; do not promise it just because a bulk command was used.

SSIS remains common in established estates for control flow, data flow, connectors, parameters and deployment through the SSIS catalog. It is a legacy but supported integration platform in many environments, not the same thing as SQL Server Agent. Package execution needs reliable credentials, logging, retry and deployment practices. For new cloud pipelines, compare SSIS integration runtime, Azure Data Factory, Fabric Data Factory and other tools against the required connectors and hosting model.

## Change Tracking versus CDC

Change Tracking records that a row changed and provides a synchronization mechanism for consumers that can query the current row state. It is lightweight and does not preserve every intermediate value. A consumer stores a version watermark, requests changes since that version, and must handle retention cleanup and invalidated versions. Validate the watermark with `CHANGE_TRACKING_MIN_VALID_VERSION` before applying deltas; if it is too old, reinitialize the consumer.

Change Data Capture (CDC) reads the transaction log asynchronously and writes change rows into change tables. It can expose captured values and operation metadata, which is useful for ETL and audit-like downstream processing, but it adds capture jobs, storage and latency. CDC is not an immutable audit guarantee; retention can clean records, capture can lag, and consumers must monitor job health. Query `sys.sp_cdc_help_change_data_capture` and CDC catalog views to inspect capture configuration. Exact availability depends on SQL Server version, edition and Azure service.

```sql
-- Change Tracking consumers use a monotonically advancing database version.
SELECT CHANGE_TRACKING_CURRENT_VERSION() AS current_version;
SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('dbo.orders')) AS min_valid_version;
```

Use Change Tracking when downstream only needs to know which keys changed and can reread current rows. Use CDC when consumers need a change stream with captured before/after-related fields and operation ordering. Neither feature replaces a transactional outbox when an application must atomically publish domain events with its own business transaction.

## Idempotency and operations

An ETL load should have a durable batch identifier, source watermark and reconciliation record. Stage first, validate uniqueness and expected counts, then commit the target change and watermark together where possible. Upserts need a unique target constraint and safe concurrency design. Re-running a failed batch must not silently double-count facts. For incremental loading, define how deletes are represented and how late-arriving updates are handled.

Monitor SSIS or orchestration run status, CDC capture latency, change-table retention, log growth and load duration. Keep raw landing data long enough to replay a batch, but protect sensitive data with the same access controls as production tables. Test recovery after a partial load, expired Change Tracking watermark, broken source file and unavailable downstream consumer.

## Common mistakes

- Assuming `BULK INSERT` runs with the desktop user's filesystem permissions or parses arbitrary CSV correctly.
- Expecting minimal logging without meeting its recovery model and table/index prerequisites.
- Confusing Change Tracking's changed-key signal with CDC's retained change rows.
- Failing to check `CHANGE_TRACKING_MIN_VALID_VERSION` before consuming a watermark.
- Treating CDC retention as permanent audit history or ignoring capture job lag.
- Updating the target and consumer watermark in separate non-recoverable steps, causing gaps or duplicates on retry.


## Restartable ingestion as a transaction protocol

A robust pipeline defines a durable unit of work: batch ID, source file or partition, source watermark, expected row count, validation state and target commit state. Land raw input first where feasible, preserve lineage, then parse and validate into staging. Enforce uniqueness before applying changes. A batch should either be safely replayable or have a durable checkpoint that proves exactly which rows committed. If target writes and watermark advancement cannot share a transaction, design a reconciliation protocol that can detect and repair the gap.

For Change Tracking, capture the current version as the upper bound for a sync cycle, validate the consumer's prior version with `CHANGE_TRACKING_MIN_VALID_VERSION`, then read changes over the documented version interval and retrieve current rows. Persist the new watermark only after downstream application succeeds. Change Tracking is a changed-key signal; multiple updates between polls collapse to current state, and deletes need explicit handling. If retention invalidates the prior version, reinitialize from a consistent snapshot instead of silently skipping forward.

CDC consumers use LSN ranges and change tables. Use `sys.fn_cdc_get_min_lsn` and `sys.fn_cdc_get_max_lsn` to assess the available interval, and the generated capture functions to read a bounded range. Persist the last successfully applied LSN, monitor capture job latency and cleanup retention, and make target application idempotent. CDC provides captured changes, not permanent audit history. A snapshot plus LSN handoff requires a consistent initialization strategy so rows are neither missed nor duplicated across the boundary.

## Bulk loading and operational trade-offs

`BULK INSERT` operates in the server/service security context. File location, managed identity or credential configuration, format, row terminator and error handling must match the deployment. CSV with quoted commas or embedded newlines requires a supported CSV parser/format rather than naive delimiter splitting. `TABLOCK` and batch sizing affect concurrency and logging; minimal logging depends on recovery model, table/index state and operation prerequisites. Validate with real files and recovery expectations.

Batch commits can bound log usage and retry scope, but change atomicity: downstream readers may see partial batches unless staging and publish boundaries are controlled. Record rejects and reconciliation counts; do not silently discard conversion failures. For SQL Agent or SSIS orchestration, capture package/run identifiers, retries, credentials, alerts and deployment versions. Protect raw staging data and bound its retention. Test crash after load, crash during apply, expired watermark, duplicate file, late update and downstream outage. A successful job status is not evidence that every expected source row was applied exactly once.
