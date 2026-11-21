# Remotes, Tracking and Fetch vs Pull

Almost every "Git did something unexpected" story at a team level is a remote-tracking problem:
someone assumed `origin/main` was live, or `git pull` merged when they expected a rebase, or a
force-push overwrote work they never fetched. This chapter makes the exchange protocol explicit.

## What a remote is

A remote is a name for a URL, plus the refspecs Git uses when talking to it:

```bash
git remote -v
# origin  git@github.com:acme/api.git (fetch)
# origin  git@github.com:acme/api.git (push)

git remote add upstream https://github.com/upstream/project.git
git remote set-url origin git@github.com:acme/api.git
git remote show origin        # refs, tracking branches, prune behaviour
```

`origin` is a convention, not a keyword. Forks usually have `origin` (your fork) and `upstream`
(the canonical repo). Nothing stops you from having `backup`, `ci` or a remote pointing at a
local path.

## RefSpecs: the actual protocol

A refspec is `<src>:<dst>`, optionally prefixed with `+` to allow non-fast-forward updates. The
default fetch refspec for `origin` is:

```
+refs/heads/*:refs/remotes/origin/*
```

That single line says: take every branch on the remote and write it under
`refs/remotes/origin/` locally, overwriting whatever was there. That is why fetching cannot
damage your branches — it only writes to the remote-tracking namespace.

```bash
git fetch origin main:refs/remotes/origin/main   # one branch, explicit
git fetch origin 'refs/heads/release/*:refs/remotes/origin/release/*'
git push origin HEAD:refs/heads/feature/login    # push local HEAD to a remote branch name
git push origin :refs/heads/old-branch           # delete (empty src)
```

## Remote-tracking branches are a cache

`refs/remotes/origin/main` records where `main` was on `origin` the last time you fetched or
pushed. It is not a live view. If a colleague merges a PR, your `origin/main` does not move until
you fetch.

```bash
git branch -vv
# * main   1a2b3c4 [origin/main: ahead 2, behind 5] latest work
git rev-parse origin/main
git log --oneline HEAD..origin/main      # what you are missing
git log --oneline origin/main..HEAD      # what you have not pushed
```

The `[origin/main: ahead 2, behind 5]` line is the fastest way to answer "am I up to date?" without
network access.

## Tracking configuration

A local branch tracks an upstream when `branch.<name>.remote` and `branch.<name>.merge` are set:

```bash
git push -u origin feature/login     # set upstream on first push
git branch --set-upstream-to=origin/main main
git rev-parse --abbrev-ref '@{upstream}'   # origin/main
git log '@{u}..HEAD'                        # unpushed commits
git status -sb                              # ## feature/login...origin/feature/login [ahead 1]
```

Tracking enables bare `git push`, `git pull`, `git fetch` and the `@{u}` shorthand. Without it,
`git push` fails with the "no upstream branch" hint rather than guessing — a deliberate safety
default.

## fetch vs pull

`git fetch` downloads objects and updates remote-tracking refs. It never modifies your branches,
your index or your working tree. It is always safe.

`git pull` is `git fetch` followed by an integration step, and the integration step is where the
surprises live. Its behaviour depends on configuration:

```bash
git config --global pull.ff only     # refuse to merge; require FF or explicit rebase
git config --global pull.rebase true # pull = fetch + rebase
git config --global pull.rebase merges  # rebase, preserving local merge commits
```

| Setting | Divergent pull does |
|---|---|
| default (unset, modern Git warns) | `merge` — creates a merge commit |
| `pull.ff only` | Fails; you choose rebase or merge |
| `pull.rebase true` | Replays your commits on top of the fetched tip |
| `pull.rebase false` | Merge commit |
| `pull.rebase merges` | Rebase but keep local merge commits (`--rebase-merges`) |

`pull.ff only` is the setting most teams should adopt. It makes divergence an explicit decision
instead of a silent merge commit, and it prevents the "forty merge commits from main" log that
comes from pulling a busy branch into a feature branch every morning.

A clean habit:

```bash
git fetch origin
git log --oneline HEAD..origin/main    # look before integrating
git rebase origin/main                 # or: git merge origin/main
```

That is `pull` with the ability to inspect between the two steps.

## push: fast-forward by default

`git push` refuses to update a remote branch unless the new tip descends from the current one. A
non-fast-forward rejection means the remote has commits you do not have; the fix is to fetch and
integrate, not to force.

```bash
git push origin feature/login
git push -u origin HEAD
git push --tags                     # all tags (not implied by a branch push)
git push --follow-tags              # annotated tags reachable from pushed commits
git push origin --delete old-branch
git push --dry-run
```

Force-pushing after a rebase is sometimes necessary on your own branch. `--force` overwrites
whatever is there, including commits a colleague pushed five minutes ago. `--force-with-lease`
checks that the remote ref still matches your remote-tracking ref before overwriting:

```bash
git push --force-with-lease origin feature/login
```

The lease is only as good as your last fetch. If you have not fetched, your `origin/feature/login`
may be stale, the lease passes, and you still clobber the colleague. Two safer forms:

```bash
git fetch origin
git push --force-with-lease=feature/login:<expected-sha> origin feature/login
git push --force-if-includes origin feature/login
```

`--force-if-includes` additionally verifies that your local branch already contains the remote tip
you are replacing, which catches the "someone pushed while I was rebasing" case even with a stale
lease. It is the closest thing to a safe force-push.

Never force-push `main`, release branches or any branch with an open PR that others build on.
Protect those refs server-side; a policy that depends on everyone remembering is not a policy.

## Pruning stale refs

Deleted remote branches leave their tracking refs behind:

```bash
git fetch --prune
git config --global fetch.prune true
git remote prune origin        # one-off, no fetch
```

With `fetch.prune`, `git branch -vv` stops listing branches that no longer exist upstream, and
`git branch --merged` becomes trustworthy for cleanup.

## Common mistakes

- Treating `origin/main` as the server's current state without fetching.
- `git pull` in a dirty working tree, then losing track of which changes came from the merge.
- `git push --force` on a shared branch, erasing a colleague's commits.
- `--force-with-lease` without a recent fetch, believing it is a guarantee.
- Assuming `git push` sends tags. It does not; use `--follow-tags` or an explicit tag push.
- Deleting a remote branch and being surprised the local tracking ref remains without `--prune`.
- Setting `pull.rebase true` while having local merge commits, then flattening them.

## Production notes

In CI, always fetch the base branch explicitly before diffing. `actions/checkout` with
`fetch-depth: 0` gives full history; with a shallow clone, `git diff origin/main...HEAD` can fail
or return the wrong set because the merge base is missing. When a pipeline only needs changed
files, fetch `--deepen` enough to include the base, or use the provider's changed-files API.

For deployment automation, push is not the trigger you think it is: tag pushes, branch pushes and
PR merges are distinct events, and a force-push may or may not fire depending on the platform.
Trigger on the ref pattern you actually mean.

Finally, keep credentials out of URLs. Use SSH keys or a credential helper (or the GitHub CLI's
`gh auth setup-git`), because a token embedded in `remote.origin.url` ends up in shell history,
CI logs and `.git/config` backups.
