# Installation, the CLI, and Embedding

DuckDB is easiest to adopt when installation follows the workload. Analysts can use the CLI or a notebook; an application can embed a language binding; a deployment can link the C/C++ library. The engine is the same family of software, but lifecycle, result APIs, and extension availability differ by distribution.

## Python package and first connection

Install the Python distribution in the environment that runs the job, pinning a tested version in a lockfile. A simple session uses an in-memory database; passing a filename makes the catalog and tables persistent across runs.

```python
import duckdb

con = duckdb.connect("analytics.duckdb")
con.execute("CREATE TABLE IF NOT EXISTS runs (id INTEGER, label VARCHAR)")
con.execute("INSERT INTO runs VALUES (1, 'first')")
print(con.execute("SELECT * FROM runs").fetchall())
con.close()
```

`duckdb.connect(':memory:')` explicitly requests an ephemeral database. `duckdb.connect('analytics.duckdb')` opens or creates a file. Close connections deliberately in long-lived applications; a context manager is a convenient resource boundary. A connection is not a remote client handle: it owns a local engine instance and its work uses the process's resources.

Python offers convenient interchange: `fetchone`, `fetchall`, `fetchdf`/`df`, Arrow methods, and registered Python objects or dataframes. The best choice depends on result size. Fetch a scalar or small summary as Python objects; for large results choose Arrow or batch iteration rather than building a huge list of tuples. Registration can expose a dataframe or Arrow object as a relation for a query, without first copying it into a permanent table, though conversion, lifetime, and materialization semantics should be understood.

## CLI workflow

The DuckDB command-line client is useful for exploration and scripts. It can open an in-memory database or a file, execute SQL, and write query output using SQL `COPY` or CLI output options. A representative session is:

```sh
duckdb analytics.duckdb
```

Then SQL can inspect data and plans interactively:

```sql
SELECT count(*) FROM read_parquet('data/*.parquet');
EXPLAIN SELECT region, sum(revenue) FROM read_parquet('data/*.parquet') GROUP BY region;
```

CLI flags and packaged binaries vary by installation method and platform, so check `duckdb --help` for the installed build instead of assuming an option from a different release. A CLI is excellent for one-off analysis and reproducible SQL files, but a scheduled pipeline should record the executable version, input paths, and output behavior explicitly.

## Other host languages

DuckDB has official clients and integrations for Python, R, Java, Node.js, Go, and other environments, in addition to its C and C++ interfaces. The APIs are not identical: check the documentation for the binding version and its supported result formats. A language binding is an embedded engine, not a remote connection pool to a common server. Multiple application processes each have their own DuckDB instance, which matters when they target the same database file.

For an application, place a small repository or service layer around SQL. It can control connections, parameter binding, file access, extension installation, and query limits. Parameterize values rather than building SQL with string concatenation. Table names and file paths generally need separate validation because SQL parameters do not substitute arbitrary identifiers or path syntax in every context.

## Extensions: capabilities and deployment

Extensions are separately packaged components that add features or integrations. Common examples include `httpfs` for HTTP/S3-compatible file access, `postgres` for PostgreSQL, and readers for formats such as Iceberg or Delta Lake in supported releases. Installation and loading are separate concepts: `INSTALL httpfs;` retrieves an extension into the local extension directory; `LOAD httpfs;` activates it for a connection. Supported extensions may autoload on first use, but controlled deployments should explicitly install, pin, and test them.

Extension binaries are version- and platform-sensitive. The typical workflow uses the official repository and requires network access at install time. An offline or locked-down deployment needs a pre-populated extension directory and a compatible binary. Do not treat an extension downloaded at runtime as harmless SQL syntax: it is executable native code with access granted by the process. Restrict untrusted users' ability to install/load code and access local or remote paths.

```sql
INSTALL httpfs;
LOAD httpfs;
SELECT * FROM read_parquet('https://example.org/data.parquet');
```

This example assumes the relevant extension is available and remote access is permitted. Credentials should use DuckDB secrets or the environment's credential mechanism, not committed SQL files or logged connection strings. Validate the precise authentication and endpoint configuration for the target object store.

## Persistence, paths, and testing

A common test pattern uses an in-memory connection and creates fixtures with SQL. For integration tests, use a temporary database file under the test's temporary directory, then close the connection before cleanup. This catches persistence and path behavior that an in-memory-only unit test will miss. Test with a small data sample and assert schema, row counts, null handling, and representative aggregates rather than asserting a brittle physical plan string.

Paths deserve attention: relative paths resolve against the process working directory, which may differ between a notebook, CLI, and scheduler. Use explicit project-relative resolution or absolute paths in jobs, and parameterize the root. Avoid placing a database file on an unsupported or unreliable network filesystem without understanding locking and filesystem semantics.

## Common mistakes

- Assuming `:memory:` persists between script invocations. It does not.
- Assuming installing the Python package installs the CLI binary or every extension.
- Assuming every client binding exposes the same methods and extension set.
- Fetching all rows into Python when Arrow or SQL-side aggregation is appropriate.
- Allowing arbitrary SQL to install extensions or read secrets and local files.

## Production notes

Pin and report both the DuckDB version and extension versions; execute a startup smoke query for every required extension. Keep credentials outside source code and avoid rendering secrets in SQL logs. For command-line jobs, fail on SQL errors and write outputs atomically where possible; `COPY TO` is an overwrite operation, so choose unique destinations or a deliberate replacement policy. Close connections in cleanup paths so file locks are released promptly.

## Parameters, connection scope, and reproducibility

Bind data values rather than interpolating them into SQL. Python's DB-API style supports parameterized execution, for example `con.execute("SELECT * FROM t WHERE id = ?", [wanted_id])`. This prevents values from being parsed as SQL and handles quoting safely. Parameters generally cannot replace identifiers such as table names; map user choices to allowlisted identifiers instead. Validate paths independently because they are an access-control decision.

A connection also carries settings and transaction state, so avoid hidden cross-request state in a long-lived process. Make transaction boundaries explicit, set session configuration deliberately, and decide whether query failure rolls back related work. In notebooks, hidden state can make reruns depend on old tables or an already loaded extension; a clean-kernel test reveals those assumptions.

For CLI jobs, keep SQL in reviewed files and pass input/output roots through controlled configuration. Record `SELECT version()` in logs. Re-run the job in a fresh process as an integration check: it catches reliance on a notebook registration, cached extension, or working-directory-specific path.
