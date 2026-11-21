# Registries, Tagging and the Supply Chain

An image only exists as an artefact once it is in a registry, and the registry is where most
supply-chain decisions are made — often by accident. The question is not "did the deploy work"
but "can I prove, six months later, exactly what ran in production and who built it".

## Names, tags and digests

A reference has three parts: `registry/repository:tag`. Omitting the registry means Docker Hub
(`docker.io`), and a single-segment name gets `library/` prepended, so `nginx:1.27` is
`docker.io/library/nginx:1.27`.

A **tag is a mutable pointer**. `app:1.4` can be re-pushed to point at completely different
content, and nothing in the registry stops it. A **digest is the content**: `sha256:…` of the
manifest, which cannot change without becoming a different digest.

```bash
docker pull registry.example.com/team/app@sha256:9f2c…   # immutable
docker inspect --format '{{index .RepoDigests 0}}' app:1.4
docker buildx imagetools inspect registry.example.com/team/app:1.4
```

Every deploy should reference a digest, or a tag that the registry enforces as immutable. The
common compromise is a two-part scheme: a human tag (`1.4.2`) and a unique tag
(`1.4.2-3f9a1c7`), with the deployment manifest pinned to the digest that `1.4.2` resolved to at
release time. That gives readable rollback (`1.4.1`) and exact reproduction.

`latest` is not "newest". It is the tag applied when you omit `-t`, and it is whatever was pushed
last under that name. On a machine that never pulls, `latest` means "from 2023".

## A tagging strategy that survives incidents

| Tag | Mutability | Purpose |
|---|---|---|
| `1.4.2` | Immutable in practice | Release identity, used by humans and rollback |
| `1.4.2-3f9a1c7` | Unique | Traceability from image to commit |
| `sha-3f9a1c7` | Unique | CI artefact per commit, every build |
| `main` | Moves | Integration builds; never deployed directly |
| `latest` | Moves | Local convenience; never deployed |

Two habits make this work. First, **build once, promote everywhere**: the artefact tested in
staging is the artefact that runs in production, referenced by digest. Rebuilding per environment
means the thing you tested is not the thing you shipped, even if the commit is identical — base
images, timestamps and dependency resolution all differ. Second, **never let CI write a moving
tag that production reads**. If your deploy manifest says `:prod`, a compromised CI token can
change production by pushing an image.

Enable tag immutability where the registry supports it (ECR and Harbor both do), and set a
retention policy: keep the last N releases and anything deployed in the last 90 days, expire the
rest. Unbounded registries are a slow, boring cost problem and a scanning problem — every old
image is another set of unpatched packages someone might pull.

## Authentication

```bash
aws ecr get-login-password --region eu-west-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.eu-west-1.amazonaws.com
```

`--password-stdin` keeps the credential out of the shell history and the process list. Docker
stores the result in `~/.docker/config.json`, base64-encoded unless a credential helper is
configured (`"credsStore": "osxkeychain"` or `"secretservice"`), which is worth setting on any
shared machine. In CI, prefer short-lived tokens issued per job over long-lived robot passwords,
and scope them to push on one repository rather than the whole registry.

## Multi-architecture images

An image built on an amd64 CI runner does not run on an Apple Silicon laptop or an arm64 Graviton
node; the failure is `exec format error`. The fix is a manifest list — one reference pointing at
several platform-specific manifests, so `docker pull` selects the right one.

```bash
docker buildx create --name multi --driver docker-container --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t registry.example.com/team/app:1.4.2 \
  --push .
```

Buildx needs either native arm64 builders or QEMU emulation registered on the host
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`). Emulation is correct but
slow — a Python build with compilation can go from four minutes to forty. For anything built
often, native runners per architecture are worth the CI cost; for occasional builds, QEMU is
fine.

`docker buildx imagetools inspect` shows the resulting index and each platform's digest, which is
what you check when "it works on my laptop but the deploy says no matching manifest".

## Provenance and SBOMs

Two different questions, two different artefacts:

- **An SBOM** lists what is inside the image — OS packages and language dependencies, usually
  SPDX or CycloneDX. It answers "are we affected by this new CVE" without pulling and rescanning
  everything.
- **Provenance** describes how the image was built — source repository, commit, builder, build
  parameters, timestamps. It answers "did this come from our pipeline, from our commit".

BuildKit can attach both as attestations, stored alongside the image and retrievable by digest:

```bash
docker buildx build \
  --sbom=true \
  --provenance=mode=max \
  --push -t registry.example.com/team/app:1.4.2 .
```

Buildx already attaches a minimal provenance attestation on push; `mode=max` adds the build
arguments and materials needed for a meaningful audit. `docker buildx imagetools inspect
--format '{{json .Provenance}}'` and `docker scout sbom` are the read paths.

This maps onto **SLSA**, a maturity ladder rather than a product. Build level 1 is "the build is
scripted"; level 2 is "a hosted build service signs provenance"; level 3 is "the provenance is
non-falsifiable and the platform is hardened"; level 4 adds hermetic builds and two-party review.
Most teams reaching level 3 with a hosted CI system and signed provenance have done the part that
matters.

## Scanning and signing

Scanning tools — Docker Scout, Trivy, Grype, Clair, Snyk — read the same image and report CVEs
for OS packages and language dependencies. Three practical points:

1. **Most findings come from the base image.** Rebuilding on a newer `python:3.12-slim` fixes
   more than upgrading application dependencies does. Automate the rebuild; a manual quarterly
   pass is not a process.
2. **Severity is not risk.** A critical CVE in a package your process never loads, on a port
   nothing can reach, is not the same as a medium in the HTTP parser. Triage with reachability
   and exposure, and time-box exceptions rather than suppressing them permanently.
3. **Scan continuously, not only at build.** New CVEs are published against images that were
   clean when built. A weekly rescan of what is actually deployed is the control that matters.

Signing binds an identity to a digest. The de facto tool is Sigstore's `cosign`:

```bash
cosign sign --key cosign.key registry.example.com/team/app@sha256:9f2c…
cosign verify --key cosign.pub registry.example.com/team/app@sha256:9f2c…
```

Keyless signing replaces the long-lived key with a short-lived certificate issued by Fulcio
against a CI OIDC identity, with the signature recorded in the Rekor transparency log. That is
what makes verification meaningful in a pipeline: the policy can require that the image was
signed by *this* workflow in *this* repository, not merely that some key signed it.

Docker Content Trust (Notary v1, `DOCKER_CONTENT_TRUST=1`) was the earlier mechanism and is best
treated as legacy; OCI-native signatures and attestations are where tooling has converged.

## Common mistakes

- Deploying `:latest` and being unable to say what is running.
- Pinning a tag in the manifest but pulling by tag at runtime, so a re-push silently changes production.
- Building a separate image per environment, then wondering why staging and production differ.
- Scanning only the final image while the builder stage pulled a compromised dependency.
- Treating a zero-finding scan as proof of safety; it means "nothing known today".
- Granting CI push rights to the whole registry instead of one repository.
- No retention policy, so the registry holds five years of images nobody will ever patch.

## Production notes

Wire the pipeline so that a commit produces one digest, that digest is scanned and signed, and
promotion between environments is a reference change rather than a rebuild. Enforce the
signature at admission (Kyverno, Sigstore policy-controller, or the platform's own policy engine)
so an unsigned image cannot run even if someone pushes one. Keep an inventory that maps running
digests to commits — during an incident, "which version is this" should take seconds, not a
search through CI logs.
