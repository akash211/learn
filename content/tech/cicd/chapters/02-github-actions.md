# GitHub Actions in Depth

GitHub Actions is a general-purpose scheduler bolted onto a git host. Once you stop reading it as
YAML and start reading it as a job graph with contexts, most of its behaviour becomes predictable:
what runs in parallel, what each job can see, where the credentials come from, and why the same
workflow behaves differently on a pull request from a fork.

## The object model

Three levels, each with its own scope:

- A **workflow** is a file in `.github/workflows/*.yml`. It has triggers, permissions, a
  concurrency group and a set of jobs.
- A **job** runs on one runner, with its own filesystem and its own copy of `GITHUB_TOKEN`. Jobs
  are independent unless `needs` links them, and they never share a workspace.
- A **step** is a process (`run`) or an action (`uses`) inside a job. Steps share the workspace
  and the environment of their job, and run sequentially.

The consequence people trip over first: `cd`, `export` and files written in one job do not exist
in the next. Anything crossing a job boundary is an artefact, a cache entry, an output, or a
registry object.

## Triggers

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
    paths-ignore: ['docs/**', '**.md']
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]
  schedule:
    - cron: '0 3 * * 1'
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        required: true
```

`pull_request` runs the workflow from the *merge commit*, in the context of the base repository
but with a read-only token and no secrets — which is why fork PRs cannot deploy, and why
`pull_request_target` (which does have secrets) is a security trap covered in chapter 9. `push`
and `pull_request` both fire for a branch with an open PR, so a branch push usually produces two
runs unless you filter one of them.

`paths` filters are a useful cost control and a reliable source of missing checks: if a shared
library changes a file outside the filter, the job that tests its consumers never runs. Filter
only directories that genuinely have no consumers.

## A reference workflow

```yaml
name: ci
on:
  push: { branches: [main], tags: ['v*'] }
  pull_request: { branches: [main] }

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  PYTHON_VERSION: '3.12'

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        python: ['3.11', '3.12']
        db: ['postgres:15', 'postgres:16']
        exclude:
          - python: '3.11'
            db: 'postgres:16'
    services:
      db:
        image: ${{ matrix.db }}
        env:
          POSTGRES_PASSWORD: postgres
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
          cache: pip
      - run: pip install -r requirements-dev.txt
      - run: pytest -q --junitxml=reports/junit.xml
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-${{ strategy.job-index }}
          path: reports/
```

Four things are doing quiet work here. `permissions: contents: read` shrinks the token to what
the job needs, because the default in many repositories is broader than a test job should have.
`concurrency` cancels a superseded pull-request run, which is correct because only the newest
commit's result matters — and would be wrong for a deploy. `services` starts a database as a
sibling container on the job's network, addressed on `localhost` through a published port, with a
health check so the step list does not race the database's first startup. `if: always()` uploads
the report even when the tests failed, which is the only time anyone reads it.

`fail-fast: false` is the other important default to change. With fail-fast on, the first red
matrix leg cancels the rest, so you learn about one broken combination per run instead of all of
them. For a matrix that exists to find incompatibilities, that is exactly backwards.

## Matrix semantics

A matrix is a cartesian product of the listed axes, then modified by `include` and `exclude`.
`exclude` removes whole combinations. `include` is subtler: an entry that matches an existing
combination *adds keys* to it, while an entry that matches none *creates a new job*. That is how
you add one extra configuration without expanding the product:

```yaml
    strategy:
      matrix:
        python: ['3.12']
        include:
          - python: '3.13'
            experimental: true
            continue-on-error: true
```

`continue-on-error` marks a leg as allowed to fail: it shows as failed while the workflow does
not. Use it for a new runtime you want visibility on, never for a suite you have given up on.

## Caching, precisely

Caches are an optimisation with three properties worth memorising: entries are **immutable** once
written, they are **branch-scoped** (a branch can restore from its own and the default branch's
caches, not from a sibling branch), and they are **evictable**.

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          key: pip-${{ runner.os }}-${{ hashFiles('**/requirements*.txt') }}
          restore-keys: |
            pip-${{ runner.os }}-
```

