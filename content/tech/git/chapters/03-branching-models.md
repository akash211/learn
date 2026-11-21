# Branching Models and Merge Strategies

A branching model is a policy about how long work lives off the main line and what a merge is
allowed to look like. The two questions are separable: the model decides *when* work integrates,
the merge strategy decides *what the graph records*. Teams routinely pick one without the other
and then argue about symptoms.

## What a branch actually costs

A branch is a 41-byte file holding a commit hash (64 hex characters plus newline for SHA-256
repositories). Creating one is constant time and copying nothing, which is why Git encourages
branches where older systems encouraged long-lived locks. The real costs are social and
mechanical: every branch that lives longer than a few days drifts from the main line, and every
day of drift makes the eventual merge more expensive.

## Trunk-based development

Everyone integrates into `main` at least daily; branches live hours to a day or two. Unfinished
features are hidden behind flags rather than long branches, so `main` is always deployable.

The practices that make it work:

- **Small, frequent merges.** The conflict cost grows with divergence, not with diff size.
- **Feature flags.** Incomplete work ships dark instead of living on a branch for three weeks.
- **A fast, trustworthy CI.** If a red `main` is normal, trunk-based development collapses.
- **Release from trunk.** A release is a tag on a known-good commit, not a branch cut weeks ago.
- **Merge queues.** At higher merge rates, serialising merges prevents two green PRs from
  producing a red `main`.

Trunk-based is the default at most large product companies because it minimises integration risk
and makes continuous deployment possible. It requires discipline: reviewing small PRs quickly is
part of the model, not an optimisation.

## GitFlow

GitFlow uses two permanent branches and three kinds of temporary ones:

| Branch | Purpose | Merges into |
|---|---|---|
| `main` | Exactly what is released | — (tagged) |
| `develop` | Integration for the next release | `main` at release |
| `feature/*` | One feature, may live weeks | `develop` |
| `release/*` | Stabilisation, version bump, only fixes | `main` and back to `develop` |
| `hotfix/*` | Urgent production fix | `main` and `develop` |

It was designed for versioned, shipped software with a QA gate: desktop apps, firmware, libraries
with supported release lines. Its cost is high — two long-lived branches, regular back-merges, and
a `develop` that accumulates integration risk of its own. Vincent Driessen, who popularised it,
added a note years later saying it was suited to explicitly versioned software and that
continuous-delivery web apps are better served by simpler models.

It still appears in interviews because it names a real problem: how do you stabilise a release
while `main` moves on? Modern answers are release branches cut from trunk plus cherry-picked
fixes, or shipping from trunk behind flags.

## GitHub Flow

One long-lived branch (`main`), short-lived topic branches, a pull request, review, merge, deploy.
It is trunk-based development with review attached. Most repositories using GitHub land here by
default, whether or not they call it that.

## Merge strategies and what they write

| Strategy | Command | Graph result |
|---|---|---|
| Fast-forward | `git merge feature` when `main` has not moved | Branch pointer slides forward; no merge commit |
| Fast-forward only | `git merge --ff-only feature` | Refuses if a merge commit would be needed |
| No fast-forward | `git merge --no-ff feature` | Always a merge commit, even when FF is possible |
| Squash | `git merge --squash feature` + commit | One new commit on `main`; feature commits unrelated |
| Rebase then FF | `git rebase main` then `git merge --ff-only` | Linear history; feature commits rewritten |
| Octopus | `git merge a b c` | One merge commit with three or more parents |

A fast-forward is not a merge in the graph sense: it moves a label. `git merge --no-ff` preserves
the fact that a group of commits belonged to one feature, which is useful for `git log
--first-parent` and for reverting a whole feature with one `git revert -m 1`. Squash merges
produce the cleanest linear log but destroy the individual commits, their authorship granularity
and the link to the branch — reverting a squash is one commit, and continuing work on the deleted
branch creates conflicts.

`git merge --squash` does not create a commit and does not move `HEAD`; it stages the result, so
you must commit. GitHub's "Squash and merge" does both for you.

### First-parent history

```bash
git log --first-parent --oneline main
```

This walks only the main line, treating each merge as one entry. On a `--no-ff` or merge-queue
repository it gives a clean release history: one line per integrated PR. On a squash-merge
repository it is the same as the normal log. `git bisect --first-parent` uses the same idea to
ignore commits from side branches.

## Choosing a policy

- **Squash merge** — small PRs, linear history, changelog per PR. Loses intra-PR history; bad if
  you bisect within a PR or need individual commit attribution.
- **Merge commit (`--no-ff`)** — preserves branch structure and authorship. Noisier log, and
  `git log` needs `--first-parent` to stay readable.
- **Rebase and merge** — linear and preserves individual commits, but rewrites hashes. Every
  commit should build and pass tests, or bisect will land on a broken intermediate state.
- **Merge queue** — required at scale; the queue creates a temporary branch per batch and runs
  required checks on it before fast-forwarding `main`.

Whatever you choose, make it a repository setting rather than a matter of reviewer mood. Mixed
strategies produce a log where some features are one commit and others are fifteen, and tooling
that assumes one shape (changelog generators, release notes, revert playbooks) starts producing
nonsense.

## Common mistakes

- Long-lived feature branches merged weekly, then blaming Git for the conflicts.
- Using `--no-ff` everywhere and never using `--first-parent`, then calling the history unreadable.
- Squash-merging a PR whose individual commits were reviewed as separate units, losing the
  mapping between review comments and code.
- Rebasing a shared branch and force-pushing without warning.
- Cutting a release branch and continuing to merge features into it.
- Assuming `git merge` always creates a commit. On a strict fast-forward it does not.

## Production notes

Set the default explicitly so local and server behaviour agree:

```bash
git config --global pull.ff only      # refuse implicit merge commits on pull
git config --global merge.ff false    # local merges always record a merge commit
git config --global rebase.autoSquash true
```

`pull.ff only` turns a divergent pull into an error instead of a surprise merge commit; you then
choose `git pull --rebase` deliberately. That one setting prevents most of the "why are there
forty merge commits from main in my feature branch" complaints.

Branch protection should match the model: require a PR and passing checks on `main`, forbid direct
pushes, and delete head branches on merge. If the model is trunk-based, also keep PR size down —
protection cannot fix a branch that has been open for three weeks.
