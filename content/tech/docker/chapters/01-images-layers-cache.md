# Images, Layers and the Build Cache

A Docker image is not a snapshot of a filesystem. It is a manifest that lists content-addressed
layers, plus a small JSON config holding the entrypoint, environment, user and working
directory. A container is that stack mounted read-only, with one thin writable layer on top.
Almost every build problem — slow rebuilds, an image that keeps growing, a cache that never
hits — is a consequence of not holding that model in your head.

## What is actually stored

Three objects, each addressed by the SHA-256 of its own content:

| Object | Contains | Identified by |
|---|---|---|
| Layer | A tar diff of filesystem changes | `sha256:…` of the compressed diff |
| Config | Env, `Cmd`, `Entrypoint`, `User`, `WorkingDir`, history | `sha256:…` of the JSON |
| Manifest | Layer digests, config digest, media types | `sha256:…` of the manifest |

`docker image inspect nginx:1.27 --format '{{json .RootFS.Layers}}'` prints the layer digests.
Two images built on the same base share those lower layers physically on disk and are pulled
once, which is why ten services on one base image cost far less than ten times one service.

Pinning by digest (`nginx@sha256:…`) pins content; a tag is only a movable pointer to a
manifest. Chapter 7 treats that distinction as a supply-chain control.

## Only some instructions create layers

`RUN`, `COPY` and `ADD` change the filesystem and therefore produce a layer. `ENV`, `LABEL`,
`EXPOSE`, `USER`, `WORKDIR`, `ARG`, `CMD` and `ENTRYPOINT` only modify the config document.
That is why a Dockerfile with forty instructions can still have six layers, and why
`docker image history` is a better size tool than counting lines.

```bash
docker image history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' app:local
```

A container's writable layer is an overlay `upperdir`. Writing a file copies it up first
(copy-on-write); deleting a file records a *whiteout* in the upper layer. Deletion never
reclaims space from the layer below, which is the whole story of the next section.

## Deleting a file does not make the image smaller

```dockerfile
# Three layers, and the bytes are still in the image
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*
```

The third instruction hides the package lists behind a whiteout in a new layer. The original
bytes remain in layer two and are still downloaded by every node that pulls the image. Worse,
layer one's `apt-get update` result is cached indefinitely, so a rebuild weeks later can fail
with 404s for package versions that have been removed from the mirror.

The correct form is one instruction, one layer:

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
```

`--no-install-recommends` alone routinely removes 40–60% of an apt-installed payload, because
Debian's recommended packages pull in documentation and optional dependencies.

## The cache key is not the Dockerfile

BuildKit computes a cache key from the parent layer, the instruction, and the instruction's
inputs. For `COPY`, the input is a checksum of the copied file contents — so `touch`ing a file
does not bust the cache, but changing one byte does. For `RUN`, BuildKit cannot see which files
the command read or wrote, so the key is the command string plus the parent. The command
`pip install -r requirements.txt` never changes; the file it reads does. This is why dependency
installation is split into its own step:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "-m", "app"]
```

Editing `app/` invalidates only the final `COPY`. Putting `COPY . .` first would reinstall every
dependency on every source edit — the single most common cause of a two-minute build becoming a
twelve-minute build.

Two consequences follow. First, order instructions from least to most frequently changing.
Second, keep files that should never reach the daemon out of the context with a `.dockerignore`:
`.git`, `node_modules`, `__pycache__`, `.env`, test fixtures, large datasets. The context is
tarred and sent to the builder before the first instruction runs, so an ignored 2 GB directory
is a 2 GB upload avoided.

## BuildKit changed where the cache lives

Since Docker Engine 23.0, BuildKit is the default builder. It is faster (parallel stages, no
sequential layer replay), it lints Dockerfiles, and its cache is not the classic builder's
cache. `docker buildx` with the `docker-container` driver keeps cache in a builder container
volume, so a cache built by one CI runner is invisible to the next unless you export it.

Cache mounts solve dependency re-downloads without putting the cache in the image:

```dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt
```

The mount lives outside the layer graph, survives rebuilds, and is never pushed. It persists
across `--no-cache` builds too — which surprises people who expect a clean slate, and is a
reason to prune builder cache rather than assume `--no-cache` did it.

For CI, export the cache where the next job can read it:

```bash
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/acme/app:buildcache \
  --cache-to   type=registry,ref=ghcr.io/acme/app:buildcache,mode=max \
  --push -t ghcr.io/acme/app:1.8.2 .
```

`mode=max` caches intermediate stages, not just the final image, which is what makes multi-stage
builds fast on a cold runner. `--progress=plain` shows `CACHED` per step when you need to know
which instruction missed.

`COPY --link` is the other BuildKit feature worth knowing: it copies files into a new layer
without depending on the parent's contents, so the layer can be rebased onto a newer base image
without rebuilding everything above it.

## Common mistakes

- `COPY . .` before installing dependencies, then wondering why every edit rebuilds everything.
- Separate `apt-get update` and `apt-get install` lines: stale indexes and an unreclaimable layer.
- Using `ADD` for local files. `ADD` silently extracts local tarballs and can fetch remote URLs
  without checksum verification; `COPY` does exactly one thing.
- Committing `node_modules`, a virtualenv, or a `.env` file because `.dockerignore` was never written.
- `chmod -R 777` to fix a permission error, which also makes every secret in the image readable
  by any process that lands in the container.
- Assuming `--no-cache` clears everything; it bypasses layer cache, not cache mounts.

## Production notes

Pin the base by digest for repeatability, but treat that pin as a debt: a frozen digest also
freezes security updates. Automation should bump digests on a schedule, and a rebuild of the same
commit should be a no-op except for the base layer. Keep the toolchain out of the final image
with a multi-stage build (chapter 3), and emit provenance and an SBOM at build time (chapter 7).
A useful habit is to check the size delta of every pull request — an image that grows 80 MB per
month is a decision nobody made deliberately.