Because entries are immutable, `key` must change whenever the content changes — hence the hash.
`restore-keys` are prefix fallbacks: they restore the newest entry matching the prefix, which
gives you a warm start even on a miss, at the cost of a stale environment that the install step
must then correct. A cache key that never changes is the classic bug: the first run writes a
dependency tree, and every later run restores it forever, silently testing old libraries.

A full cache is also a correctness risk: a cache holding the build directory can resurrect object
files whose sources were deleted. Cache download directories and compiler caches, not build
outputs, unless the tool has real content-based invalidation.

## Artefacts

Artefacts are the durable output: test reports, coverage, binaries, SBOMs. In `v4` they are
immutable — an upload to an existing name fails rather than appending, so names must be unique
per job. That is why the matrix job above names its artefact with `strategy.job-index` rather
than a constant.

```yaml
      - uses: actions/download-artifact@v4
        with:
          pattern: test-*
          merge-multiple: true
          path: reports/
```

Downloading by pattern, then merging, is how a fan-in job assembles reports from every leg.
Retention is configurable per repository and per upload; set it deliberately, because artefacts
count against storage and a sixty-day retention on a nightly build is a large bill for data
nobody opens.

## Outputs across jobs

A job publishes strings that downstream jobs read as `needs.<job>.outputs.<name>`. A step writes to
the `GITHUB_OUTPUT` file, the job maps step outputs into job outputs, and the consumer reads the
result:

```yaml
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - id: build
        run: |
          digest=$(crane digest "$IMAGE:$TAG")
          echo "digest=$digest" >> "$GITHUB_OUTPUT"
```

Everything is a string. Booleans and numbers survive only if you convert them back with
`fromJSON()`, so `if: needs.check.outputs.changed == 'true'` compares strings while
`if: fromJSON(needs.check.outputs.count) > 0` does not.

## Publishing with attestations

The publish job is where identity is created, so it needs more permission than the rest:

```yaml
  publish:
    needs: [test]
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: build
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/api:${{ github.ref_name }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: mode=max
          sbom: true
      - uses: actions/attest-build-provenance@v1
        with:
          subject-name: ghcr.io/acme/api
          subject-digest: ${{ steps.build.outputs.digest }}
          push-to-registry: true
```

`id-token: write` is what allows the job to obtain a short-lived OIDC token instead of storing a
cloud credential. `GITHUB_TOKEN` is scoped to this job and expires with it. `digest` — not the
tag — is the artefact's real name, and it is what the deploy job should carry forward.

## Reusable workflows versus composite actions

A **composite action** packages steps: `action.yml` with `runs: using: composite`, and a list of
`steps`. The caller keeps control of the job (runner, matrix, services) and inserts the steps.

A **reusable workflow** packages a whole job graph. The callee declares `on: workflow_call` with
`inputs`, `secrets` and `outputs`; the caller uses it as a job:

```yaml
jobs:
  build:
    uses: acme/ci/.github/workflows/build.yml@v3
    with:
      image: ghcr.io/acme/api
    secrets: inherit
```

Choose a composite action when you want to share *how a step is done*; choose a reusable workflow
when you want to share *which jobs run and in what order*. A reusable workflow cannot be combined
with `steps` in the same calling job, and it must live in `.github/workflows/`, which are both
consequences of it being a job, not a step.

## Common mistakes

- Assuming a `cd` or an `export` survives into the next job.
- A cache key with no hash, so dependencies are frozen at the first run.
- Uploading to a fixed artefact name from a matrix, which fails on the second leg under `v4`.
- `needs` omitted, so `publish` starts before the tests have finished.
- Deploying on `pull_request` and only discovering on the first fork PR that secrets are absent.
- Using a floating action tag (`@v3`) for third-party actions rather than a commit SHA.
- Putting a secret in `env` at workflow level, where every job — including ones running
  contributor code — can read it.

## Production notes

Pin third-party actions to a commit SHA and let Dependabot bump them; a tag is mutable and the
action runs with your token. Set `timeout-minutes` on every job, because the default is measured
in hours and a hung test suite will hold a runner indefinitely. Prefer `permissions: {}` at the
top and grant per job. And keep the workflow files small enough to read: a 900-line YAML file
nobody understands is a security boundary nobody can audit.
