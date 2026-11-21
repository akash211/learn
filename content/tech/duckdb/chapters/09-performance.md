# Performance Tuning and Memory

DuckDB is fast when the query, file layout, and hardware line up. Tuning starts with a measurement and a representative data set, not a magic thread count. First establish correctness, then locate whether time is spent scanning, computing, spilling, fetching results, or waiting on a remote source.

## Threads and parallelism

`SET threads = 4;` limits the number of worker threads for the instance. The default generally follows available CPU resources, but the useful degree of parallelism depends on operator and input layout. A large Parquet scan with many row groups can use multiple threads; a tiny file, serial operation, or one giant unsplittable input cannot. Too many threads can compete for CPU, storage bandwidth, or memory and make latency worse.

If an application runs several concurrent queries, account for total process parallelism: four queries each using all cores may oversubscribe the host. Benchmark throughput and latency under expected concurrency, not only a single isolated query. Keep spare CPU for the application and operating system.

## Memory limits and temporary spilling

`memory_limit` controls the memory DuckDB is allowed to use for its managed allocations; it is not a complete limit on every allocation in an embedding process. Python objects, Arrow buffers, extension code, and other host allocations may sit outside the engine's accounting. Set a limit below the machine's practical budget when DuckDB shares a host, and leave room for the process and OS.

Blocking operators—large joins, group-bys, sorts, and window functions—need state. DuckDB can spill supported intermediate state to disk for many larger-than-memory queries. `temp_directory` controls where temporary spill files go, and `max_temp_directory_size` caps their use. Ensure the configured directory has sufficient capacity and fast enough storage; a full disk can fail a query even when RAM is available.

```sql
SET memory_limit = '8GB';
SET temp_directory = '/fast-disk/duckdb-tmp';
SET max_temp_directory_size = '100GB';
```

Spilling is a resilience mechanism, not free memory. Temporary I/O can dominate runtime, and not every operator or aggregate state spills equally well in every release. Complex combinations of blocking operators may still exhaust memory. Test the largest expected group, sort, and window, and monitor temp disk usage. Reduce unnecessary columns and rows before blocking operators.

## File layout and formats

Parquet is usually a strong analytical format because it is columnar, compressed, and carries statistics. Use compression appropriate to the CPU/storage balance (for example, Zstandard for compact storage or Snappy for a fast common trade-off), then benchmark with the actual workload. Do not create thousands of tiny files: each file adds metadata and scheduling overhead. Nor should all data be placed in a single giant file if parallel row groups and partition pruning are important.

Partition by columns commonly used for selective filters, with sensible cardinality. Partitioning by a unique user id can produce a directory explosion and poor planning. File sizes and row groups affect scan parallelism; avoid treating a single fixed size as ideal across local SSD and object storage. Filter early and project only columns needed. Keep statistics useful by avoiding pathological value ranges when writing data.

## Query shape and result movement

Use `EXPLAIN` and `EXPLAIN ANALYZE`. Push selective predicates before joins and aggregations when semantics allow; pre-aggregate fact data only when it preserves required results. Check join multiplicity and avoid cross joins unless intended. Large `ORDER BY` and windows over broad partitions can require substantial state; apply filters before them and use a narrow projection.

Do not measure only the engine while ignoring output. Fetching millions of Python tuples can take longer and use more RAM than computing the aggregate. Return only what the application consumes, use Arrow or record batches for bulk interchange, and write large results to Parquet rather than routing them through Python row objects.

## Repeatable benchmarks

Benchmark warm and cold behavior separately where relevant. Remote HTTP/S3 results can be affected by network and cache state; local filesystem caches can hide disk work. Use identical input snapshots, DuckDB version, extension versions, thread count, memory cap, and output method. Repeat measurements and report median plus variance rather than one run. Compare output values as part of the benchmark, since an incorrect optimization is not a speedup.

## Common mistakes and production notes

- Setting `threads` to every logical CPU without testing other workloads on the host.
- Setting `memory_limit` equal to all system RAM and starving Python or the OS.
- Assuming every operator can spill or that spill makes arbitrary queries safe.
- Writing tiny Parquet files or partitioning on extremely high-cardinality columns.
- Comparing a query that returns a scalar with one that transfers millions of rows to Python.

Observe process RSS, CPU utilization, disk throughput, and the temporary directory alongside query profiles. Keep free disk capacity for spill and output. If a workload consistently needs a cluster, shared service, or massive concurrent ingestion, move it to an architecture designed for that requirement rather than indefinitely tuning a single host.

## Avoiding accidental work

`SELECT *` can force decoding and transfer of wide payload columns a report never uses. Explicit projections reduce scan, memory, and host conversion. Filter on partition columns in their native type, and avoid wrapping them in casts or functions unless the plan confirms pruning. Return only what the application consumes; use Arrow or record batches for bulk interchange.

High-cardinality grouping needs state proportional to distinct groups, not only input bytes. A few billion rows and a few dozen groups differs radically from nearly one group per row. Estimate key cardinality and inspect aggregate output. A larger memory cap may postpone failure but does not remove oversized state.

Spill competes with source reads and output writes. Put temporary files on a volume with capacity and throughput, monitor free space, and avoid undersized ephemeral container storage. Clean abandoned temporary data only after the engine releases it; do not delete active spill files.

## A tuning sequence that avoids guesswork

1. Fix the input snapshot and confirm row counts and schema. 2. Profile the original query and note the largest operators. 3. Reduce unnecessary columns and rows, then inspect join cardinality. 4. Check Parquet layout and file count. 5. Observe memory and spill volume. 6. Adjust one setting or query shape and repeat with the same output assertion.

This order matters because a slow query often has a data-shape problem rather than a configuration problem. A many-to-many join may create a massive relation; no thread setting repairs that. A remote glob with thousands of objects may spend time discovering files; more CPU threads do not reduce object-store request latency. A large Python fetch may dominate after DuckDB finishes.

When comparing formats, account for compression CPU, storage speed, and selectivity. A highly compressed file can reduce I/O but increase decompression cost. The fastest format depends on whether the bottleneck is disk, network, CPU, or repeated parse work. Keep benchmark data and query projections representative of production.
