# GitHub Collaboration: PRs, Reviews and Protection

A pull request is a ref plus a database row. GitHub compares two branches, renders a diff, stores
comments against commits and lines, and exposes the whole thing through an API. Everything a team
argues about — who may merge, what must pass, whether approvals survive a new push — is
configuration on top of that comparison.

## The mechanics of a pull request

Opening a PR creates no Git objects. It records a base branch, a head branch (or fork), and the
merge base at the time of opening. The "Files changed" tab shows the three-dot diff
(`base...head`), which excludes commits added to the base after the branch diverged. The
"Commits" tab shows the branch's commits. When you push, GitHub re-computes both; review comments
on lines that no longer exist become outdated but are not deleted.

```bash
gh pr create --fill --base main            # title/body from commits
gh pr create --draft --title "WIP: cache layer"
gh pr view --web
gh pr diff
gh pr checks --watch
gh pr review --approve -b "LGTM, tested locally"
gh pr merge --squash --delete-branch
gh pr merge --auto --squash                # merge when requirements pass
```

`gh pr merge --auto` is the useful one: it queues the merge behind required checks and reviews
instead of leaving a green PR sitting until someone notices.

## What a good PR contains

- **One concern.** A refactor plus a behaviour change cannot be reviewed, reverted or bisected.
- **A body explaining why**, not what. The diff shows what.
- **A test that fails before and passes after**, or an explicit note that it is untestable.
- **Screenshots or logs** for UI and operational changes.
- **A link to the issue**: `Closes #142` closes it on merge; `Refs #142` does not.
- **Small enough to review in one sitting.** Review quality collapses with size long before any
  platform limit is reached.

Draft PRs are for work that is not ready for review but should run CI and be visible. Marking
"Ready for review" is a real signal; opening a non-draft PR is a request for someone's attention.

## Review states and what they mean

| State | Effect |
|---|---|
| Comment | Feedback only; does not block merging |
| Approve | Counts toward required approvals |
| Request changes | Blocks merging while the review is outstanding (when required reviews are on) |

Approvals are attached to a commit, not to a branch. Two settings decide what happens next:

- **Dismiss stale approvals when new commits are pushed** — an approval no longer applies after
  the diff changes. This is the safer default; without it, someone can approve a benign commit
  and a later push adds unreviewed code.
- **Require approval of the most recent reviewable push** — closes the loophole where the author
  pushes after approval and merges immediately.

Suggested changes (a fenced block tagged `suggestion`) can be applied by the author in one click and
committed from the web UI. They only work on lines present in the diff, and they create a commit
attributed to the applier — fine for typos, not for substantive code you want to discuss.

Conversation resolution is separate from approval. A PR can be approved with three unresolved
threads; "Require conversation resolution before merging" makes those threads blocking.

## CODEOWNERS

`CODEOWNERS` maps paths to people or teams and is read from `.github/CODEOWNERS`, the repository
root, or `docs/CODEOWNERS` — the first one found wins. Patterns follow gitignore rules with
exceptions: `!` negation and character ranges are not supported, and the **last matching pattern
wins**, so order from general to specific.

```
# .github/CODEOWNERS
*                       @acme/platform
/docs/                  @acme/docs-writers
/infra/                 @acme/sre
/src/payments/          @acme/payments @alice
*.sql                   @acme/data
```

Two things surprise people:

1. CODEOWNERS only *requests* review. Enforcement requires branch protection with "Require review
   from Code Owners" enabled.
2. Owners must have write access to the repository, and teams must be visible to the repository;
   otherwise the entry silently does nothing.

Keep the file small and path-based. A CODEOWNERS entry per file rots faster than the code.

## Branch protection and rulesets

Classic branch protection applies to a branch pattern. Rulesets are the newer mechanism: they
target branches or tags by pattern, can be layered, can run in "evaluate" mode before enforcing,
and carry a bypass list. Both express the same core controls:

| Control | Prevents |
|---|---|
| Require a pull request before merging | Direct pushes to `main` |
| Required approvals (N) | Merging without review |
| Dismiss stale approvals | Approval of a diff that later changed |
| Require review from Code Owners | Merging without the owning team |
| Require status checks | Merging with red CI |
| Require branches to be up to date | Merging a branch never tested against current `main` |
| Require conversation resolution | Merging over unanswered review threads |
| Require linear history | Merge commits on the protected branch |
| Require signed commits | Unsigned or unverifiable authorship |
| Restrict who can push / bypass | Admin bypass and accidental direct pushes |

The interaction to know: **required checks and path filtering do not compose**. If a workflow is
skipped because of a `paths:` filter, its check never reports success, and a required check that
never reports blocks the merge indefinitely. Either keep the required workflow unfiltered (and
make it fast), or add a companion job that always runs and reports the same check name.

"Require branches to be up to date before merging" is the setting that makes a merge queue worth
having. It guarantees the PR was tested against current `main`, but it also creates a race: two
green PRs both become stale as soon as either merges, and each author rebases in turn.

## Merge queue

A merge queue serialises merges. When a PR is queued, GitHub creates a temporary branch containing
`main` plus the queued PRs (a `merge_group`), runs required checks on it, and merges the batch
into `main` only if they pass. This removes the "green on a stale base" problem and the rebase
race, at the cost of running CI again and requiring workflows to handle the `merge_group` event.

```yaml
on:
  pull_request:
  merge_group:
```

Availability depends on the repository's plan and visibility, so confirm it before designing a
workflow around it. Without a queue, the same guarantee is approximated by requiring up-to-date
branches and accepting the rebase churn.

## Forks, permissions and secrets

A PR from a fork runs workflows with a read-only `GITHUB_TOKEN` and **no access to repository
secrets**. That is deliberate: otherwise anyone could open a PR that prints your deployment keys.
First-time contributors may also need a maintainer to approve running workflows.

The safe pattern for fork PRs is to run untrusted code in a job with no secrets, then hand off
artefacts to a separate `workflow_run` job that does have them — and to treat any artefact from
the untrusted job as hostile input. `pull_request_target` is the trap here: it runs in the base
repository's context with secrets, and checking out the PR head inside it is a well-known path to
secret exfiltration.

## Common mistakes

- Approving a PR and assuming the approval covers later pushes (unless stale-approval dismissal
  is on).
- Adding a `paths:` filter to a required workflow and wondering why PRs never merge.
- Treating CODEOWNERS as enforcement without the protection rule.
- Using `pull_request_target` with a checkout of untrusted code.
- Force-pushing to a PR branch while a review is in progress, invalidating every line comment.
- Merging a PR with unresolved threads because the approve button was green.
- Squash-merging and then trying to continue work on the same branch, producing conflicts with
  your own squashed commit.

## Production notes

Configure the repository once, in code where possible: rulesets via the API or Terraform, workflows
in `.github/workflows`, CODEOWNERS in the repo. Settings that exist only in the web UI drift, and
nobody can review a change to them.

Keep `main` protected, keep PRs small, and make the required check set short and fast — a required
job that takes 40 minutes teaches people to merge without reading. If a check is flaky, fix it or
remove it from the required list; a flaky required check trains the team to re-run until green,
which is indistinguishable from not having the check.
