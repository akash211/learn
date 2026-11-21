# Artefacts, Versioning and Release Gates

Everything in delivery reduces to one question: *what exactly is running, and how do I know?* A
pipeline answers it with an artefact — a file or image with a name that cannot lie — and a set of
gates that decide when that name is allowed to move forward.

## What counts as an artefact

An artefact is any immutable output that a later stage consumes by identity:

| Kind | Identity | Produced by | Consumed by |
|---|---|---|---|
| Container image | `repo@sha256:…` | BuildKit, Kaniko, Jib | Kubernetes, ECS, Compose |
| Python wheel | filename + hash | `python -m build` | pip index, Airflow image |
| JAR / native binary | path + checksum | Maven, Go, Cargo | JVM service, systemd |
| Static bundle | directory + hash | Vite, webpack | CDN, object storage |
| SBOM | document digest | Syft, `sbom: true` | scanners, admission policy |
| Migration set | version + checksum | Flyway, Alembic | the deploy job |

The test for "is this really an artefact" is whether it can be addressed, verified and promoted
without being rebuilt. A tarball produced by `git archive` at deploy time is not an artefact; it
is a build that happens to run late.

## Tags are pointers, digests are names

A tag is a mutable label in a registry or package index. It can be re-pushed, deleted, or moved
by a well-meaning release script. A digest is the SHA-256 of the manifest, so it cannot describe
two different things.

The discipline that follows is simple and non-negotiable: **build tags for humans, deploy
digests**. `api:1.4.2` is a useful way to find a release; `api@sha256:…` is what the deployment
manifest contains. Anything that deploys by tag is one re-push away from a production incident
that no audit log explains.

```bash
# resolve once, at promotion time
DIGEST=$(crane digest ghcr.io/acme/api:1.4.2)
kubectl set image deploy/api api=ghcr.io/acme/api@${DIGEST}
```

Environment-specific tags — `:staging`, `:prod`, `:latest` — are the anti-pattern in its purest
form. They carry no information about what is running, they cannot be rolled back to a previous
value once overwritten, and two environments sharing a mutable tag means a deploy to one can
change the other's pull behaviour. If you want a pointer, keep it in a deployment record, not in
a registry namespace.

## A tag scheme that survives contact

Most teams need three kinds of tag on the same digest:

- `sha-4f2c1ab` — every build, including pull requests. Immutable in practice because the commit
  is in the name.
- `1.4.2` — a release, applied only to a commit that passed every gate, ideally from a tag in git.
- `1.4` and `1` — moving aliases for consumers who want patch or minor updates. These are
  deliberate pointers; never deploy by them.

Semantic versioning is the right default for libraries and for services with external consumers.
For services deployed continuously, the git SHA is the honest version and SemVer is a marketing
label on top. What matters is that the mapping from version to commit is recorded — a release tag
in git pointing at the commit, and an annotation on the image with the same version.

`latest` should be banned on anything deployed. It is meaningful only as "the most recent stable
build" for human pulls, and even then it silently changes under the puller.

## One build, many environments

Configuration is the only thing that should differ between environments. The common failure is a
`--build-arg ENV=production` that bakes a different API URL into a genuinely different image, so
the artefact tested in staging is not the artefact in production. The rule: **the image is
environment-agnostic; the environment supplies the configuration**.

That means runtime configuration through environment variables, mounted files or a config
service, validated at startup with a clear failure when a required key is missing. It also means
feature flags are configuration, not builds — a flag that requires a rebuild to flip is a deploy
in disguise.

## Release gates

A gate is a check that must pass before an artefact may be promoted. Good gates share four
properties:

1. **Binary and automatic.** A human judgement that cannot be reproduced is not a gate; it is a
   conversation.
2. **Specific.** "Coverage above 80%" is a weak gate (it can be satisfied by testing getters);
   "no new uncovered lines in the diff" is a strong one.
3. **Owned.** Every manual gate names a team and a response time, or it becomes a queue that
   blocks releases for a week.
4. **Cheap relative to what it prevents.** A four-hour end-to-end suite guarding a change that
   deploys forty times a day is not a gate; it is a bottleneck that gets bypassed.

Useful automated gates, roughly in order of value:

- Build succeeds from a clean checkout with a locked dependency set.
- Unit and integration suites pass, with no new flaky failures.
- Static analysis and type checks clean at the configured strictness.
- No new high-severity vulnerabilities in the image or dependency tree, compared to the baseline.
- The artefact is signed and has provenance (chapter 9).
- Migration is backward compatible with the currently deployed version (chapter 8).
- Smoke test against the deployed environment passes.

Policy-as-code tools (OPA/Conftest, Kyverno, Checkov) let those rules live in the repository
rather than in a wiki. The trade-off is real: a policy engine adds a language and a debugging
surface, and it is worth it once more than one team ships through the same pipeline.

Coverage is the gate most often misused. As a *trend* it is useful — a sudden drop signals
untested code. As a *threshold* it rewards testing trivial code and punishes deleting dead code.
Gate on diff coverage, or on "the tests that cover changed modules ran", and treat the overall
number as a dashboard metric.

## Promotion records

A promotion is a state change with an owner, a timestamp and an identity. Record it somewhere
queryable: a deployment table, a git tag, a release object with the digest, the commit, the
approver, the previous digest, and the gate results. When an incident starts with "what changed
in the last hour", that record is the answer, and reconstructing it from CI logs after the fact
is far more expensive than writing it at deploy time.

The minimum viable record:

```json
{
  "service": "api",
  "environment": "production",
  "digest": "sha256:4b1e…",
  "commit": "4f2c1ab",
  "previous": "sha256:9d02…",
  "approved_by": "release-bot",
  "gates": {"tests": "pass", "scan": "pass", "smoke": "pass"},
  "deployed_at": "2026-03-04T09:12:41Z"
}
```

`previous` is the field people forget and then need most: it is the rollback target, resolved
before anything goes wrong.

## Retention and immutability

Two registry settings do most of the work: **immutable tags** (a second push to an existing tag is
rejected) and a **retention policy** that keeps the last N builds plus every digest referenced by
a live deployment. Without the first, tags drift; without the second, either storage grows
without bound or the rollback target is garbage-collected on the weekend.

A workable policy: keep all release tags indefinitely, keep `sha-*` builds for thirty to ninety
days, keep anything currently deployed regardless of age, and run garbage collection on a
schedule after confirming no deployment references the digests being removed. Chapter 10 treats
the rollback side of this as a drill rather than a policy.

## Common mistakes

- Deploying by tag, then discovering the tag was re-pushed.
- Building a separate production image, so the tested artefact is never the shipped one.
- `latest` in a Kubernetes manifest, which defeats rollback and image pull caching both.
- A coverage threshold that is satisfied by tests of generated code.
- Manual gates with no owner, which become week-long queues.
- No record of the previous digest, so a rollback needs forensics.
- Retaining builds by count only, and garbage-collecting the version that has been running for
  eight months because it is old by timestamp.

## Production notes

Write the version into the artefact at build time and expose it at runtime — an `/version`
endpoint returning the commit and build time turns "which release is this?" from a log
archaeology exercise into one request. Make the registry reject tag overwrites before you need
the guarantee, because retrofitting immutability after an incident is not possible. And treat the
SBOM as an artefact in its own right: attach it to the image and to the release record, so that
when a CVE lands you can answer "are we affected?" by querying rather than rebuilding.
