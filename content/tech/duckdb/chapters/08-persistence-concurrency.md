# Persistence, Transactions, and Concurrency

DuckDB can be ephemeral or persistent. Choosing a database file gives the process a catalog and durable tables; opening an in-memory database gives a clean scratch space that disappears when the instance ends. The distinction should be explicit in applications and tests because it determines recovery, sharing, and cleanup.

## In-memory and file-backed databases

`duckdb.connect(':memory:')` creates an in-memory database. `duckdb.connect('analytics.duckdb')` opens or creates a native database file. Tables created in memory do not survive a new process; tables in a file persist after the connection closes. The file is a DuckDB database format, not a collection of independent Parquet files; use `COPY` to export interoperable data.

A persistent database is suitable for a local analytical cache, desktop application, reproducible project, or embedded reporting store. Back it up as a database artifact using a supported approach and test restore. Do not copy a live database file at an arbitrary instant and assume that copy is a consistent backup; coordinate access or use documented backup/export mechanisms appropriate to the version.

Attach additional databases when a workload needs to query multiple catalogs or organize data. `ATTACH` and `DETACH` operate on connections and have their own locking, alias, and read/write considerations. For interchange between database files, DuckDB provides database-copy/export workflows; for broad ecosystem compatibility, export tables to Parquet or CSV.

## Transactions and atomicity

DuckDB supports transactions with `BEGIN TRANSACTION`, `COMMIT`, and `ROLLBACK`. Group related modifications so they succeed or fail together. A transaction protects operations within the DuckDB database; it does not automatically coordinate writes to an external Parquet file, S3 object, or PostgreSQL table into one distributed atomic commit.

For file outputs, write to a new destination and publish only after validation when the workflow requires an atomic handoff. A SQL transaction cannot roll back an already-visible external side effect. Likewise, `COPY TO` overwrites a destination, so retry safety must be designed around unique run paths, staging and rename/publish steps, or explicit replacement semantics.

## Concurrency model

DuckDB is designed to be embedded in a process. Within one process, multiple connections and threads can read and write under the engine's concurrency controls; concurrent transactions that modify conflicting rows can encounter conflicts. Append-heavy concurrent work in one process is different from many independent application processes opening the same database read-write.

The native database file is not a general multi-process write service. The supported sharing patterns include a single process owning read-write access and multiple processes reading in read-only mode when no process is writing. Do not run several unrelated writers against the same file or assume read-only readers can safely overlap an active writer without checking the documented mode for the deployed release. File locks and filesystem behavior are part of the safety model; network filesystems can have different or unreliable locking semantics.

For many concurrent clients, independent writers, or a database that must be reached over a network, use a client-server database such as PostgreSQL or a managed warehouse. DuckDB can still be embedded in a worker that reads a published snapshot, performs analytics, and writes its own outputs. The architecture boundary is about ownership and coordination, not merely the number of SQL connections.

## Thread safety and application design

Connections have state, including current transaction and settings. Avoid casually sharing one connection across unrelated tasks without checking binding-specific thread-safety guidance. A disciplined pattern gives each task an appropriate connection and keeps ownership explicit. Limit `threads` when several DuckDB instances or other CPU-heavy jobs share the host.

Long-running apps should manage connection lifetimes and file access centrally. Decide how deployments handle schema migrations, interrupted writes, lock errors, and startup recovery. Use a migration table or versioned DDL rather than applying ad hoc schema changes on every request. Keep external data and extension access constrained.

## Persistence choices

- **Memory database:** isolated test fixtures, temporary transformations, short-lived analysis. No durability after process exit.
- **Native `.duckdb` file:** embedded persistent tables and local catalog; best with a clear process owner.
- **Parquet/CSV export:** interchange, snapshots, and lake-style storage managed outside the database.
- **PostgreSQL/warehouse:** shared service, multiple processes, user access control, and coordinated concurrent writes.

A common pattern is to maintain a native DuckDB file as a local cache and refresh it from a source. Record the refresh timestamp and source watermark. If a refresh fails halfway through, transactionally replace managed tables or build a new database and swap it into service using a safe platform-specific mechanism. Do not leave readers uncertain about which snapshot is complete.

## Common mistakes and production notes

- Expecting an in-memory database to survive process termination.
- Treating one-process concurrent writes as permission for several processes to write the file concurrently.
- Assuming a transaction covers a Parquet write or remote PostgreSQL side effect.
- Copying a live database file as a backup without consistency guarantees.
- Placing a database on a network share without testing locking and durability behavior.

Document who owns read-write access, how read-only readers start, and what a restore looks like. Test lock contention and conflict handling under realistic load. If the requirement is a durable shared service with independently deployed clients, select a server database rather than stretching an embedded database beyond its concurrency model.

## Conflict handling and lifecycle

Within a process, optimistic concurrency lets independent transactions proceed without serializing every read. If two transactions modify overlapping data, one may fail with a conflict instead of silently overwriting the other. Retrying is safe only when the transaction is idempotent and the application knows what committed. Keep external side effects outside retry loops or give them idempotency keys.

A read-only process can serve a published database, but coordinate when the writer replaces or updates the file. Open handles, locks, and filesystem guarantees affect when readers see new state. Test update and restart behavior on the actual OS and storage layer, especially network volumes or container bind mounts.

Durability is not backup. Keep versioned backups or reproducible source data, practice restore, and retain metadata to rebuild derived tables. For pipelines regenerated from Parquet and SQL, storing manifests and code revisions may be more useful than copying an unverified stale file.

## Choosing the right writer boundary

A single-writer rule is easiest to satisfy when one scheduled job owns the file and publishes completed snapshots for readers. If the application needs readers and one embedded writer in the same process, connections can coordinate through DuckDB's transaction support. If separate replicas each need write access, adding a shared volume does not create a safe distributed database; the design needs a service that arbitrates transactions.

Also distinguish logical persistence from filesystem durability. A committed transaction can still be lost if the volume is ephemeral or the host fails before durable storage guarantees apply. Select persistent storage, backups, and recovery objectives explicitly, then test them.
