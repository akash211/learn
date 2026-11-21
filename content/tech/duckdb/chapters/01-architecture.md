# Architecture: The Analytical Engine in Your Process

DuckDB is a database engine, but unlike PostgreSQL it is not normally a server that listens on a port. The process that imports the Python package, runs the CLI, or embeds the C++ library also hosts the query engine. That architectural choice explains its low setup cost, its excellent locality, and its limits around multi-process writes.

## Embedded, not “just a library”

A connection owns a database instance and exposes SQL execution, transactions, catalogs, and result conversion. An in-memory connection creates transient state; a file-backed connection reads and writes a native DuckDB database file. Either way, there is no mandatory daemon, network round trip, or separate service lifecycle. A Python program can open a connection, run SQL, fetch Arrow batches, and close it in one process.

In-process does not mean that every byte must be in RAM. Persistent database pages are read from storage, and supported operators can spill intermediate state to a temporary directory. Nor does it mean that every source is copied into the database: a query may scan CSV or Parquet in place. The practical footprint is the host process, its buffers, temporary files, and any persistent database file it chooses to maintain.

This makes embedding useful for developer tools and applications: deployment is a package plus files rather than a database service. It also couples the engine's resource use to the host. A notebook query can consume the notebook's CPU and memory; an embedded service must budget DuckDB alongside its application and must isolate untrusted SQL and paths appropriately.

## Columnar storage and execution

DuckDB is designed for OLAP: read a subset of columns across many rows, filter, group, join, and return a smaller result. Its native storage organizes data in column-oriented row groups, while execution operators process vectors (batches) rather than making one virtual call per row. A scan of `SELECT sum(amount) FROM sales` can decode the needed column without materializing every unrelated field as a row of objects.

Vectors are the engine's working units. Operators consume and produce batches, allowing tight loops and amortizing dispatch and expression evaluation. A filter produces a selection of qualifying rows; a projection computes only requested expressions; an aggregate maintains group state. The design is still relational SQL: the optimizer chooses the plan and the execution engine runs it. It is not equivalent to loading a pandas DataFrame and executing a Python loop.

Columnar layout is particularly helpful for scans and aggregates, but does not make all tasks free. A query that sorts a huge result, groups by a high-cardinality key, or repeatedly materializes wide intermediate results may be limited by memory, temporary I/O, or CPU. Small point lookups and tiny row-by-row updates do not exploit the same advantage as wide analytical scans.

## Vectorized execution versus row-at-a-time work

A row engine repeatedly visits tuples and their fields; a vector engine applies an operation over a batch. If a query adds a discount to millions of values, vectorized arithmetic avoids per-row language dispatch. Batches also work well with SIMD-friendly operations, compression, and cache locality. DuckDB's SQL expressions stay inside the engine, so the optimizer can combine scans, filters, and projections without crossing into Python for each row.

The Python boundary matters. `con.execute(...).fetchall()` turns results into Python objects, which is convenient but expensive for a large result. Prefer an aggregate in SQL, `fetch_arrow_table()` for Arrow consumers, or `fetch_record_batch()` when streaming batches. Likewise, pandas/Arrow integration is useful for handoff, but repeated conversion between dataframe representations is real work. Keep large transformations in SQL when it expresses them clearly.

## Parallelism and the single-host model

DuckDB parallelizes operators over available threads, subject to the shape and size of the work. A large file with enough row groups can offer substantial scan parallelism; a tiny table or a single serial step cannot use every core. `SET threads = n` controls the worker-thread setting. More threads are not always faster: they may compete with a host application, saturate storage, or increase memory pressure for blocking operators.

The engine's ambition is one machine, not a disguised distributed cluster. It does not distribute a hash join across a fleet, recover lost executors, or hide network shuffles behind a cluster scheduler. When the dataset and intermediate state fit the resources of one host—or can be processed with supported out-of-core execution—this is a simpler trade. When throughput requires scale-out, Spark or a warehouse may be the right boundary.

## Database file versus external data

DuckDB's native file is a persistent database with catalog and table storage, not simply a renamed Parquet file. It supports transactional updates within its intended process model. Parquet is an interoperable immutable columnar file format that other engines can read. Use a native database when local persistence and database semantics are useful; use Parquet when interchange, lake layout, and direct reads across tools are central. A query can read Parquet and write a curated DuckDB table or a new Parquet dataset.

A useful design distinction is managed versus external data. A DuckDB table is managed by the database and participates in its catalog and transaction mechanisms. A file scan reads data at a path, whose lifecycle and concurrent mutation are governed by the filesystem or object store. Do not assume that a query over a path has the same atomicity as a transaction on a native table.

## Common mistakes

- Treating embedded as “single-threaded.” One process can execute parallel work and multiple connections can run queries; the important restriction is process-level coordination for database-file writers.
- Treating DuckDB as a distributed database. Threads and spill extend one host, not a cluster.
- Fetching a multi-gigabyte result into Python because the engine handled the scan efficiently. Result conversion and process memory still matter.
- Assuming Parquet files are transactionally protected by DuckDB. They remain external objects.

## Production notes

For embedded apps, make ownership explicit: which process opens the database read-write, where temporary files live, how connections close, and what users may query. Monitor the full process, not only SQL duration, because memory includes host allocations and conversion buffers. For reproducibility, pin the DuckDB version and extension set; plans and extension capabilities can change across releases. Choose DuckDB when its local execution model is a feature, not merely because a benchmark on one query looked fast.

## Why locality wins—and where it stops winning

An embedded query avoids a client/server hop and can consume an Arrow object already present in the host process. That is valuable for a report over a few files: there is no upload step, catalog provisioning, or cluster spin-up. But locality is only an advantage when data is reachable and the compute budget is sufficient. A 500 GB scan over a laptop SSD can still be slower than a managed warehouse with parallel storage and many workers. Compare data transfer, startup, contention, and service cost, not just SQL operator speed.

A vector is an internal batch, not a promise that an entire column fits in memory. Data flows through pipelines as chunks; some operators stream, others retain state. A simple projection can process a large file in bounded memory while a sort or high-cardinality grouping needs much more. Returning one aggregate is often cheap compared with returning every row, even when both queries scan the same input.

For embedding, make data access part of the threat model. A process with access to a user's home directory or cloud credentials may expose them if untrusted SQL can use file readers or extensions. Restrict paths and external access; “no server port” does not mean “no security boundary.”
