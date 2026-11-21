# Spectrum and External Tables over S3

Redshift Spectrum extends warehouse queries to data stored in Amazon S3. An external table describes files through metadata; the query engine reads those objects as part of a SQL plan. This lets a team combine data in Redshift-managed tables with datasets that remain in an object store. Spectrum is useful for exploration, infrequently queried history, shared open-format data, and staging before deciding which data deserves warehouse storage.

## External schema and table metadata

An external schema connects Redshift to a catalog such as the AWS Glue Data Catalog, or to another supported metadata arrangement. External tables describe location, format, columns, partitions, and related properties; they do not own the S3 objects as ordinary Redshift tables do. IAM authorization must allow the Redshift workload to read the bucket and, where relevant, access the catalog. With Lake Formation, data permissions can be governed centrally, subject to the supported integration and configuration.

A simplified external table definition might look like this:

```sql
CREATE EXTERNAL TABLE lake.events (
  event_date date,
  customer_id bigint,
  event_type varchar(40),
  amount decimal(12,2)
)
STORED AS PARQUET
LOCATION 's3://analytics-lake/events/';
```

In production, teams commonly use Glue crawlers, ETL jobs, or schema deployment tooling to maintain catalog metadata rather than hand-writing every table. A crawler is convenient but should not silently determine a contract: type inference, naming, and schema evolution need validation. Treat the external schema as an interface between file producers and query consumers.

## File layout and partitions

External-query performance is governed by object format, compression, file count and size, partitioning, and predicate pushdown. Columnar formats such as Parquet allow reading only referenced columns and support statistics that can help skip data. Partitioning by a frequently filtered field such as date can avoid listing and scanning irrelevant partition paths. But over-partitioning into tiny folders or creating hundreds of thousands of tiny objects creates metadata and scheduling overhead. A coarse date partition with healthy-sized files often behaves better than one path per customer or event.

Partition columns are metadata derived from the S3 path and catalog definition, not necessarily values embedded in every Parquet row. Filter directly on partition columns where possible. Use `EXPLAIN` and Spectrum-related monitoring to confirm that the expected pruning occurs. A query returning a small result can still read a large fraction of the dataset if the predicate cannot be pushed down or files are laid out poorly.

Prefer Parquet or another supported columnar format for analytic scans over row-oriented text when the producer can maintain it. Compression is valuable, but compatibility, schema consistency, and file sizing matter. Parquet's schema and physical encoding must agree with the catalog types; mismatches can result in conversion errors or subtle interpretation problems. Keep a schema-evolution policy for added, removed, and changed columns, and test it against old partitions.

## Joining external and local data

Spectrum makes it possible to join external tables and local Redshift tables in one SQL statement, but that does not mean the data behaves identically. External scan time, remote reads, metadata, filters, and data movement all contribute. A common pattern is to use S3 as durable raw or curated storage, scan it with Spectrum for selective or occasional access, and load frequently queried subsets into Redshift tables using `COPY` or a transformation pipeline.

This is a workload decision, not a rule to load everything or leave everything external. Compare access frequency, data freshness, query latency, governance, storage duplication, and transformation needs. A compact dimension or recent fact slice can be local while older history remains external. Late-binding views can provide a stable interface across local and external relations, with the caveat that underlying objects are checked when the view is queried.

## Security and observability

The access chain crosses services: a database user has SQL privileges; the Redshift cluster or workgroup has an IAM role; the role is allowed to access the S3 objects and catalog; and bucket policies, KMS keys, or Lake Formation grants may further restrict access. A successful database `GRANT` does not override a missing IAM or KMS permission. Conversely, a broad IAM role can expose objects beyond what SQL consumers should read. Keep these layers least-privileged and test using the actual runtime role.

Monitor external scans separately from local scans. `SVL_S3QUERY`, `SVL_S3QUERY_SUMMARY`, and `SVL_S3PARTITION` can help investigate Spectrum activity on supported provisioned configurations; `SYS` views may provide a better unified experience. The exact available views differ across environments. Capture bytes scanned, partitions considered, files read, retries, and errors where available. `SVL_SPECTRUM_SCAN_ERROR` can help diagnose external scan failures.

## Designing a lake/warehouse boundary

An external table is most useful when the producer and consumer agree on ownership. The producer owns the objects, schema evolution, partition publication, and retention policy; the Redshift team owns the catalog contract, SQL access, and query behavior. Write down who can add a partition, how a completed batch is identified, and how old data is retired. Without a publication protocol, a query can observe a partially delivered dataset even when the SQL itself is correct.

Choose which data stays in S3 by considering access patterns. Cold history with occasional broad exploration is a natural external candidate. A frequently refreshed dashboard dimension or recent fact window may be better loaded locally if repeated external scans harm latency or capacity. A hybrid query can combine the two, but its plan and freshness contract need testing. Do not interpret a successful external query as evidence that every partition and object was visible; verify expected date ranges and row counts.

Use file inventory and scan telemetry as part of data quality. Track object count, total bytes, partition counts, schema versions, and failed scans. Many small files can increase overhead even if total bytes are modest. A compaction process should preserve partition values and schema compatibility, publish new objects atomically where practical, and clean up old objects only after readers no longer depend on them. Keep access boundaries narrow: a role for one external schema should not automatically have access to every bucket in the account.

A useful external-table test set includes one query that should prune to a single partition, one query that spans several partitions, and one query that intentionally reads a broad range. Compare bytes scanned, files touched, and elapsed time. This reveals whether the catalog and file layout behave as expected, and provides a baseline after compaction or schema changes. Keep the test data representative; a tiny sample can hide scheduling and metadata overhead.

## Common mistakes

- Treating an external table as a copy of data rather than metadata over S3 objects.
- Creating too many tiny files or partitions and expecting parallelism to compensate.
- Assuming a selective SQL predicate guarantees selective S3 reads.
- Relying on catalog inference without governing type and schema changes.
- Granting Redshift SQL access but forgetting IAM, bucket, KMS, or Lake Formation permissions.
- Keeping hot, repeatedly scanned data external without comparing the local-table alternative.
