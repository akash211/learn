# Loading: Stages, COPY, Snowpipe and Bad Rows

Loading is where most Snowflake incidents start. A pipeline silently stops loading because a file name was reused, a `COPY` aborts on the third bad row of a million-row batch, or a stream of 4 KB files costs more in per-file overhead than the data is worth. The mechanics are simple; the failure modes are not.

## Stages are the landing zone

Nothing is loaded from a client directly into a table. Files land on a stage first.

| Stage | Reference | Scope | Typical use |
| --- | --- | --- | --- |
| User stage | `@~` | One per user | Ad-hoc `PUT` from SnowSQL |
| Table stage | `@%orders` | One per table | Simple one-table loads |
| Named internal | `@raw.landing` | Schema object | Shared loads, grants, `COPY` history |
| External | `@raw.s3_events` | Points at S3/Azure/GCS | The normal production path |

An external stage is a URL plus credentials. Credentials should be a storage integration, not an inline key, so that the secret lives in one place and can be rotated without touching every stage:

```sql
CREATE STORAGE INTEGRATION s3_landing
  TYPE = EXTERNAL_STAGE
  STORAGE_PROVIDER = 'S3'
  ENABLED = TRUE
  STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/snowflake-load'
  STORAGE_ALLOWED_LOCATIONS = ('s3://acme-landing/events/');

-- Returns the IAM user and external ID to trust in the role's policy
DESCRIBE INTEGRATION s3_landing;

CREATE STAGE raw.events_stage
  URL = 's3://acme-landing/events/'
  STORAGE_INTEGRATION = s3_landing
  FILE_FORMAT = (TYPE = PARQUET);
```

`PUT` and `GET` are client-side commands: they exist in SnowSQL and the drivers, not in a worksheet, because the file has to be uploaded from wherever the client is. `PUT file:///data/2026-03-15.csv @raw.landing/ AUTO_COMPRESS = TRUE PARALLEL = 4;` compresses and uploads; it does not load.

## COPY INTO

```sql
COPY INTO raw.events
FROM @raw.events_stage/2026/03/15/
FILE_FORMAT = (FORMAT_NAME = 'raw.parquet_fmt')
MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
ON_ERROR = 'SKIP_FILE'
PURGE = TRUE;                      -- internal stages only
```

The load is a single transaction: a `COPY` either commits all files it processed or, depending on `ON_ERROR`, skips some. `PURGE = TRUE` removes staged files after a successful load, which is how internal stages stay small; it is rejected for external stages, where lifecycle rules on the bucket do the same job.

`MATCH_BY_COLUMN_NAME` is what makes the load robust to column order and to new columns: with Parquet, `CASE_INSENSITIVE` matches by name rather than position, so adding a column to the source does not shift every value one to the left. Without it, `COPY` maps by position and a reordered file is a silent data corruption, not an error.

## File size is the throughput setting

Snowflake parallelises a load across the warehouse's nodes at file granularity, so the number of files matters more than their total size:

- Many tiny files waste per-file overhead — metadata, transaction bookkeeping, and for Snowpipe, per-file charges.
- One enormous file limits parallelism to whatever one node can stream.
- The usual guidance is 100–250 MB compressed per file, with a floor around 10 MB.

For CSV and JSON, `PUT ... AUTO_COMPRESS = TRUE` handles compression on upload. For Parquet, compression is already in the format and `PUT` should not re-compress.

## Error handling that survives contact

The default `ON_ERROR = 'ABORT_STATEMENT'` means one malformed row anywhere in the batch fails the whole load — reasonable for a hand-run load, terrible for an automated pipeline. The options are `CONTINUE` (skip bad rows, keep loading, report counts), `SKIP_FILE` (skip an entire file containing an error), `SKIP_FILE_<n>` (skip only files with more than *n* errors), and `ABORT_STATEMENT`.

Before committing to a production load, validate:

```sql
COPY INTO raw.events
FROM @raw.events_stage/2026/03/15/
FILE_FORMAT = (FORMAT_NAME = 'raw.csv_fmt')
VALIDATION_MODE = RETURN_ERRORS;
```

