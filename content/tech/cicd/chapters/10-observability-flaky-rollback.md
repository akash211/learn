# Pipeline Observability, Flaky Builds and Rollback Drills

A pipeline is production infrastructure. It has an availability target, a latency distribution, a
failure mode and a blast radius, and it deserves the same monitoring as the services it deploys.
The difference is that its users are engineers, so its failures are measured in lost hours rather
than lost revenue — until a rollback is blocked, at which point they become the same thing.

## What to measure

Two families of metrics, and they answer different questions.

**Delivery outcomes**, the four DORA measures:

| Metric | Definition | What it diagnoses |
|---|---|---|
| Deployment frequency | Deploys to production per unit time | Batch size; how reversible change feels |
| Lead time for changes | Commit → running in production | Pipeline duration plus queue plus approval wait |
| Change failure rate | Deploys requiring rollback or hotfix | Test and gate effectiveness |
| Time to restore | Incident start → service restored | Rollback readiness |

**Pipeline health**, which explains the outcomes:

- Queue time and execution time, separately, at p50 and p95.
- Success rate per workflow, and per stage within it.
- Flake rate: runs that fail and then pass on the same commit with no change.
- Cache hit rate per cache, and cold-build duration.
- Cost per run, if the platform bills by minute.
- Approval wait time, which is often the largest term in lead time and the least instrumented.

A single number worth putting on a wall is the p95 of the pull-request pipeline. It predicts
whether developers wait for CI or merge around it, and it degrades slowly enough that nobody
notices without a chart.

## Instrumenting a pipeline

Most CI systems emit run events you can export; the cheapest useful version is a nightly job that
queries the API and writes one row per run into a table:

```bash
gh run list --limit 200 --json databaseId,workflowName,conclusion,createdAt,updatedAt,headSha \
  > runs.json
```

With `createdAt` and `updatedAt` you get duration, and with `headSha` you can detect flakes — a
commit with both a failed and a successful run of the same workflow. Annotating deploys in your
monitoring system (a deployment marker on the service's dashboards) is the other half: it turns
"latency rose at 14:20" into "latency rose four minutes after digest 4b1e shipped".

## Flaky tests

A flaky test is a test whose outcome depends on something other than the code under test. The
definition matters because it determines the response: the test is not "sometimes failing", it is
*reporting a nondeterminism that exists somewhere* — in the test, in the fixture, or in the system.

Detection is mechanical. Group runs by commit and workflow; a commit with at least one pass and one
fail of the same job is a flake. Over a few weeks this produces a ranked list, and the ranking is
usually concentrated: a small number of tests account for most of the noise.

The response that works:

1. **Quarantine automatically.** A test that fails on the same commit twice, or fails and passes
   across reruns, is moved to a quarantine suite that runs but does not gate. This keeps the main
   signal trustworthy without deleting coverage.
2. **Assign an owner and a deadline.** A quarantined test with no owner is a deleted test with extra
   steps. Two weeks to fix or delete is a workable policy.
3. **Fix the cause, not the symptom.** The usual causes are real sleeps instead of condition waits,
   shared mutable state, ordering dependencies, unmocked clocks, and assertions on timing. A
   `sleep(2)` that "fixes" a flake is a slower flake.
4. **Retry only where the cause is environmental**, and report retries as a metric. Retrying a
   network call to a service container is defensible; retrying a logic assertion is hiding a bug.

Blanket `retry: 3` on a whole suite is the anti-pattern: it converts a 2% flake rate into a
pipeline that is green and a test suite nobody trusts, and it hides genuine races that will
eventually surface in production where there is no retry.

## Flaky pipelines

Tests are not the only nondeterminism. The pipeline itself has failure modes that look like flakes:

- **Infrastructure.** Registry rate limits, a full runner disk, a transient DNS failure pulling a
  base image. These are real and retryable, and should be distinguished from test failures in the
  report.
- **Time.** A test or build that behaves differently near midnight, at month boundaries, or in a
  different timezone. Pin `TZ=UTC` and inject the clock.
- **Shared environments.** Two workflows deploying to the same staging namespace, or two jobs
  writing to the same cache key.
- **Cache poisoning.** A branch writes a cache entry that the default branch restores, and the
  build is wrong in a way that reproduces only on one machine.
- **Ordering.** A test that depends on files created by another test, or on alphabetical order.

The diagnostic is the same in every case: find the run where it passed and the run where it failed,
and diff the inputs. If the commit is identical, the difference is environment, time or state — and
one of those is always findable.

## Rollback drills

A rollback path that has never been executed is a hypothesis. The failure mode is predictable: the
rollback command references a digest that was garbage-collected, or the previous version cannot
start against the migrated schema, or nobody has the permission at 3 a.m.

A drill is cheap and takes under an hour:

1. Pick a service and a recent deploy. Record the current digest and the previous one.
2. Announce a window, then execute the rollback exactly as the runbook says, with a timer running.
3. Measure four things: time to notice (if you simulate a failure), time to decide, time to
   execute, and time to confirm recovery.
4. Restore forward, and record what was missing — permissions, a runbook step, an alert.

Do this quarterly, and after any change to the deploy mechanism. The interesting finding is almost
never "the rollback failed"; it is "the rollback took nineteen minutes because the person with
permission was in a meeting" or "the previous digest had been pruned by the retention policy".

Prerequisites a drill will expose:

- The previous digest is still pullable, and retention keeps every currently-deployed digest.
- The schema is compatible with the previous code (chapter 8).
- The rollback does not require a second approval path that nobody has configured.
- There is a kill switch for anything a rollback cannot fix — a feature flag, a queue pause, a
  third-party integration toggle.

## Runbooks

Write the rollback procedure before the incident, and keep it where the on-call engineer is already
looking — a link in the alert, not a wiki page three clicks away. The useful content is short:

- How to identify what is deployed (the digest, not the tag).
- The exact rollback command, with the variables filled in for this service.
- What the rollback does *not* fix (schema, data, external side effects).
- Who can approve, and the path when they are unavailable.
- How to confirm recovery, with the specific metric and a threshold.

## Postmortems that change something

The output of an incident review is not a document; it is a set of changes to the pipeline. Useful
actions are specific and testable — "add a `lock_timeout` to migrations", "gate the deploy on the
SBOM being published", "quarantine `test_checkout_flow` and assign it to the payments team" — rather
than "improve testing discipline". Track them like any other work, with owners, or the same incident
recurs with a different service name.

## Common mistakes

- Measuring pipeline duration without queue time, then optimising the wrong half.
- Blanket retries that make the pipeline green and the suite meaningless.
- Quarantining flaky tests with no expiry, which is deletion with extra steps.
- A rollback plan that depends on a tag rather than a digest.
- Retention policies that prune the digest currently running in production.
- No deploy markers in monitoring, so incident timelines have to be reconstructed from chat.
- Treating pipeline failures as a tooling problem rather than a production risk.

## Production notes

Publish one dashboard with pipeline p50/p95, success rate, flake rate and approval wait, and review
it in the same meeting where you review service health. Keep a small set of deliberately failing
tests in a non-blocking job, so the alerting and reporting paths are exercised continuously. And
when a deploy goes badly, resist the urge to add a gate first — ask whether the pipeline could have
known, and if the answer is yes, add the check; if the answer is no, improve the rollback instead.
