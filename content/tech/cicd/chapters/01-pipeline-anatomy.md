# Pipeline Anatomy and Stages

A pipeline is a program with side effects. It reads a commit, produces an artefact, and changes
the world in a way that someone will eventually have to undo. Treating it as a sequence of shell
commands is what produces pipelines that work for a year and then fail in ways nobody can
explain. Treating it as a graph with explicit inputs, outputs and invariants is what makes it
maintainable.

## The graph, not the script

Every CI system models a run as a directed acyclic graph. The vocabulary changes — workflow, job,
step, stage, task — but the structure does not: nodes do work, edges express ordering and data
flow. The important property is that edges are the *only* ordering guarantee. Two jobs with no
edge between them run concurrently, so anything one produces for the other has to travel through
an explicit channel.

That is the first design decision in any pipeline: where the fan-out and the fan-in sit. A
typical shape is a short trunk (checkout, build) that fans out into independent checks (unit
tests, lint, image scan, contract tests) and then fans back in to a single publish job that runs
only if every check passed. Fan-out buys wall-clock time; fan-in is where you enforce the gate.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make test
  publish:
    needs: [build, test]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/publish.sh
```

`needs` is the fan-in. `publish` does not start until both parents succeed, and if either fails
it is skipped rather than failed — a distinction that matters when you read run history at 2 a.m.
Pipeline duration, meanwhile, is queue time plus the longest path through that graph, never the
sum of job durations.

## What each stage owns

Stages are not arbitrary groupings; each one answers a different question and produces a
different kind of output. Naming them by the question they answer keeps pipelines honest.

| Stage | Question it answers | Output | Typical failure |
|---|---|---|---|
| Trigger | Why is this running, for which commit? | A ref and a SHA | Wrong ref; duplicate runs on push and PR |
| Prepare | Is the toolchain the one we pinned? | A versioned environment | Floating `latest` tag; cache poisoning |
| Build | Does it compile into an artefact? | Image, wheel, binary, bundle | Nondeterministic dependency resolution |
| Verify | Does it behave? | Test and scan reports | Flaky tests; missing service dependency |
| Package | Is the artefact identifiable and attributable? | Digest, SBOM, signature | Rebuild instead of promote; unsigned output |
| Publish | Is it available where deployers look? | Registry entry | Tag collision; overwritten release |
| Deploy | Is the new version serving traffic? | A rollout | Readiness never reached; partial rollout |
| Verify deploy | Is it actually healthy for users? | Smoke result, SLI check | Green pods, broken behaviour |
| Promote | Should this identity move forward? | Approval record | Gate owned by nobody; rubber-stamping |

Two rules fall out of the table. First, **build and package belong to one stage** — an artefact
that is produced in one place and hashed in another is not the same artefact by the time it is
signed. Second, **deploy and verify deploy are separate stages**, because "the rollout finished"
and "the service works" are different claims, and only the second one licenses promotion.

## The artefact boundary

The single most consequential idea in delivery is *build once, deploy many*. The thing that
passes tests in staging must be byte-identical to the thing that runs in production. The only
handle for that identity is a content digest, not a tag: `registry.example.com/api@sha256:…`
cannot be re-pointed, while `api:1.4.2` can.

This has a hard consequence: any stage that "rebuilds for production" has broken the chain —
environment differences belong in configuration, never in a separate build. A Dockerfile taking
`--build-arg ENV=prod` produces a genuinely different image, so the tests covered an artefact that
was never shipped.

The artefact boundary also defines what a rollback is. Rolling back means pointing the deployer
at the previous digest, which only works if that digest is still in the registry. Retention
policy is therefore part of the safety story, not a storage-hygiene afterthought.

## Where state lives

Runners are ephemeral by design: hosted CI gives each job a fresh machine, while self-hosted
agents may persist a workspace, which is worse — a build can quietly depend on a file a previous
job left behind and fail only on a clean agent. Two channels exist for
carrying state between jobs, and confusing them causes most "it worked yesterday" incidents:

- **Artefacts** are the products of the build — test reports, binaries, coverage, SBOMs. They are
  the output of the pipeline and are retained for audit.
- **Caches** are an optimisation — dependency downloads, compiler output, layer stores. They may
  be evicted at any time and must never be required for correctness.

A pipeline that cannot run with an empty cache is broken. Test it by changing the cache key; if
the build fails rather than merely slows down, something is being smuggled through the cache.

## Idempotency and re-entrancy

Every stage will be run twice eventually — a retried job, a re-run of a failed workflow, a
duplicate webhook. The question is whether the second run is safe.

- A build should produce the same digest from the same inputs. If it does not, find the
  nondeterminism: a timestamp baked into a binary, an unpinned dependency, a `git describe` that
  depends on the clone depth.
- A publish should be idempotent by identity: pushing the same digest twice is a no-op, while
  pushing a *new* digest under an existing tag is a silent overwrite.
- A deploy should be declarative — apply this digest — not incremental, so re-running it
  converges rather than duplicating.
- A migration should be forward-only and guarded, which chapter 8 treats in detail.

The practical test is a re-run of the whole pipeline for an old commit. If it produces a
different artefact or an inconsistent environment, the pipeline is not a function of its inputs.

## Failure semantics

Fail-fast is the right default for checks and the wrong default for cleanup. GitHub Actions
expresses the distinction with status functions:

```yaml
      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-reports
          path: reports/
```

Without `if: always()`, the diagnostic you need is exactly the one that never gets uploaded.
The same applies to teardown of ephemeral environments and to notifying a chat channel.

Partial success is the state to design against. A pipeline that fails *after* publishing leaves
an artefact in the registry that no run admits to producing; a pipeline that fails halfway
through a multi-service deploy leaves two versions live. The mitigations are ordering
(irreversible last), compensation (a cleanup job), and identity (everything tagged with the
commit SHA so orphans can be found and removed by a scheduled sweep).

## Triggers and concurrency

Triggers are where cost and correctness collide. Running everything on every branch push and every
pull-request event doubles work for no signal; running only on `main` hides breakage until after
merge. The compromise is a cheap subset on pull requests, the full pipeline on merge, and
expensive stages behind a tag or an environment.

Concurrency control is not optional once deploys are automated. Two runs deploying to the same
environment will interleave, and the loser may finish last and win. Every CI system now offers a
concurrency primitive; the rule is one group per environment with cancellation disabled for
deploys, and one group per branch with cancellation enabled for tests:

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false
```

For pull-request workflows the opposite is correct — cancel the superseded run, because only the
latest commit's result matters.

## Common mistakes

- Rebuilding the artefact per environment, so staging never tested what production runs.
- Using a tag as the deploy identity and re-pushing it.
- Making a cache entry load-bearing, so a cold cache is an outage.
- Letting a deploy stage run on a schedule or a stale branch because the `if` condition was too broad.
- No concurrency group, so two merges deploy in parallel and the older one lands last.
- Uploading test reports only on success, then having nothing to read when it fails.
- A single monolithic job, which hides which stage failed and prevents any parallelism.

## Production notes

Keep the pipeline definition in the repository and review it like application code — it has
production access, so it deserves the same scrutiny. Pin every third-party action and image by
digest or commit SHA; a moving major tag is remote code execution with your deploy credentials
attached. Give each stage a timeout so a hung job fails instead of occupying a runner for the
default hour. And keep one deliberately-broken branch or test that exercises the failure path, so
the alerting and cleanup logic is verified rather than assumed.
