# Production Concerns — Logs, Storage, Cleanup and CI

Everything up to here makes a container work. This chapter is about the four things that
eventually break a host that has been running containers for a year: unbounded logs, a full
`/var/lib/docker`, images nobody pruned, and builds that are slow, unreproducible or built
per-environment.

## Logging: stdout is the interface

Docker captures only `stdout` and `stderr`. That is the contract: the application logs to the
streams, the platform ships them. Anything written to a file inside the container is invisible to
Docker, invisible to the log pipeline, and — because the writable layer is not rotated — grows
until the disk is full.

The default driver is `json-file`, and by default it has **no size limit**. A service that logs a
few kilobytes per request writes hundreds of gigabytes over a month, and when `/var/lib/docker`
fills, the daemon itself starts failing: images cannot be pulled, containers cannot start, and
the error is `no space left on device` rather than anything about logging.

```json
// /etc/docker/daemon.json
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
```

The `local` driver is the better default in production: it is a binary format with built-in
rotation, it compresses well, and it is significantly cheaper to write than `json-file`. Setting
`max-size` and `max-file` on `json-file` achieves a bounded disk footprint too — the point is
that some bound must exist. Per-container overrides use `--log-opt max-size=20m --log-opt
max-file=5` on `docker run`, or `logging.options` in Compose.

For anything beyond a single host, the driver should ship to a collector (`fluentd`, `gelf`,
`awslogs`, `journald`) or — more commonly now — the application writes JSON to stdout and a
node-level agent (Fluent Bit, Vector, the cloud's log agent) reads the container log files and
forwards them. The agent approach keeps the daemon simple and survives driver changes.

## Storage: overlay2 and the disk it lives on

`docker info | grep "Storage Driver"` is the first thing to check on an unfamiliar host. `overlay2`
is the standard choice: fast, space-efficient through layer sharing, and supported on both ext4
and XFS.

Two constraints that bite in production:

- **XFS must be formatted with `ftype=1`.** Without it `overlay2` refuses to start with an
  `upper fs does not support d_type` error. This is a formatting-time decision, so discovering it
  after a migration means reformatting the volume.
- **There is no per-container disk quota by default.** A container writing to its writable layer
  can consume the whole filesystem. On XFS with project quotas, `--storage-opt size=10G` enforces
  a limit; on ext4 it does not. The general answer is to keep writable-layer writes to a minimum
  and mount volumes with their own filesystem or quota.

`overlay2` also has a hard limit on lower layers (around 125 per image chain, depending on page
size and kernel), which only matters for images with pathological history.

Moving `/var/lib/docker` to a dedicated volume is worth doing before it is necessary:

```json
{ "data-root": "/data/docker" }
```

Migrating means stopping the daemon and copying the directory — plan it, do not improvise it
during an outage.

## Cleanup: measure first

```bash
docker system df          # images, containers, volumes, build cache — reclaimable per category
docker system df -v       # per-image and per-volume detail
```

| Command | Reclaims | Safe on a prod host? |
|---|---|---|
| `docker image prune` | Dangling (untagged) images | Yes |
| `docker image prune -a --filter until=720h` | All unused images older than 30 days | Usually, but warm caches are lost |
| `docker builder prune --filter until=168h` | Build cache | Yes on build hosts |
| `docker container prune` | Stopped containers | Only after confirming nothing is stopped-but-wanted |
| `docker volume prune` | Unused volumes | **No** — a detached volume may be the only copy of data |
| `docker system prune -a --volumes` | Everything unused | **Never** on a host you have not just inspected |

The distinction that matters is between "unused" and "unwanted". A stopped container may be
stopped for a reason; a volume with no container attached may be a database waiting to be
re-attached. Automated pruning should be limited to dangling images and old build cache, with
volume cleanup left as a deliberate, reviewed action.

Registry-side retention is the other half. A registry with five years of images pays for storage,
pays for scanning, and gives responders a long list of unpatched things that *might* be running.
Keep the last N releases per repository plus anything deployed in the last 90 days.

## CI builds

The pipeline pattern that holds up:

```bash
docker buildx create --name ci --driver docker-container --use --bootstrap

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg GIT_SHA="$GITHUB_SHA" \
  --cache-from type=gha \
  --cache-to   type=gha,mode=max \
  --provenance=mode=max \
  --sbom=true \
  --push \
  -t "$REGISTRY/app:$VERSION" \
  -t "$REGISTRY/app:sha-$GITHUB_SHA" .
```

Points worth defending in review:

- **The `docker-container` driver, not the default.** It supports multi-platform builds, cache
  export and attestations; the default `docker` driver does not.
- **Cache in the CI system, not on the runner.** `type=gha`, `type=registry` or `type=s3` all
  survive an ephemeral runner; a local cache does not.
- **`--push` rather than `--load`** for multi-platform. `--load` only works for a single platform
  and silently drops attestations.
- **No secrets in `--build-arg`.** Use `--secret` (chapter 3). Build args are recorded in
  provenance, which is exactly the wrong place for a token.
- **One build, many deploys.** Promotion changes the digest a manifest points at, not the image.

Build time is a product decision. A cold build that takes fifteen minutes because every layer
misses is fifteen minutes of developer feedback lost, multiplied by every push. Cache export,
dependency-layer ordering, and a `.dockerignore` that excludes `node_modules` and `.git` are the
three changes that pay for themselves first.

## Daemon configuration worth setting deliberately

| Setting | Why |
|---|---|
| `log-driver`, `log-opts` | Bounded logs; the default is unbounded |
| `data-root` | Put images on a volume with room to grow |
| `live-restore: true` | Containers keep running through a daemon restart or upgrade |
| `default-address-pools` | Avoid subnet collisions with the corporate network |
| `userns-remap` | Root in the container is not root on the host (chapter 8) |
| `max-concurrent-downloads` | Throughput on slow links, without saturating them |

`live-restore` is underused: without it, upgrading Docker stops every container on the host.
It is incompatible with Swarm mode, which has its own handling.

`default-address-pools` prevents the classic failure where Docker's bridge networks overlap a VPN
or an office subnet, and containers mysteriously cannot reach internal services:

```json
{ "default-address-pools": [ { "base": "10.201.0.0/16", "size": 24 } ] }
```

## Monitoring what Docker does not tell you

`docker stats` is a live view, not a history. Production monitoring reads the same cgroup files
through cAdvisor or the node exporter, which gives per-container CPU throttling, memory working
set, OOM events and restart counts as time series. The metrics that actually predict incidents:

- `container_oom_events_total` — any non-zero value is a bug to fix, not a capacity problem.
- CPU throttling ratio over 10% sustained — quotas too tight or a runaway loop.
- Restart count increasing — a crash loop being masked by a restart policy.
- Image pull duration and failure rate — registry or network trouble before a deploy fails.

## Common mistakes

- Leaving `json-file` unbounded and discovering it when the daemon cannot start.
- `docker system prune -a --volumes` on a production host to "free some space".
- Rebuilding the image separately for staging and production.
- Cache mounted in the CI runner's filesystem, so every job starts cold.
- Using `--load` for a multi-arch build and wondering where the second platform went.
- Running the daemon on the root filesystem and never watching `/var/lib/docker`.

## Production notes

Treat the container host as a managed system: daemon config in version control, one image per
commit with a digest recorded, log rotation enforced at the daemon, disk usage alerted at 80% of
`data-root`, and pruning automated only for the categories that are provably safe. Most of the
remaining risk is not in Docker at all — it is in the drift between what the Dockerfile says and
what the running container actually is, which is why the digest-to-commit inventory from chapter 7
is the single most useful operational artefact you can keep.
