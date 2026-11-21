# Writing Well from Spark, pandas and DuckDB

A good Parquet write produces files that every intended reader can decode, with a useful schema, manageable object and row-group counts, compatible codecs, and metadata aligned to query patterns. The exact APIs differ by engine, so the durable practice is to specify and verify the physical output rather than assume a method call guarantees a layout.

## Plan files around readers

Choose a file-size target based on the engine, storage latency, scan parallelism, partition density and workload. Hundred-megabyte to gigabyte-scale files are common analytical starting points, not a universal rule. Avoid tiny files that make footer and object-request costs dominate; avoid giant indivisible row groups that constrain parallelism or memory. A file can contain multiple row groups, so file size and row-group size are related but distinct decisions.

Before choosing compression or row-group settings, identify consumers and their minimum supported Parquet libraries. Snappy is widely interoperable; Zstd can be a storage/transfer trade if reader support is confirmed. Record schema and codec in tests. Consider statistics and, where available and supported, bloom filters for selective equality filters. They improve only supported access patterns; they do not replace clustering or transaction semantics.

## Spark

Spark writes distributed output from tasks. The number and distribution of input partitions, partitioned output columns, skew and write options affect file count and size. `partitionBy` creates directory layout, while `repartition` redistributes rows and may incur a shuffle. Sorting within partitions can improve row-group statistics but adds work. `maxRecordsPerFile` bounds rows rather than bytes, so variable-width records make it an approximate size control.

```python
(df.repartition(120)
   .sortWithinPartitions("event_time")
   .write
   .mode("append")
   .option("compression", "zstd")
   .option("maxRecordsPerFile", 2_000_000)
   .partitionBy("event_date")
   .parquet(output_path))
```

This is an illustrative shape, not a guaranteed target: validate the options and codec in the deployed Spark version, and examine resulting file sizes and row groups. A global `repartition` just to reduce file count can shuffle the entire dataset. A `coalesce` may avoid a shuffle but can preserve skew. Partitioning a large write by a column with many values can create many sparse directories. When overwriting, verify static versus dynamic partition semantics; a mistaken overwrite can remove data beyond the intended date range. Raw Parquet has no atomic table commit.

## pandas and PyArrow

pandas commonly writes a single DataFrame through PyArrow or another Parquet engine. This is convenient for data that fits in one process, but not a scalable distributed writer. `DataFrame.to_parquet` exposes engine, compression, index and partitioning options, while PyArrow's `ParquetWriter`/dataset APIs provide more control over row groups, file visitors and partitioned datasets. Be explicit about index behavior: an index may be stored as a column or metadata and later surprise readers.

For large local datasets, stream batches through a writer or dataset API rather than holding a second full copy in memory. Decide whether pandas nullable dtypes, categoricals, timezone-aware timestamps and decimals map to the desired logical types. Round-trip tests across actual downstream readers catch subtle differences. When writing partitioned datasets, evaluate the generated directory structure and file count: partitioned output from small batches can explode into small files.

## DuckDB

DuckDB can write query results to Parquet with `COPY` and can scan and transform Parquet directly. Settings such as compression and row-group sizing are version-dependent; consult the installed version's documentation and verify output metadata rather than copying a configuration from a different release. DuckDB's multi-threaded execution can produce multiple output row groups or files according to options, but a single output path is not by itself a table-format transaction.

```sql
COPY (
  SELECT event_date, customer_id, amount
  FROM staging
  ORDER BY event_date, customer_id
) TO 'events.parquet'
(FORMAT PARQUET, COMPRESSION ZSTD);
```

Ordering a result can improve row-group ranges but incurs sorting cost and may not imply a multi-file partitioned dataset. Use `COPY` with explicit options supported by the installed build, then inspect schema, stats, codec, row groups and size.

## Sorting, statistics and bloom filters

Sort or cluster only when query patterns benefit. Sorting on `event_time` can narrow min/max ranges for time filters; sorting by a random high-cardinality value may be expensive and less useful. Column-chunk statistics are widely used for coarse pruning. Page indexes and bloom filters are optional structures with uneven writer and reader support. A bloom filter is useful for testing whether a value may exist, not proving a positive match; it avoids some false-positive-free negatives but has false positives by design. Do not enable one blindly without reader support and a selective equality workload.

## Validate the output contract

After writing, inspect a representative sample and the full directory statistics. Confirm schema, logical types, nullability, timestamp semantics, codecs, row-group count, actual size distribution, partition paths and statistics. Read it using the oldest supported consumer. Compare row counts and null behavior. For mutable datasets, use Delta/Iceberg or another table protocol rather than assuming a Parquet write is atomic.

## Common mistakes

- Treating record count as file size; variable-length values invalidate that assumption.
- Calling `repartition(1)` to make output “clean,” creating a serial bottleneck and one large file.
- Believing sorting or bloom filters automatically guarantee pruning across engines.
- Forgetting that `partitionBy` changes directory layout and write fan-out.
- Leaving index, timezone or decimal behavior implicit in pandas pipelines.
- Depending on a writer option without confirming the output's actual metadata.

## Production notes

Store a small golden output fixture for each writer and test it in Spark, DuckDB and any warehouse/external-table readers. Track count, bytes, file-size quantiles, row groups, schema fingerprint and scan behavior over time. Treat changes to codec, nested schema or timestamp representation as compatibility changes. For incremental workloads, plan compaction and safe publication as part of the table design rather than as an afterthought.

## Write validation beyond row counts

A successful write and matching row count do not prove the file is correct for every consumer. Compare representative values, null distributions and boundary cases. Verify the exact timestamp unit and timezone behavior, decimal precision and scale, string encoding, nested list conventions and whether the DataFrame index became a column. For partitioned outputs, check that partition columns have the intended values and that readers reconstruct them consistently. A schema fingerprint can detect accidental changes, but semantic assertions are still needed.

Inspect output across the distribution, not only the first file. A skewed partition or task retry can create file sizes and row-group counts different from the median. A writer may emit different codecs or omit statistics for certain columns. Keep quantiles and tail examples for file size, row-group size and rows per file. These metrics help detect changes in task parallelism or data width before query performance degrades.

For overwrite workflows, also verify what happens when the job fails between writing and publishing. Raw Parquet output should be written to a staging or versioned location and become discoverable only after validation. A table-aware writer should commit through its transaction protocol. Include an interruption test in release qualification if partial output would be costly. This turns file quality from a one-time tuning exercise into a repeatable contract between producers and readers.
