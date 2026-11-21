# COPY, UNLOAD, and Ingestion Patterns

Redshift is optimized for parallel data movement. The normal batch-ingestion path is `COPY`, which reads multiple files from S3 or another supported source across compute resources, distributes and sorts rows as needed, and loads a table much more efficiently than issuing a stream of individual `INSERT` statements. `UNLOAD` performs the reverse operation: it exports a query result to multiple S3 objects in parallel. Both commands belong in the design of repeatable data pipelines, not only in one-off administration scripts.

## Prepare reliable COPY inputs

A strong `COPY` pipeline writes data to a staging prefix, validates that the files are complete, then issues a load that names exactly the intended inputs. A broad prefix can accidentally include old files or another batch. A manifest file lists the S3 object URLs explicitly and can specify whether each object is required, making the input boundary reproducible. Keep a batch identifier and persist the generated manifest with pipeline metadata so operators can determine what was supposed to load.

```sql
COPY staging.events
FROM 's3://company-lake/manifests/events-2026-04-12.json'
IAM_ROLE 'arn:aws:iam::123456789012:role/redshift-load'
MANIFEST
FORMAT AS PARQUET;
```

The command must match the actual format and options. Text data may need an explicit delimiter, quote, escape, null, timestamp, or encoding configuration. Compression settings should reflect the files' codecs and whether they can be split for parallel reads. Redshift can load compressed files, but an unsplittable compression stream can constrain parallelism. Parquet and other supported formats carry schema information, but the destination table still needs compatible types and a deliberate mapping strategy.

For most production pipelines, load into a staging table first. Validate row counts, required columns, duplicate behavior, and domain checks; then use a transaction or controlled merge strategy to publish the batch. This avoids partially exposing a malformed source file. Use idempotent batch keys or a manifest ledger so retries do not silently duplicate data. `COPY` success is not the only correctness criterion: a loader should record which source objects were included and how many rows were accepted or rejected.

## Credentials and permissions

Use an attached IAM role rather than embedding long-lived access keys in SQL. Grant the role only the bucket prefixes, catalog access, and encryption-key permissions required for the pipeline. Cross-account access often requires both a role trust relationship and resource-side policy. Encrypted objects may fail if the role cannot use the relevant KMS key. Test permission changes against the actual Redshift identity and avoid widening access merely to make an error disappear.

## UNLOAD as an interface

`UNLOAD` writes the result of a query to S3. Output is commonly split into multiple files—often one or more per slice—so downstream consumers can process it in parallel. The `MANIFEST` option emits a JSON manifest that lists generated object locations and allows a later `COPY` to load exactly those files. Use `ALLOWOVERWRITE` only when the destination prefix and consumer expectations make replacement safe; otherwise use a unique, immutable batch prefix. Define file format, compression, encryption, and header behavior explicitly when downstream consumers depend on them.

Parallel output is usually preferable for large extracts. `PARALLEL OFF` can be useful for a small, ordered output or a consumer that requires a serial file, but it can create a throughput bottleneck and should not be used as a default. If the output is consumed as a dataset, publish a manifest or a completion marker only after all files are successfully available. Consumers should not infer that a partially written prefix is a complete batch.

## Staging, deduplication, and incremental loads

An ingestion pipeline needs a clear contract for late-arriving updates and duplicate events. Common patterns include append-only event batches keyed by source offset, staged upserts with deduplication, and bounded reload of a recent time window. For an upsert, load a new batch to staging, remove or replace corresponding target keys in a controlled operation, and insert the valid staged rows. At high volume, consider table-rebuild or CTAS-based strategies where appropriate, but benchmark lock, storage, and refresh implications.

Avoid thousands of tiny commits or small `INSERT` operations. Batch data upstream into a reasonable number of large files and let `COPY` parallelize the load. Do not make a single massive file that underutilizes slices, and do not create an object explosion that costs time in listing and task coordination. Choose file count and size with the source format, workload, and cluster shape in mind; test rather than memorizing a single ideal size.

## Failure handling and evidence

A failed load may have loaded some files before encountering an error; inspect load history and rejected-row details instead of assuming all-or-nothing behavior for a multi-file source. Provisioned environments expose history such as `STL_LOAD_COMMITS`, `STL_LOAD_ERRORS`, and related load views; `SYS_LOAD_HISTORY` and other `SYS` views can provide consolidated monitoring where available. System-table retention is bounded, so persist batch-level operational metadata outside those logs.

## Choosing formats and publishing batches

Input format is part of the contract between the producer and Redshift. CSV-like text is easy to inspect but requires careful handling of quoting, embedded delimiters, null representation, and character encoding. Columnar formats reduce scan and conversion work for structured analytical data, but require compatible schemas and supported codecs. Compression should be tested for both size and parallel readability; a smaller object is not automatically a faster load if decompression prevents efficient splitting.

A batch should have a clear lifecycle: objects are written under a unique prefix, validated, described by a manifest, loaded, reconciled, and then marked complete. Consumers should read only completed batches. For exports, use unique output prefixes and publish the manifest or completion signal after `UNLOAD` succeeds. Consumers can then read the exact result set without guessing which files belong to it. This protocol also makes retries safer: rerunning into a fresh prefix avoids mixing partial output with a previous attempt.

Keep the source record and target data tied together through batch IDs and row-level keys where possible. When a load is rejected, isolate malformed records and preserve enough source context to correct and replay them. Do not silently discard errors to meet a schedule; a lower row count can still produce a successful command. Validate counts against upstream expectations and retain rejected-row diagnostics under controlled access. These checks turn a fast bulk load into a trustworthy ingestion system rather than a file transfer that happens to execute SQL.

## Common mistakes

- Using a wildcard prefix that can include stale or unrelated files.
- Loading directly into a consumer-facing table before validating the batch.
- Replaying a successful batch without deduplication or an idempotency key.
- Using credentials in SQL instead of a least-privilege IAM role.
- Assuming one output file is the normal or fastest `UNLOAD` result.
- Declaring a batch complete before all files and its manifest are safely published.