`VALIDATION_MODE` parses the files, reports errors and loads nothing. `RETURN_<n>_ROWS` shows what the first *n* rows would look like after transformation. There is also a table function form, `SELECT * FROM TABLE(VALIDATE(raw.events, FILE_FORMAT => 'raw.csv_fmt'))`, which returns the errors for the most recent load — the fastest way to answer "which row, which column".

After the fact, `COPY_HISTORY` is the audit trail:

```sql
SELECT file_name, status, row_count, row_parsed, error_count, first_error_message
FROM TABLE(information_schema.copy_history(
  TABLE_NAME => 'RAW.EVENTS',
  START_TIME => DATEADD(hours, -24, CURRENT_TIMESTAMP())));
```

`status` is `LOADED`, `PARTIALLY_LOADED`, `LOAD_FAILED` or `LOAD_IN_PROGRESS`. A `PARTIALLY_LOADED` row with a non-zero `error_count` means `ON_ERROR = CONTINUE` did exactly what you asked and quietly dropped rows — this is the query to schedule daily, because nobody notices missing rows until a finance reconciliation fails.

## The 64-day load history trap

`COPY INTO` will not reload a file it has already loaded, identified by file name and checksum. That history is kept for 64 days. Two consequences:

- Rewriting a file in place and re-running `COPY` loads nothing, because the name matches. `FORCE = TRUE` overrides, at the cost of duplicating every file you did not intend to duplicate.
- After 64 days, history expires and an old file that reappears at the same path *will* load again.

The robust pattern is unique, immutable object names — a run timestamp or a content hash in the path — and no reliance on `FORCE`.

## Snowpipe

`COPY INTO` needs someone to run it. Snowpipe runs continuously, triggered by object-creation events:

```sql
CREATE PIPE raw.events_pipe
  AUTO_INGEST = TRUE
  AS COPY INTO raw.events
     FROM @raw.events_stage
     FILE_FORMAT = (FORMAT_NAME = 'raw.parquet_fmt')
     MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE;

SELECT SYSTEM$PIPE_STATUS('raw.events_pipe');
```

`AUTO_INGEST = TRUE` requires a notification channel — an SQS queue on S3, Event Grid on Azure, Pub/Sub on GCS — which is why `SYSTEM$PIPE_STATUS` reporting `executionState: RUNNING` with `pendingFileCount` climbing is the classic symptom of a broken event notification rather than a broken pipe.

Snowpipe is serverless: it is not tied to your warehouse, and it is billed by files processed plus compute time. Per-file overhead is significant, so Snowpipe is a poor fit for thousands of 20 KB files and a good fit for hundreds of 100 MB files. For row-level latency, Snowpipe Streaming writes records directly through an SDK and skips files entirely.

## Landing raw, transforming later

The pattern that survives real data is: land everything into a staging table with permissive types — `VARCHAR` for CSV, `VARIANT` for JSON — then transform into typed tables with `MERGE` or `INSERT ... SELECT`. Bad values become nulls or rejected rows in a controlled step, with a queryable error table, rather than aborting a load at 03:00.

This also makes replay possible. The raw table is immutable history; when the parsing logic was wrong, you reprocess rather than re-request files from a source system that may no longer have them.

## Common mistakes

- `PUT` inside a Snowflake worksheet. It is a client command and fails there.
- Assuming an external stage grants privilege means the table load will succeed — `COPY` needs `INSERT` on the table too, and the storage integration needs the bucket policy.
- Relying on `FORCE = TRUE` to fix a pipeline, then deduplicating downstream forever.
- Loading files with a timestamp in the name but reusing the timestamp value across retries, so half the retry is silently skipped.
- Setting `ON_ERROR = CONTINUE` without a check on `COPY_HISTORY`, then discovering dropped rows in an audit.

## Production notes

Alert on `PARTIALLY_LOADED` and on `COPY_HISTORY` gaps, not just on failures. Track `PIPE_USAGE_HISTORY` for Snowpipe volume and credits, and `SYSTEM$PIPE_STATUS` for pending file counts. Give each loader its own warehouse when load volume competes with BI, and set `STATEMENT_TIMEOUT_IN_SECONDS` so a pathological file cannot occupy the loader indefinitely.
