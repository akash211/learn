# Build Caching, Parallelism and Speed

Pipeline speed is a feature, but not for the reason it is usually sold. Fast pipelines are
*safer*: developers run them before pushing, reviewers wait for them instead of merging around
them, and a rollback is not blocked behind a twenty-minute queue. Slow pipelines get bypassed,
and every bypass is a control that no longer exists.

## Two clocks, measured separately

Every run has a queue time and an execution time. On a busy organisation the queue frequently
dominates: a six-minute pipeline can take half an hour to start because the runner pool is
saturated by a nightly job. Optimising the six minutes while the wait is twenty-four is wasted
work, so measure both and plot them separately. Most CI providers expose both per run; if yours
does not, the difference between the trigger timestamp and the first step's start is the queue.

## What is worth caching

| Cache | Key | Typical win | Risk |
|---|---|---|---|
| Package downloads | lockfile hash + OS | Large on cold runners | Stale index, poisoned wheel |
| Compiler/object cache | source hash + flags | Large on incremental builds | Silent incorrect output |
| Container layers | parent + instruction + inputs | Large | Secret baked into a layer |
| Whole build outputs | commit + inputs | Very large | Hides nondeterminism |
| Test results | test id + code hash | Moderate | Tests silently skipped |

The rule that separates a safe cache from a dangerous one: **the cache may only contain what a
deterministic function of the key would produce**. If a cache entry could be wrong without the key
changing, the pipeline has a correctness bug that appears as "it passed in CI but the release is
broken".

## Cache keys

A cache key is a claim about content. It must include everything that can change the cached
output and nothing that changes without affecting it. For dependency caches that means the
lockfile hash plus the OS and architecture; for compiler caches it means the source hashes, the
compiler version and the flags.

```yaml
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cache/pip
            ~/.cache/uv
          key: py-${{ runner.os }}-${{ hashFiles('uv.lock') }}
          restore-keys: py-${{ runner.os }}-
```

Two properties of `actions/cache` shape the design. Entries are immutable, so a key that already
exists is never updated — the hash in the key is what makes new content produce a new entry.
And `restore-keys` fall back to a prefix match, which restores the newest compatible entry and
lets the install step repair the difference; that is a warm start, not a guarantee.

`hashFiles()` only works inside a job after checkout, and it returns an empty string when nothing
matches — which silently produces a constant key. A cache that never misses is usually a cache
whose key never changes.

## Container layer caching

Docker's layer cache is the highest-leverage cache in most pipelines, and its rules are covered in
the Docker module: a layer is keyed by parent plus instruction plus inputs, `COPY` hashes file
contents while `RUN` hashes only the command string, and BuildKit's cache mounts sit outside the
layer graph.

In CI the problem is that runners are ephemeral, so the local cache is always cold. The answer is
a remote cache:

```bash
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/acme/api:buildcache \
  --cache-to   type=registry,ref=ghcr.io/acme/api:buildcache,mode=max \
  --push -t ghcr.io/acme/api:sha-4f2c1ab .
```

`mode=max` exports intermediate stages as well as the final image, which is what makes multi-stage
builds fast; `mode=min` exports only the layers of the final image. The registry-backed cache costs
storage and push time, and pays for itself the first time a base-image layer is reused instead of
rebuilt.

A common mistake is putting `COPY . .` before the dependency install because "it is simpler". That
single line invalidates the install layer on every commit, and no amount of remote cache helps,
because the key genuinely changed.

## Cache mounts and the local case

`RUN --mount=type=cache,target=/root/.cache/pip` keeps downloaded packages outside the layer
graph: they survive rebuilds on the same builder, are never pushed, and are not exported by
`--cache-to`. On a persistent self-hosted builder this is the single biggest win. On ephemeral
hosted runners it does nothing, because the builder is new each time — a distinction worth knowing
before spending an afternoon on it.

## Remote action caches

Build systems with content-addressed action caches — Bazel, Turborepo, Nx, Gradle's build cache —
go further: they key each task on its declared inputs and cache the *outputs*, so an unchanged
task is not executed at all. The win is large, and the prerequisite is hermeticity. A task that
reads an undeclared file, an environment variable or the network will produce a cache hit whose
output does not match the inputs, and the resulting bug is extremely hard to find because the
build "worked" and the artefact is wrong.

If you adopt one, start by making the dependency graph explicit and running with the remote cache
disabled in one nightly job, so a hermeticity bug shows up as a difference between the two.

## Parallelism and the critical path

Total pipeline time is the longest path through the graph, plus queue. Adding parallel jobs
shortens the path only if they were on it. A pipeline that runs twelve linters in parallel while
a single eight-minute integration suite sits on the critical path has optimised the wrong stage.

Practical levers, in order of effect:

1. **Move work off the critical path.** Test shards, multi-arch builds and security scans can all
   run concurrently with a build if they do not depend on it.
2. **Shard the long pole.** Split tests by file or by timing (`pytest --splits 4 --group 1`,
   `-n auto`, or one job per directory). Balance by measured duration, not by test count.
3. **Cut redundant work.** `paths-ignore` for docs, a concurrency group that cancels superseded
   runs, and `needs` ordering so a failed lint never starts the build.
4. **Right-size the runner.** More cores help a compiling or test-parallel workload and do nothing
   for a pipeline waiting on a registry pull or a single-threaded link step. Check what is
   actually saturated before paying for bigger machines.

Amdahl's law is the honest framing: speeding up a stage that is 20% of the runtime by half buys
10%, no matter how impressive the individual number looks.

## What not to cache or parallelise

- **Secrets.** Caches are shared across branches in most systems; a cache containing a token is a
  leak with a long tail.
- **Build outputs with no content-based invalidation.** A cache of `dist/` keyed on the branch
  name will serve yesterday's bundle after a source change.
- **Stateful test fixtures.** A database snapshot that predates a migration produces failures that
  look like application bugs.
- **Deploys.** Parallel deploys to one environment are not a speed optimisation, they are a race.

## Measuring

Per-step timing is the only way to know where the time goes; intuition is reliably wrong. Look at
p50 and p95 separately — the median tells you what developers experience on a good day, the tail
tells you what happens when the cache misses and the registry is slow. Track cache hit rate per
cache, and treat a hit rate near 100% as suspicious rather than excellent.

A useful target is that the *pull request* pipeline finishes in under ten minutes at p95, because
that is roughly the threshold where a developer waits rather than switching tasks. The merge
pipeline can be longer if it runs the expensive stages, and the release pipeline can be longer
still.

## Common mistakes

- Optimising execution time while the queue is the bottleneck.
- A cache key without a content hash, freezing dependencies at the first run.
- `COPY . .` before dependency installation.
- Assuming `--mount=type=cache` helps on ephemeral runners.
- Sharding tests by count, producing one shard that takes three times as long as the rest.
- Caching `dist/` and shipping a stale bundle.
- Adding runners to fix a pipeline whose critical path is one sequential job.

## Production notes

Keep a dashboard of pipeline duration by stage, cache hit rate and queue time, and review it when
it moves rather than when someone complains. Put a duration budget in the repository — a comment
in the workflow file with the current p95 and the date — so regressions are visible in review.
And run one job per week with a cold cache and no remote cache, because that is the only way to
know the pipeline still works when the cache layer is unavailable.
