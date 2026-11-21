# GitHub Actions as CI

GitHub Actions runs workflows defined in YAML in the repository, triggered by events on the
repository. It is not a general-purpose job server: the unit of work is a **workflow run**, made
of **jobs**, each on a fresh **runner**, made of **steps**. Understanding that hierarchy, and what
each job does *not* share with the others, explains most pipeline bugs.

## The shape of a workflow

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
  merge_group:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        python-version: ["3.11", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
          cache: pip
      - run: pip install -r requirements-dev.txt
      - run: pytest -q
```

Each job gets a fresh virtual machine (or container). Nothing on disk, no environment variables
and no installed packages carry over between jobs. Files must move through **artifacts** or be
rebuilt. That is the single most important mental model: jobs are isolated, steps within a job are
not.

## Triggers that matter

| Event | When it fires | Notes |
|---|---|---|
| `pull_request` | PR opened, synchronised, reopened, labelled | Runs in the PR's merge commit context; no secrets for forks |
| `push` | A branch or tag is pushed | Fires on merge to `main`; also on force-push |
| `merge_group` | A PR enters a merge queue | Required if the repo uses a queue |
| `workflow_dispatch` | Manual run | Can take typed `inputs` |
| `schedule` | Cron, UTC | Best-effort; can be delayed |
| `release` | Release published/created | Useful for publishing artefacts |
| `workflow_run` | Another workflow completes | Runs with base-repo privileges; treat inputs as untrusted |

`pull_request` has activity types; the default is `opened`, `synchronize`, `reopened`. Adding
`types: [labeled]` replaces the default set rather than extending it — a common cause of "CI
stopped running on new commits".

Path filters are efficient but interact badly with required checks: a workflow skipped by
`paths:` never reports, so a required check by that name stays pending and blocks the merge. Keep
the required workflow unfiltered, or add an always-running job that reports the same name.

## Permissions and secrets

`GITHUB_TOKEN` is created per job. Its scopes come from the `permissions:` block, and the default
may be permissive depending on repository settings — set it explicitly and start from read-only:

```yaml
permissions:
  contents: read
  pull-requests: write   # only if the job comments on the PR
  id-token: write        # only for OIDC cloud auth
```

Secrets are not available to workflows triggered from forks, and the `secrets` context cannot be
used in an `if:` conditional at job level. Promote the secret to a job-level `env` and test the
env var instead, or gate on `github.event.pull_request.head.repo.fork == false`.

Prefer OIDC over long-lived cloud keys:

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/gha-deploy
      aws-region: eu-west-1
```

The job exchanges a short-lived GitHub-issued token for temporary cloud credentials. Nothing
long-lived is stored in the repository, and the trust policy can restrict which repo, branch and
environment may assume the role.

## Caching and artifacts

They solve different problems and are frequently confused.

| | Cache | Artifact |
|---|---|---|
| Purpose | Reuse dependencies between runs | Move files within or between jobs |
| Keyed by | Explicit key + restore keys | Name |
| Lifetime | Evicted, not guaranteed | Retention period, downloadable |
| Scope | Branch-aware; immutable once written | Workflow run |

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/pip
    key: pip-${{ runner.os }}-${{ hashFiles('**/requirements*.txt') }}
    restore-keys: pip-${{ runner.os }}-
```

Caches are immutable: once a key exists, a later job writing the same key does not update it. If
the key does not include a hash of the dependency files, stale caches are served forever. For
Python and Node, the `cache:` input on `setup-python`/`setup-node` is simpler and does the same
thing.

Artifacts are how a build job hands a wheel, a binary or a coverage report to a later job:

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: dist-${{ matrix.python-version }}
    path: dist/*.whl
```

Artifact names must be unique per run; v4 rejects two uploads with the same name. Include the
matrix value, as above.

## Services and integration tests

A job can start service containers alongside it:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

Steps reach it on `localhost:5432`. Wait for the health check, not a fixed `sleep`; the container
is up before the first step only in the sense that it has been started.

## Reusable workflows vs composite actions

A **composite action** bundles steps into one `uses:` unit and runs inside the caller's job, with
the caller's filesystem and environment. A **reusable workflow** is a whole workflow invoked with
`workflow_call`, with its own jobs and runners, inputs and secrets.

```yaml
# .github/workflows/test.yml
on:
  workflow_call:
    inputs:
      python-version: { type: string, default: "3.12" }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "${{ inputs.python-version }}" }
      - run: pytest -q
```

```yaml
# caller
jobs:
  test:
    uses: ./.github/workflows/test.yml
    with:
      python-version: "3.12"
```

Use a composite action for "install and configure tooling"; use a reusable workflow for "run this
whole pipeline". Reusable workflows cannot reference the caller's `env` implicitly, and secrets
must be declared or passed with `secrets: inherit`.

## Shell behaviour and injection

The default shell on Linux is `bash -e {0}` — it stops on a failed command but does **not** set
`-u` or `pipefail`. Set it explicitly when it matters:

```yaml
- run: |
    set -euo pipefail
    ./scripts/build.sh | tee build.log
  shell: bash
```

Never interpolate untrusted context directly into `run:`:

```yaml
# injectable: a PR title containing $(curl ...) executes
- run: echo "${{ github.event.pull_request.title }}"
```

```yaml
# safe: the value arrives as data in an environment variable
- run: echo "$PR_TITLE"
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
```

The same applies to branch names, issue bodies and commit messages. Expressions are substituted
into the script text before the shell parses it.

## Debugging a failing run

- `gh run list --workflow ci.yml`, `gh run view <id> --log-failed`.
- Re-run with debug logging by setting the `ACTIONS_STEP_DEBUG` secret to `true`.
- `actions/upload-artifact` the logs a failing step produced; the web log truncates.
- Reproduce locally with `act` for simple workflows, or by running the same container image and
  commands — environment differences (missing tools, case-sensitive paths, no `sudo`) are the
  usual cause of "passes locally, fails in CI".

## Common mistakes

- Expecting files from a previous job to exist. They do not.
- Caching a key that does not include dependency hashes, then debugging phantom version skew.
- `permissions: write-all` because a step needed one scope.
- Required checks on a path-filtered workflow, leaving PRs permanently unmergeable.
- Interpolating PR titles or branch names into `run:`.
- `sleep 10` instead of a health check for service containers.
- Using `pull_request_target` and checking out the PR head — arbitrary code with secrets.

## Production notes

Keep the required set small: lint, unit tests, build. Put slow integration suites behind labels or
a nightly schedule. Set `timeout-minutes` on every job, because the default is generous and a hung
step burns runner minutes. Add `concurrency` so a new push cancels the previous run on the same
PR — but do not cancel deployments mid-flight; give those a group without `cancel-in-progress`.

Pin third-party actions to a commit SHA if you care about supply chain integrity: a tag is mutable
and whoever controls the action's repository can move it. First-party `actions/*` tags are a
reasonable trade-off; anything else should be pinned and reviewed.
