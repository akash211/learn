# CI Integration and Flaky-Test Triage

A CI test job is a repeatable environment for collecting evidence on a change. It should run the same test selection and dependency versions that contributors can reproduce locally, preserve useful reports on failure, and fail for the right reason. A green badge is only meaningful if the intended tests were collected and the environment did not mask errors.

## A reliable pipeline shape

A simple pipeline begins with environment setup, dependency installation, collection and test execution, then report upload. Pin Python versions and test dependencies with the project's lock or constraints strategy. Install the package as it is intended to be consumed—often editable for development—and run the canonical command from repository root.

```bash
python -m pytest -q -ra --junitxml=artifacts/junit.xml
```

CI should keep the exit status from pytest even if artifact upload or report conversion runs afterward. Configure the upload step to run on failure so tracebacks and JUnit output survive a red job. If using `pytest-cov`, generate a report even when tests fail, but distinguish partial coverage from a complete passing run. Do not pipe pytest through another command that hides its nonzero status; if piping is needed, enable shell `pipefail`.

Use separate jobs or stages for quick unit tests and environment-heavy integration tests when that improves feedback or parallelism. Make dependencies between jobs explicit and ensure the required status checks include every suite that protects a merge. A job that never runs on pull requests cannot serve as a pull-request quality gate. Likewise, a marker filter that selects zero items should normally fail or be caught through collection checks rather than turn the job green.

Cache package downloads to reduce install time, but do not cache mutable test state such as database directories or `.pytest_cache` as a correctness dependency. Dependency caches need keys that include lockfile and Python version. A cache hit should affect speed only, not behavior. Keep credentials limited to jobs that need them and never expose secrets to untrusted pull-request code.

## Parallelism and reproducibility

`pytest-xdist` can distribute tests with options such as `-n auto`, but parallel execution reveals shared state and can make a test's hidden assumptions visible. Tests must not share a fixed temporary filename, global database rows, or process-wide mutable services without coordination. A session-scoped fixture is generally initialized per worker process, and resource consumption can multiply. Measure the whole CI job rather than assuming more workers means faster wall time.

Randomized ordering can uncover order dependence; `pytest-randomly` is one plugin that can randomize tests and report a seed. Use a seed to reproduce a discovered failure, then remove the coupling rather than permanently pinning a lucky ordering. Pytest's own collection order is not a safe communication mechanism. Tests must establish their own required state and clean it up.

Keep local and CI invocations aligned. Differences in Python minor version, timezone, locale, operating system, environment variables, database version, or installed plugin versions can explain failures. Record these dimensions in the job output. Avoid declaring a test flaky solely because it passes locally; reproduce it in the same environment and gather evidence.

## Flaky-test triage

A flaky test has outcomes that vary without a relevant code change. Begin by identifying the unit of nondeterminism: test ordering, scheduling, clock, random input, network, shared service, filesystem assumptions, or resource pressure. Capture the failing node ID, seed, worker, environment, logs, and surrounding events. Re-run the specific test and then the smallest relevant group under the same conditions. Repeatedly rerunning the whole suite without recording context often destroys useful evidence.

Common causes include race conditions, fixed sleeps, reuse of global state, real network calls, unclosed background tasks, assuming dict/set order, and deadlines that are too tight for loaded CI workers. Replace time sleeps with synchronization, random external data with controlled fixtures, and shared external state with namespaced resources. For a race, test the desired ordering with events or barriers and consider whether production code has a real synchronization defect.

A rerun can be a temporary containment measure, not a fix. A retry plugin or CI rerun policy may let a transient infrastructure failure avoid blocking unrelated work, but it can also hide a deterministic defect. Report retry counts, retain the original failure log, assign an owner, and set a removal date for quarantine. Do not mark every intermittent failure `xfail`; flaky is not the same as an expected failure with a known condition.

## Common mistakes

- Uploading reports only on success, so a failing job loses its evidence.
- Running different test selections locally and in CI without documenting why.
- Parallelizing before fixing shared state and then treating the race as a runner defect.
- Retrying until green and ignoring the first failure's traceback.
- Treating a skipped or empty suite as success without checking collection.

## Production notes

CI should give a developer a reproducible command, a precise failing node ID, and retained diagnostics. Pin tool versions, expose Python and service versions, and make test selection visible. For flakes, preserve the first failure, replay with the same seed and environment, fix the nondeterministic boundary, and track any temporary retry or quarantine to closure. Reliability comes from eliminating uncontrolled inputs, not from making the pipeline tolerate more red-to-green reruns.

## Make reporting preserve the real exit status

Shell pipelines can accidentally replace pytest's exit code with the status of a later command.
If output is piped through `tee`, enable `set -o pipefail` or capture the status explicitly. Report
conversion should run after the test command without turning a failed test into a successful job.
In workflow systems, use an always-run artifact step that still respects the required test step's
failure. JUnit XML may be incomplete if pytest crashes or is interrupted, so retain the raw log as
well as the structured report.

Make empty selection visible. CI should log the exact pytest command and any environment-derived
marker expression. A typo in a variable can change `-m` selection or point at a different test
path. Print resolved configuration without secrets and confirm a known sentinel test or expected
category was collected. If a suite is split across jobs, maintain a clear mapping from each job to
the tests it owns and the merge protection that requires it.

When investigating an intermittent CI-only failure, compare environment details rather than only
source code: Python version, dependency lock, operating system, database image, locale, timezone,
worker count, and resource limits. Pin down which differences are causal by changing one at a
time. A good flake report includes a minimal reproduction, evidence from the original failure, and
a concrete owner; a green rerun alone is not a resolution.

## Flake budgets and suite signals

Track first-attempt failures separately from final job status. Useful signals include retry count,
flaky test rate by node ID, suite duration, and the number of skipped or quarantined items. These
measurements do not replace diagnosis, but they make it harder for a growing retry rate to become
invisible. Do not set arbitrary universal thresholds; establish a baseline and investigate
sustained changes.

A quarantined test should retain an executable issue reference, an owner, and a target for
restoration. Prefer moving it to an explicit quarantine job over deleting it from all workflows,
so it continues to produce evidence without blocking unrelated changes. That job should still
surface failures and notify the owning team. Remove the quarantine when the nondeterministic input
is controlled and the test passes reliably under the normal required path.