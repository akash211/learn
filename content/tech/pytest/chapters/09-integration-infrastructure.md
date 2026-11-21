# Slow Tests, Databases, and Containers

Integration tests exercise real boundaries and often cost more time and operational effort than unit tests. A database, broker, or container can reveal driver, SQL, network, and lifecycle problems that a fake cannot. The challenge is maintaining isolation and repeatability while provisioning infrastructure without making the entire suite slow or destructive.

## Choose what must be real

A test should cross the smallest boundary that proves its claim. A repository unit test may use a fake to check domain logic; a database integration test should use the actual engine to verify migrations, constraints, transaction behavior, and SQL dialect. A containerized test does not automatically prove production parity: image versions, extensions, configuration, and deployment topology matter.

Use markers such as `integration` to categorize tests, then make the default local path explicit. Keep some integration tests in required CI if they protect critical compatibility. A separate nightly suite is useful for broad scenarios, but should not be the only place a critical schema regression is detected. Tests must not silently connect to a developer's production database. Require a dedicated test URL or provision an isolated instance, validate the target database name, and fail closed when configuration looks unsafe.

## Transaction isolation and cleanup

Database tests commonly isolate writes by opening a transaction per test and rolling it back. This is fast and effective if all work uses the same connection and transaction. A service that opens its own connection, commits internally, or spawns workers can escape the rollback boundary. Nested transactions or savepoints may help, but their behavior is database- and driver-specific. Confirm isolation with a test that writes data and another test that verifies it is absent afterward.

A session-scoped engine or database can reduce startup time, while function-scoped transactions preserve test isolation. Fixture teardown must roll back even when assertions fail. Close sessions and connections in `finally` or yield teardown. Avoid tests whose correctness depends on sequence IDs restarting unless the database is explicitly reset; transactional rollback does not necessarily revert sequences.

When testing migrations, begin from a known schema version and apply the migration chain against the real engine. Creating tables directly from ORM metadata does not test migration scripts. For repository code, assert persisted behavior after a fresh session or connection when the claim includes commit visibility. Do not assert only on in-memory ORM objects that have not been flushed or reloaded.

## Testcontainers and lifecycle

Testcontainers for Python can start disposable service containers, such as PostgreSQL, for tests. Pin image versions rather than using a moving `latest` tag; configure readiness waits and supply explicit connection details. A container fixture can be session-scoped for infrastructure, but databases, schemas, and transactions usually need per-test isolation.

```python
import pytest
from testcontainers.postgres import PostgresContainer

@pytest.fixture(scope="session")
def postgres_url():
    with PostgresContainer("postgres:16") as postgres:
        yield postgres.get_connection_url()
```

This example starts a container only if the Docker-compatible runtime is available and the image can be obtained. In offline CI, restricted environments, or remote Docker configurations, it may fail before tests start. Provide a clearly documented infrastructure prerequisite or a deliberate skip policy; do not catch every startup error and mark the suite green. Cleanup must happen even if the test run is interrupted as far as the container library and runtime allow. Avoid depending on random host ports or container internals outside the returned connection string.

A container is not inherently isolated if all tests share one schema and mutable data. Use unique schemas/databases, transactions, truncation with careful foreign-key ordering, or per-test containers depending on cost and semantics. Parallel execution adds concurrency: fixtures and test data must be namespaced per worker, and a shared container needs a per-test isolation strategy. A session fixture is normally session-per-worker under distributed execution, not a global resource across all workers.

## Slow suites and timing

Do not mark tests slow to hide poor control of time. Replace arbitrary sleeps with polling for a condition and a finite deadline, use deterministic clocks for business time, and wait on explicit signals. For timing behavior that truly matters, test bounds with generous tolerances and isolate machine-load assumptions. Avoid exact duration assertions in ordinary CI.

Long integration tests should emit enough context to identify their stage: provisioning, migration, request, cleanup. Use `pytest-timeout` only with awareness of its platform and interruption behavior; a timeout can leave external resources behind. Record structured diagnostics without logging credentials. Keep setup failures distinguishable from application test failures.

## Common mistakes

- Running integration tests against a database URL taken from a general developer environment.
- Assuming rollback undoes commits on a different connection or sequence allocation.
- Using container tags that move, allowing CI runs to test different service versions.
- Sharing one mutable schema across workers without namespacing or reset.
- Catching infrastructure startup errors and converting them to skips with no signal.

## Production notes

A trustworthy database suite documents the engine version, setup requirements, safety checks, and cleanup guarantees. Keep the service container lifetime long enough to amortize startup, but isolate data at a narrower scope. Validate migrations against the actual production engine family and version range. When a test requires network or Docker, make that requirement explicit in the test category and CI job; never let a missing dependency silently erase important coverage.

## Test a real boundary without making every check end-to-end

An integration suite should have a named purpose: verify migrations, dialect-specific queries,
constraint behavior, serialization through a driver, or transactional semantics. Avoid turning it
into an uncontrolled copy of production. Use deterministic seed data and assert only the contract
under study. For example, a migration test should begin from a known previous schema and verify
that the upgraded schema supports application queries; it need not generate thousands of unrelated
business records.

Database teardown should be designed for failure. If setup creates a schema and then migration
fails, cleanup should still find and drop that schema. Use unique names to avoid deleting other
workers' data, and ensure identifier construction is safe for the database dialect. Containers
should expose logs on failure, because a readiness timeout or migration exception often requires
server-side diagnostics. Keep secrets out of command output and use test-only credentials.

Runtime budgets can be improved by separating provisioning from per-test reset, but benchmark the
actual suite rather than assuming a scope change is faster. A long-lived container may reduce
startup overhead, while expensive truncation of many tables may not. Parallelizing can either
reduce wall time or overload a single database and increase retries. Record test duration by
category and optimize slow setup only after isolation guarantees are clear.

## Distinguish container cleanup from application cleanup

A container library can stop the service process, but the test still owns application-level
resources such as pools, sessions, and background workers. Close those before stopping the
container so teardown does not generate misleading connection errors. If cleanup fails, preserve
the first test error and report cleanup diagnostics separately; a teardown exception can otherwise
obscure the assertion that originally failed.

For tests that use a container's dynamically assigned port, always retrieve the mapped connection
from the container helper rather than assuming the service's internal port is exposed unchanged on
the host. Readiness should verify the database is accepting the type of connection the test uses,
not merely that a TCP port has opened. When tests run in restricted CI, make runtime requirements
part of job configuration and fail with a clear infrastructure message before collecting a large
suite. Keep local skip behavior opt-in and never let required CI silently skip the database tests.