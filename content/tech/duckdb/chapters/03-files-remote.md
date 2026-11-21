# Querying CSV, JSON, Parquet, and Remote Files

One of DuckDB's defining workflows is querying files directly. A path can be a table function in `FROM`, so analysis starts without a separate import phase. The format still determines what can be inferred, pruned, and safely shared; “read in place” is not the same as “free of I/O or schema decisions.”

## Parquet: the analytical default

Parquet is columnar and stores metadata that lets readers skip irrelevant columns and, when statistics permit, row groups. DuckDB's `read_parquet` table function scans one or more files and accepts globs. Projection pushdown means selecting three columns from a wide file need not decode every column; filter pushdown can skip data when the file metadata and predicate support it.

```sql
SELECT region, sum(net_sales) AS revenue
FROM read_parquet('lake/sales/*.parquet')
WHERE sale_date >= DATE '2025-01-01'
GROUP BY region;
```

For a Hive-style directory layout such as `year=2025/month=01`, Hive partition values can be exposed as columns when Hive partitioning is enabled or detected. A direct predicate on a partition column can eliminate directories before reading file contents. Avoid wrapping the partition field in an expression if it prevents pruning. Inspect actual plans and bytes read; a filename layout only helps when the reader interprets it and the query filters it appropriately.

`read_parquet` can read multiple files, but schemas must be compatible or deliberately unified. Appending a new column to later files can produce schema-evolution questions; use schema union options supported by the version or normalize inputs explicitly. Do not assume all files in a glob have identical types merely because they share a suffix.

## CSV: flexible, but infer cautiously

CSV has no universal type system. DuckDB can auto-detect delimiter, header, and types, or you can provide options and types to make ingestion deterministic. `read_csv` is convenient for exploration; production ingestion should set `header`, `delim`, date formats, null strings, and column types when ambiguity could change meaning. An identifier like `00127` may be a string, not an integer; an unquoted `NA` may represent a missing value or literal text depending on the source contract.

```sql
SELECT *
FROM read_csv('incoming/orders.csv',
              header = true,
              columns = {'order_id': 'VARCHAR', 'amount': 'DECIMAL(12,2)'});
```

CSV parsing is more expensive than Parquet scans and schema inference can vary with samples. For repeat analysis, convert stable inputs to Parquet, choosing compression and partitioning based on downstream access patterns. Conversion does not fix incorrect source interpretation: validate row counts, rejected rows, and edge cases such as embedded newlines and quoted delimiters.

## JSON and nested records

JSON inputs may be newline-delimited objects or arrays; use the JSON reader suited to the source shape. DuckDB can infer a relation from records and expose nested values using `STRUCT`, `LIST`, and JSON functions. Schema inference is useful for exploration but can be surprised by sparse keys or inconsistent types. For a durable pipeline, select fields, cast them, and define a stable output schema rather than letting each batch silently infer a different one.

If a JSON column is kept in DuckDB's `JSON` logical type, it remains queryable with JSON extraction functions, but extracting frequently used fields into typed columns can improve downstream clarity and operations. JSON text is not automatically a normalized relational model. Decide whether to preserve raw payloads for audit, promote common attributes, and handle missing and explicit-null values separately.

## Scan versus materialize

A direct file scan is a good fit for exploration and append-only data. It avoids an import copy and can read only relevant columns. Repeatedly scanning a large remote source, however, may be slower and more expensive than materializing a local snapshot. `CREATE TABLE AS SELECT ...` persists a managed DuckDB table; `COPY (SELECT ...) TO 'out.parquet' (FORMAT parquet)` writes a portable result. The correct choice depends on whether the result is a cache, a durable database table, or an inter-engine artifact.

```sql
COPY (
  SELECT customer_id, sum(amount) AS lifetime_value
  FROM read_parquet('lake/orders/*.parquet')
  GROUP BY customer_id
) TO 'exports/customer_value.parquet' (FORMAT parquet, COMPRESSION zstd);
```

`COPY TO` writes the selected result and overwrites an existing destination; make that explicit in a pipeline's idempotency policy. For partitioned output, use supported `PARTITION_BY` options, and avoid generating enormous numbers of tiny files by partitioning on high-cardinality attributes.

## HTTP and S3 with httpfs

The `httpfs` extension supports HTTP(S) files and S3-compatible storage. Install/load it as required by the distribution. Remote Parquet reads can use HTTP range requests when the server supports them, allowing selective reads rather than downloading the entire object. Object-store credentials and endpoint configuration belong in secrets/configuration, not literal SQL committed to a repository.

```sql
INSTALL httpfs;
LOAD httpfs;
SELECT count(*) FROM read_parquet('https://example.org/events.parquet');
```

For S3, configure credentials, region, endpoint style, or a DuckDB `CREATE SECRET` appropriate to the provider and version. Prefer role-based or short-lived credentials when available. Treat external access as a security boundary: a SQL query can read paths available to the process. In hosted services, disable or constrain external access for untrusted SQL and consider allowlists, network egress rules, and isolated credentials.

Remote reads depend on latency, request limits, object consistency, and network policy. A selective query may still issue many metadata requests across a wide glob. Stage frequently used data locally or materialize a curated extract when repeated scans cost more than caching. Be deliberate about retries and partial failures; a successful query over one object is not proof that every expected partition was discovered.

## Common mistakes and production notes

- Relying on CSV inference for production identifiers, decimal precision, or dates.
- Reading every column with `SELECT *` and then attributing full-file I/O to DuckDB.
- Assuming a Parquet glob guarantees schema compatibility or a stable file list.
- Embedding cloud keys in notebooks, SQL, logs, or exception messages.
- Treating a file path as a transactionally consistent table while another job replaces files.

Record input manifests or partition ranges when reproducibility matters. Verify both the file count and logical row counts; files can be empty, duplicated, or missing. Keep source data immutable during a query where possible, and write output to a new location before publishing it. DuckDB makes file analytics simple, but the filesystem remains part of the data contract.

## File discovery, manifests, and reliable publication

A glob is a discovery rule, not an immutable snapshot. If files are added while a query runs or if a retry sees a different set, results can differ. For critical jobs, enumerate inputs from a manifest, partition range, or table-format snapshot. Log the resolved file count and watermark so “same SQL” is reproducible across scheduler retries.

When writing multiple output files, downstream consumers may observe a partially written directory if publication happens in place. Prefer a run-specific staging directory, validate it, and then publish through a storage operation whose atomicity is documented. On object stores, rename may be copy plus delete; do not assume local filesystem semantics. Use a table format when atomic snapshot commits and concurrent readers are requirements.

File formats influence parallelism. A single CSV stream can be harder to split than multiple independent Parquet row groups, and compression differs in splittability. Conversion into Parquet often pays off when later queries repeatedly scan a subset of columns. Measure the complete pipeline, including conversion writes, not only repeated reads.
