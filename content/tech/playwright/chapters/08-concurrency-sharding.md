# Concurrency and Sharding

Browser suites can take hours if every test runs serially, but adding workers is not free parallelism. Each browser page consumes CPU, memory and network capacity. Tests may also contend for the same account, database rows, ports or rate-limited dependencies. Concurrency should follow test isolation and resource budgets, not an arbitrary worker count.

## Parallelism in pytest

Pytest itself runs tests sequentially unless a plugin such as `pytest-xdist` is installed and enabled. With xdist, `pytest -n auto` can distribute tests across worker processes, but “auto” derives a worker count from available resources and can oversubscribe a constrained CI container. Start with a measured fixed value, such as two or four workers, and compare wall time, failure rate and peak memory. The browser process and Python worker processes both consume resources.

The pytest-playwright plugin provides browser fixtures per test context; fixture scope and plugin configuration influence how browser processes and contexts are reused. Confirm the exact behavior of the installed versions before assuming one browser is launched for each test or each worker. Keep mutable state isolated per test. A new context isolates browser storage but does not isolate server-side records or a shared test account.

Parallel-safe test data needs a namespace: use a unique run ID and worker identifier in created resource names, or provision separate accounts per worker. Avoid tests that depend on “the latest record” or on another test deleting shared data. When possible, make setup idempotent and cleanup tolerant of partial failures. If a test mutates a shared global preference, either serialize that subset intentionally or move it to an isolated tenant.

## Sharding a large suite

Sharding divides a suite across multiple CI jobs. In Python, xdist distributes within one invocation; CI sharding often partitions files or test identifiers across jobs using the CI system's matrix or a dedicated pytest plugin. Design the partition so every test runs exactly once in the intended workflow. A naive split by filename may be uneven when one file contains most of the slow cases. Historical durations can guide balanced shards, but duration-based assignment needs stable test identifiers and careful handling of new tests.

Keep shard output independently diagnosable. Each job should report its shard ID, selected tests, browser engine, commit and failure artifacts. Merge JUnit reports only after preserving the original per-shard results. Retries can be helpful for collecting evidence, but a retry that passes should remain visible as flaky rather than being silently counted as a clean first-pass success.

For browser-engine coverage, decide whether to run every test in each browser or split coverage by risk. Parametrized cross-browser tests multiply work quickly. Many suites run a high-value smoke path in all supported engines and deeper coverage in the primary engine, while browser-specific defects receive targeted cases. This is a portfolio decision: every engine that matters to users needs real coverage, but duplicating every test may not be the highest-value allocation.

## Async concurrency is not test isolation

The async API allows concurrent waits and independent browser work within a Python event loop. However, launching concurrent actions against the same page can create order-dependent state. One navigation can invalidate another operation's assumptions. Use separate pages or contexts for independent actors, and coordinate explicit events when a flow requires simultaneous actions.

Likewise, launching many browsers from a single async function does not automatically make a test suite faster. It can saturate CPU, exhaust file descriptors or overwhelm an application under test. Bound concurrency with a semaphore or worker limit. Consider service capacity, not just test runner capacity.

## Diagnosing concurrency failures

A test that passes alone and fails under xdist often reveals hidden shared state. Reproduce with two workers, then inspect external resources: shared account, static fixture file being overwritten, fixed port, singleton test database, or an application-wide rate limit. A browser crash or timeout under load may instead indicate host pressure. Track memory and CPU, and rerun at a lower worker count to distinguish contention from a logical race.

The answer is not always to disable parallelism. If the test has a genuine global dependency, document the serialization boundary and keep the rest parallel. If there is an accidental dependency, isolate it. Broad test retries can hide both defects.

## Common mistakes

- Treating the number of CPU cores as a safe browser worker count.
- Reusing one backend account and allowing parallel tests to overwrite shared state.
- Sharding without checking that the union of shards includes each test exactly once.
- Hiding intermittent failures with automatic retries and no flake reporting.
- Running simultaneous UI actions on one page without a coordination condition.

## Production notes

Measure suite time and resource use at each concurrency setting. Set worker counts explicitly in memory-limited CI and include a serial rerun for diagnosis, not as a substitute for isolation. Make test data unique and cleanup observable. A well-sharded suite has balanced duration, complete coverage, failure artifacts per shard and a clear distinction between first-run failures and retry outcomes.

## Budget more than the browser count

A worker consumes more than the browser's base memory. The page's JavaScript heap, video or trace recording, image processing, test fixtures, application containers and pytest itself all contribute. A CI job may run several services on the same host, leaving less capacity than the runner's advertised total. Measure peak use during a representative busy test, not only at idle. Leave headroom for occasional large pages and startup spikes.

Network pressure matters too. If each browser test opens several pages and each page triggers multiple API calls, a modest worker count can generate a burst against the test deployment. That can cause throttling that looks like random page slowness. A per-worker concurrency cap or a test-data setup queue may be more effective than increasing server timeouts. For tests that depend on external systems, reduce or mock calls where the test objective does not require a live dependency.

## Shard selection and reporting

A shard assignment should be deterministic for a given commit and configuration. Record the selected node IDs and the sharding rule so a missing test can be traced. If you split by test duration, handle tests without historical measurements explicitly and avoid allowing one slow case to dominate a shard. Keep a complete test inventory and periodically compare it with the union of shard reports.

When a shard fails, the job should upload its own JUnit XML and diagnostics even if another shard is still running. A merged report is useful for an overview, but individual results preserve context like worker and environment. Do not let a failed shard disappear because a later merge step ran with only successful artifacts. Validate the CI workflow itself by deliberately exercising a failure path in a safe test branch.