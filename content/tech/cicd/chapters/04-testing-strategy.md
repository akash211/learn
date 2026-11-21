# Test Strategy Inside a Pipeline

Tests in a pipeline exist to answer one question cheaply: *is this change safe to promote?* That
framing kills most arguments about test types. A test earns its place by catching a class of
defect that no cheaper test catches, and the pipeline runs it at the point where its cost is
justified.

## The shape of the suite

The pyramid — many unit tests, fewer integration tests, very few end-to-end — is directionally
right and frequently misapplied, because it optimises for test count rather than for confidence
per minute. A more useful framing is by *what each layer can see*:

| Layer | Catches | Typical runtime | Runs on |
|---|---|---|---|
| Format, lint, types | Syntax, style, obvious type errors | Seconds | Every push |
| Unit | Logic errors in isolation | Under a minute | Every push |
| Component / integration | Wire format, SQL dialect, transactions, serialisation | Minutes | Every push or PR |
| Contract | Consumer/provider drift across services | Seconds per pair | PR, plus provider verification |
| End-to-end | Wiring, auth, routing, real infrastructure | Tens of minutes | Pre-merge or pre-deploy |
| Smoke | The deployed thing answers | Under a minute | Every deploy |

Two things follow. First, a defect that only an end-to-end test can find is usually a defect in
*integration*, not in logic — so the cheaper fix is often a component test that exercises the
real database, not another browser scenario. Second, the end-to-end suite's value is
disproportionate to its size: five scenarios covering login, the main transaction, and the
failure path catch more real regressions than fifty variations of a form.

## Static checks first, always

Lint, format and type checks take seconds and fail on a large share of the mistakes that would
otherwise reach review. Their pipeline value is not code quality; it is *early exit*. A pipeline
ordered `lint → unit → build → integration` almost never runs the expensive stages for a typo.

Make the strictness a decision, not a default. `mypy --strict` on a new service is cheap;
retrofitting it on a hundred-thousand-line codebase is not. Enforce formatting with the formatter
itself (`ruff format --check`, `gofmt -l`, `prettier --check`) rather than arguing about it in
review.

## Unit tests: fast, deterministic, no network

The unit layer must be able to run on a laptop with the network unplugged. That constraint forces
the design that makes tests fast: dependencies injected rather than imported at module scope, time
and randomness passed in rather than read from the clock, and no module-level database
connections.

Flakiness at this layer is almost always one of four causes: real time (`datetime.now()`),
uncontrolled randomness, shared mutable state between tests, or ordering assumptions. All four are
fixable with the same discipline — inject the clock, seed the RNG, build fixtures per test, and
never rely on filesystem ordering.

## Integration tests: the database is the test

Most production bugs that unit tests miss live at the boundary with a real system: a Postgres
feature the ORM does not emulate, a transaction isolation behaviour, a JSON serialisation
difference, a unique constraint that fires in a different order. Testing against SQLite when
production is Postgres is worse than not testing, because it produces false confidence about
exactly those behaviours.

The practical recipe:

- Start the real dependency per job or per test session (Testcontainers, a CI service container,
  or a container started by a fixture).
- Apply the *real migrations* to build the schema. A test schema created by `create_all()` tests a
  schema that does not exist in production.
- Create a database or schema per worker, not per test, and truncate between tests; creating a
  database per test is slower than the test.
- Never share a database across parallel workers without schema isolation — the failures are
  intermittent and look like application bugs.

```yaml
    services:
      db:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-retries 10
```

The health check matters more than it looks: a container that is *started* is not a container that
*accepts connections*, and without `--health-cmd` the first test races the server's startup.

## Contract tests: the only cheap defence between services

Once a service consumes another's API, end-to-end tests become a poor tool — they need every
service running, they fail for reasons unrelated to the change, and they tell you *that* something
broke rather than *what*. Consumer-driven contract testing inverts the dependency:

1. The consumer writes expectations (a pact) and publishes them to a broker.
2. The provider's pipeline verifies the pact against its own implementation on every build.
3. A deploy is allowed only if `can-i-deploy` says every consumer's verified pact is compatible
   with the version being promoted.

The payoff is that a provider change which would break a consumer fails *in the provider's
pipeline*, before deployment, without running the consumer at all. The cost is infrastructure (a
broker), discipline (pacts must be published from the consumer's main branch), and the fact that
contracts verify shape and interaction, not semantics.

For event-driven systems the same idea exists as schema compatibility: a registry that rejects a
new schema version which breaks backward compatibility (removed field, narrowed type, renamed
key) catches the class of bug that would otherwise surface as a consumer crash days later.

## End-to-end and smoke

End-to-end tests belong against an ephemeral environment built from the same artefacts that will
deploy, not against a shared staging system that three teams are also using. Shared staging
produces failures that cannot be attributed and teaches everyone to ignore the suite.

Keep the count small and the paths critical: authentication, the primary write path, one read
path, one failure/retry path. Run them after deploy as well as before — a smoke test that hits
`/health` and performs one real transaction is the difference between "the rollout completed" and
"the service works".

Retries in an end-to-end suite are a sedative. A test that passes on the second attempt is
reporting a real race that will eventually happen in production; chapter 10 covers how to
quarantine it instead of hiding it.

## Selecting what to run

Large monorepos cannot run everything on every change, so pipelines select: map changed paths to
projects (`nx affected`, Turborepo, Bazel, or a hand-written mapping), and run the affected
project's tests plus the tests of its dependents.

Selection is a real trade-off. Get it wrong in the permissive direction and pipelines are slow;
get it wrong in the restrictive direction and a shared library change ships without testing its
consumers — a failure mode that is invisible until production. Two mitigations: always run the
full suite on the merge to the default branch, and make the dependency graph explicit rather than
inferred from directory names.

## Coverage, mutation, and other numbers

Line coverage is a weak signal that is easy to game and easy to misread. It is still worth
tracking as a *trend*, and worth gating on a *diff* basis: new or changed lines should be
covered, because untested new code is where regressions concentrate.

Mutation testing answers the question coverage pretends to — would the tests notice if the logic
were wrong? — at a runtime cost that usually limits it to a nightly job over the most critical
modules. If a team has never run it, one run on the payment or auth module is usually enough to
find several assertions that assert nothing.

## Common mistakes

- Testing against SQLite, then shipping to Postgres.
- A test schema built by ORM metadata rather than migrations.
- Shared staging used as the integration environment, so failures are unattributable.
- End-to-end suites used to catch logic errors that a unit test would catch in milliseconds.
- `continue-on-error` on the test job so a red build looks green.
- Coverage thresholds on generated code, or on the whole repository, which reward the wrong work.
- Tests that depend on execution order, wall-clock time, or a shared fixture mutated by an earlier
  test.

## Production notes

Treat test runtime as a budget and defend it: a suite that grows past ten minutes stops being run
locally, and a suite nobody runs locally loses the feedback loop that made it valuable. Run the
suite in parallel by shard (`pytest --splits`, `-n auto`, or per-directory jobs), but keep each
shard's fixtures independent. And make the failure output useful — a JUnit XML report plus the
captured logs, uploaded with `if: always()`, turns "test failed in CI" into a link that answers
the question.
