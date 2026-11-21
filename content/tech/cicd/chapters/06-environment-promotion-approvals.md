# Environment Promotion and Approvals

Promotion is the act of moving one artefact's identity from one environment to the next. It is
not a rebuild, not a copy and not a "deploy the branch" — it is a pointer move, recorded, with an
owner. Everything else in this chapter follows from taking that sentence seriously.

## The ladder

Most systems converge on three or four rungs:

| Environment | Purpose | Data | Lifetime | Who deploys |
|---|---|---|---|---|
| Preview / ephemeral | Review a pull request | Synthetic, seeded | Hours to days | Automation, on PR |
| Staging | Integrate and verify before release | Production-like, anonymised | Permanent | Automation on merge |
| Production | Serve users | Real | Permanent | Gated automation |
| Break-glass | Incident debugging | Real, tightly scoped | Hours | On-call, audited |

Preview environments are the highest-value rung and the most often skipped. A namespace per pull
request, seeded with fixtures, torn down on merge, turns "please pull my branch and check" into a
URL in the review. The cost is real — every preview needs DNS, TLS, a database and a cleanup
policy — which is why most teams start with a single shared staging and add previews for the
services where review actually needs to see behaviour.

## Same artefact, different configuration

The invariant that makes promotion meaningful: **the bytes do not change**. Every environment runs
the same digest; only configuration differs. Configuration arrives at runtime, from environment
variables, mounted files or a config service, and is validated at startup so a missing key fails
loudly rather than silently defaulting.

This is where `--build-arg ENV=prod` and per-environment Dockerfiles do their damage. They produce
a second, untested artefact, and the promotion record becomes a fiction. If a value must be
compiled in — an API base URL in a frontend bundle, for instance — then the honest approach is
runtime configuration injection (a `/config.json` served to the browser, or a server-rendered
value), not a second build.

## Approvals that mean something

A manual approval is a control only if it is (a) required, (b) made by someone who can actually
evaluate the change, and (c) recorded with the artefact identity. Three failure modes account for
most useless approvals:

**Rubber-stamping.** One person approves forty deployments a day without reading them. The control
exists on paper. The fix is not more approvers but fewer, better-scoped gates: approve the
*release* (a batch), not each deploy, and automate the deploys inside it.

**Approval fatigue.** Every change needs three approvals, so the queue becomes the real release
process and people approve in bulk on Friday afternoon. Fewer gates with clear ownership beat many
gates with none.

**Separation of duties that nobody enforces.** Requiring an approver who is not the author is
meaningless if the author can approve their own deploy through a shared bot account. Check that
the identity doing the approving is the human, via OIDC or SSO, not a long-lived token.

In GitHub Actions the mechanism is an environment with protection rules: required reviewers,
deployment branches, and an optional wait timer. The job declares the environment, and the
platform holds it until the rules are satisfied:

```yaml
  deploy:
    needs: publish
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://app.example.com
    steps:
      - run: ./deploy.sh --digest "${{ needs.publish.outputs.digest }}"
```

Environment-scoped secrets are the useful side effect: a job that is not attached to the
environment cannot read its secrets, so a compromised workflow in another branch cannot reach
production credentials even if it can run code.

## What to gate on

Gates should answer "is this specific artefact safe to promote", which means the evidence must be
tied to the digest, not to the branch:

- The full test and scan suite passed for this digest.
- The artefact is signed, and the signature verifies against the expected identity.
- The migration is compatible with the currently deployed version.
- The change window allows it (freeze periods, on-call coverage).
- The rollback target exists and is deployable.

Notice that none of these are "someone looked at it". Human review belongs earlier, on the pull
request, where the diff is visible. A production approval is a decision about *timing and risk*,
not about code quality — which is why it is reasonable for a release bot to hold that authority
for routine changes and a human for the rest.

## Freezes, trains and continuous flow

Three release models, and the choice is usually organisational rather than technical:

- **Continuous** — every green merge deploys. Fastest feedback, requires strong automated
  verification and a culture that tolerates small failures.
- **Release train** — a scheduled batch, often daily or weekly, cut from a branch or a tag. Useful
  when downstream consumers need coordination, or when change approval is external.
- **Freeze windows** — periods when deploys are blocked (end of quarter, peak trading, holidays).
  Necessary in some businesses, and dangerous if the freeze is long: a month of undeployed changes
  makes the eventual release enormous and the rollback ambiguous.

Whatever the model, a freeze must have a documented exception path for security fixes, or the
first critical CVE during a freeze will be shipped by hand at 2 a.m. with no record.

## Drift

Environments diverge through small, reasonable decisions: a hotfix applied directly to staging, a
config value changed in a console, an instance type bumped during an incident and never reverted.
Drift makes staging useless as a predictor and production surprising.

The controls are the ones from infrastructure-as-code: every environment defined in the same
repository, applied by the same pipeline, with drift detection reporting differences rather than
silently correcting them. Configuration that must differ per environment lives in a versioned
values file, reviewed like code. Anything changed by hand is either reverted or committed; the
console is for reading, not writing.

## Credentials and blast radius

Promotion is where privilege concentrates, so scope it:

- The deploy identity can deploy, and nothing else. It cannot read the database, create users or
  modify IAM.
- Production credentials are available only to the job attached to the production environment,
  and only for the duration of that job.
- The identity used by a pull-request workflow has read-only access and no production secrets at
  all — this is what makes fork PRs safe to build.
- Break-glass access is separate, time-boxed and alerts when used.

Chapter 9 covers the mechanics — OIDC, short-lived tokens, workload identity — but the design
decision belongs here: the pipeline should be able to deploy the artefact and should not be able to
do anything else.

## Common mistakes

- Rebuilding for each environment, so promotion moves a different artefact.
- Environment-specific tags (`:prod`) as the promotion mechanism.
- Approvals granted by a shared bot account, which destroys the audit trail.
- A production environment with no required reviewers, because "the tests are good".
- Staging configured differently enough that a successful staging deploy predicts nothing.
- Freeze windows with no security exception, so critical fixes bypass the pipeline entirely.
- Deploy credentials that can also mutate infrastructure, widening every pipeline compromise.

## Production notes

Record the promotion, not just the deployment: service, environment, digest, previous digest,
approver, gate results and timestamp. Keep the previous digest resolvable, because that is the
rollback. And periodically promote a trivial change through the full ladder and time it end to
end — the number you get is the real lead time for change, and it is usually larger than anyone
estimates.
