# Dockerfiles That Stay Small and Reproducible

A Dockerfile is a build script with two audiences: developers who want a fast rebuild after an
edit, and operators who want a small, auditable artefact that behaves identically on every host.
The instructions that satisfy the first audience are usually the ones that break the second, so
the craft is in the ordering.

## A structure that works

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS builder
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --require-hashes -r requirements.txt

FROM python:3.12-slim AS runtime
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY --chown=10001:10001 app ./app
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
ENTRYPOINT ["python", "-m", "app"]
```

Reading it top to bottom, the decisions are:

**Two stages with the same base.** The builder installs dependencies; the runtime copies only
the finished virtualenv. `gcc`, headers and pip caches never reach the shipped image. Using the
same base in both stages matters more than it looks: a virtualenv contains a symlink to the
interpreter it was created with, so copying one built against `python:3.12` into an image whose
`python3` is 3.11 produces a broken `python` that fails at exec time, not at build time.

**Dependencies before source.** `requirements.txt` changes rarely, application code changes
constantly. The layer order makes that asymmetry work for you.

**A numeric `USER`.** Kubernetes' `runAsNonRoot` check cannot resolve a username, so `USER app`
is rejected there and `USER 10001:10001` is not. Numeric also makes the UID explicit in audit
output, which is the point.

**Exec-form `ENTRYPOINT`.** `ENTRYPOINT python -m app` runs through `/bin/sh -c`, which makes the
shell PID 1 and your process a child that never receives `SIGTERM` directly. The JSON form execs
the binary directly.

**`HEALTHCHECK` only if something consumes it.** Docker's healthcheck feeds `docker ps` status
and Compose's `depends_on: condition: service_healthy`. Kubernetes ignores it entirely and uses
its own probes, so shipping one is harmless but not a substitute for a `/health` endpoint.

## Choosing the base image

| Base | Approx. size | Shell | libc | Debuggable | Notes |
|---|---|---|---|---|---|
| `debian:bookworm-slim` | ~75 MB | Yes | glibc | Yes | Predictable; `apt` available; best wheel compatibility |
| `alpine:3.20` | ~8 MB | busybox | musl | Yes | Small until you need `gcc` to build wheels |
| `python:3.12-slim` | ~130 MB | Yes | glibc | Yes | The pragmatic default for Python services |
| `gcr.io/distroless/static-debian12` | ~2 MB | No | none | No | Static binaries only; `:nonroot` runs UID 65532 |
| `gcr.io/distroless/python3-debian12` | ~50 MB | No | glibc | No | Carries Debian's Python (3.11 on bookworm), not your builder's version |
| `scratch` | 0 | No | none | No | Static binary + CA certs you copy yourself |

The trade-off is not size, it is what you give up to get it. Distroless removes the shell and
package manager, which removes a whole class of post-exploitation tooling and roughly halves the
CVE count — and also removes `sh`, `curl` and `ps`, so an on-call engineer cannot exec in and
look around. Chapter 9 covers how to debug that without rebuilding the image. `scratch` goes
further: no CA certificates, no `/etc/passwd`, no timezone database unless you copy them, and
every mistake becomes a container that exits immediately with no diagnostic.

## Alpine's real trade-offs

Alpine is the default "small image" answer and it is often the wrong one for Python and Node
services. Two specific problems:

- **musl libc, not glibc.** Many binary wheels are built for `manylinux` (glibc). On Alpine they
  are unavailable, so pip compiles from source — which needs `build-base`, `musl-dev` and the
  relevant `-dev` headers, and the build stage grows larger than the Debian equivalent. Packages
  with no pure-Python fallback simply do not install.
- **Name resolution differs.** musl's resolver reads `/etc/resolv.conf` but handles search
  domains and response ordering differently from glibc. The symptom is intermittent resolution
  failures for short names in Kubernetes, which is a miserable thing to debug at 3 a.m.

Alpine is a good choice for Go and Rust binaries (static, no libc dependency at runtime), for
simple shells-and-tools images, and anywhere the dependency tree is known to be musl-clean. For
a Python service with numpy, psycopg or cryptography in the tree, `-slim` is the smaller image in
practice because nothing has to be compiled.

## Reproducibility

Reproducible here means "the same commit and the same inputs produce an image with the same
contents and behaviour", not byte-identical tarballs — timestamps and ordering make bit-exact
rebuilds hard, and almost nobody needs them.

What actually matters:

- Pin the base by digest (`FROM python:3.12-slim@sha256:…`) and bump it deliberately, with the
  update visible in a pull request.
- Pin OS packages (`apt-get install -y curl=7.88.1-10+deb12u5`) or, more practically, rebuild
  often enough that "latest in the distro" is a bounded risk.
- Use a lockfile and `pip install --require-hashes`, or `npm ci` rather than `npm install`.
- Never `apt-get upgrade` in a Dockerfile. It produces an image whose contents depend on the day
  it was built, and it duplicates what a base-image rebuild should do.
- Pass versions as `ARG` with explicit defaults so CI can override them without editing files.

## Secrets do not belong in the build

`ARG` values are visible in `docker history`; `ENV` values are visible in `docker inspect`. A
token passed as a build argument is in the image metadata forever, and "I deleted it in the next
layer" does not remove it from the layer that wrote it.

BuildKit secrets are the correct mechanism — mounted for the duration of one `RUN`, never
written to a layer or to history:

```dockerfile
RUN --mount=type=secret,id=pip_token \
    PIP_TOKEN="$(cat /run/secrets/pip_token)" pip install -r requirements.txt
```

```bash
docker buildx build --secret id=pip_token,src="$HOME/.pip-token" -t app .
```

For CI, the secret source is the environment or a file the runner controls. The rule is
simple: if a credential is needed to *build*, it must not be needed at *runtime*, and vice versa.

## Linting the file itself

`docker build --check .` runs BuildKit's built-in checks — `JSONArgsRecommended` for shell-form
entrypoints, `LegacyKeyValueFormat`, missing `--no-install-recommends`, `FromPlatformFlagConstDisallowed`
and similar. It is a one-second gate to put in CI. `hadolint` adds shellcheck on `RUN` lines and
opinionated size rules, which catches `apt-get install` without `-y` and `sudo` usage.

## Common mistakes

- Copying a virtualenv between stages built on different base images.
- `USER app` instead of a numeric UID, then failing a Kubernetes `runAsNonRoot` policy.
- Installing build tools in the runtime stage "because it was easier", doubling the image and the CVE list.
- `EXPOSE` treated as access control — it is documentation; `-p` publishes (chapter 4).
- Baking a `.env` file into the image and treating the resulting registry as private.
- Using `latest` as the base and never pulling, so the image is six months stale without anyone noticing.

## Production notes

The runtime stage should contain exactly three things: the interpreter, the dependencies, and
the application. Everything else is either a build-time need or an attack surface. Keep a
`.dockerignore` that excludes `.git`, tests, caches and local env files, because a smaller
context is faster to send and impossible to leak by accident. When a build needs more than one
`--build-arg` to work, that is usually a sign the image should be built in two stages — one for
the toolchain, one for the artefact.
