# Recovery, Bisection and Repository Hygiene

Git deletes very little. Almost every "I lost my work" story ends with a reflog lookup, and almost
every "the repository is slow" story ends with an object-count measurement. This chapter is the
operational half: find the commit, find the bug, and keep the store from growing without bound.

## The reflog is the real safety net

Every time a ref moves, Git appends the old and new value to a log scoped to that ref. `HEAD`'s
reflog is the one that saves people:

```bash
git reflog
# 1a2b3c4 HEAD@{0}: rebase (finish): returning to refs/heads/feature
# 9f8e7d6 HEAD@{1}: rebase (pick): add retry budget
# 3c4d5e6 HEAD@{2}: commit: wip uploader
# 7a8b9c0 HEAD@{3}: checkout: moving from main to feature

git reflog show feature
git reflog show main@{yesterday}
git show HEAD@{2}
```

Common rescues:

| Situation | Recovery |
|---|---|
| Bad `reset --hard` | `git reset --hard HEAD@{1}` |
| Bad rebase | `git reset --hard feature@{1}` (or `ORIG_HEAD`) |
| Amended commit you wanted to keep | `git show HEAD@{1}`, then re-apply or reset |
| Deleted branch | `git reflog` to find its tip, `git branch restored <sha>` |
| Commits made in detached HEAD, then switched away | `git reflog`, then `git switch -c rescued <sha>` |
| Dropped stash | `git fsck --unreachable \| grep commit`, then `git show <sha>` |

`ORIG_HEAD` is set by merge, rebase and reset to the pre-operation value, so `git reset --hard
ORIG_HEAD` is a fast undo when you remember it exists.

Reflog entries are local. They are not pushed, not cloned, and not shared. A colleague cannot
recover your lost commit, and you cannot recover theirs; that is why a force-push is only
recoverable if someone still has the old object locally or the server has not garbage-collected.

Expiry defaults: reachable entries 90 days, unreachable 30 days (`gc.reflogExpire`,
`gc.reflogExpireUnreachable`). `git reflog expire --expire=now --all` followed by `git gc
--prune=now` is the irreversible version — never run it while debugging.

## When the reflog does not have it

```bash
git fsck --unreachable --no-reflogs
git fsck --lost-found        # writes dangling commits to .git/lost-found/commit/
git show <dangling-sha>
git branch recovered <dangling-sha>
```

`--no-reflogs` finds objects that no reflog mentions either. Those are the last resort: a commit
whose only reference was a deleted branch, dropped stash or overwritten index. If the object was
already pruned, nothing in Git can bring it back; restore from a backup, a CI cache, a colleague's
clone or a `git bundle`.

## stash: useful, and easy to lose

```bash
git stash push -m "wip: parser" -- src/parser.py
git stash list
git stash show -p stash@{1}
git stash apply stash@{2}      # keep it in the list
git stash branch fix-parser stash@{0}   # apply onto a new branch from its original base
git stash drop stash@{1}
```

`git stash pop` applies and drops in one step; if the apply conflicts, the drop still happens,
which is how people lose stashes. Prefer `apply`, verify, then `drop`. Stashes are commits on
`refs/stash` with two or three parents, which is why `git stash show -p` can diff them and why
`git fsck` can find dropped ones.

Stashes are a short-lived tool. Work that survives a day belongs on a branch, even a temporary
one, because a branch is visible, pushable and reviewable.

## Finding the commit that broke it: bisect

`git bisect` does a binary search over a commit range. On a range of *n* commits it needs about
log₂(n) tests: 1,000 commits, about 10 builds.

```bash
git bisect start
git bisect bad                 # current HEAD is broken
git bisect good v1.3.0         # this tag was known good
# Git checks out a midpoint; test it
git bisect good                # or: git bisect bad
git bisect skip                # this commit cannot be tested (build broken)
git bisect reset               # back to where you started
```

Automate it. `git bisect run` uses the exit code: 0 means good, 125 means skip, 1–127 means bad,
and 128 or above aborts the bisect.

```bash
git bisect start HEAD v1.3.0
git bisect run ./scripts/repro.sh
# repro.sh: exit 0 if the bug is absent, 1 if present, 125 if the build fails
```

Two refinements matter in real repositories:

- `git bisect start --first-parent` ignores commits from merged side branches, so you find the
  merge that introduced the problem rather than an individual commit inside it. On a
  squash-merge repository this is the same as the normal walk.
- `git bisect start -- term` limits the walk to commits touching paths. Useful when the suspect
  area is known, though it can miss interactions.

A reliable repro script is the whole exercise. If the script is flaky, bisect reports a random
commit; run it twice, or make it deterministic before starting.

## Undoing a merge, correctly

```bash
git revert -m 1 <merge-sha>
```

`-m 1` keeps the first parent (the branch you merged into) and reverses everything the merge
brought in from the other side. Reverting the merge later does not "re-merge" the branch: the
merge base already contains those commits, so Git sees nothing to apply. To restore the changes,
revert the revert:

```bash
git revert <revert-sha>
```

## Rewriting history safely

History rewrites are sometimes correct: a leaked secret, a 2 GB blob, a file that must never have
been committed. The tool is `git filter-repo` (install separately; `filter-branch` is deprecated
and dramatically slower).

```bash
git clone --mirror https://github.com/acme/app.git app.git
cd app.git
git filter-repo --path config/prod.env --invert-paths
git filter-repo --replace-text expressions.txt   # literal/regex replacements
git push --force --all && git push --force --tags
```

Rules that keep this from becoming an incident:

1. Rotate the secret first. Removing it from history does not un-leak it; assume it was read.
2. Work on a mirror clone, never on a working copy with uncommitted work.
3. Announce a freeze: every open PR must be rebased or recreated afterwards.
4. Everyone re-clones, or runs `git fetch && git reset --hard origin/main`. Existing clones keep
   the old objects and will re-push them if someone pushes a stale branch.
5. Force-push tags too; old tags keep the old objects reachable.
6. Ask the host to run its own GC, or the objects may remain fetchable by SHA for a while. GitHub
   Support handles this for sensitive removals.

## Maintenance and hygiene

```bash
git count-objects -vH
git gc --prune=now            # aggressive; only when you mean it
git maintenance start         # register background maintenance (git 2.30+)
git maintenance run --task=commit-graph
git commit-graph write --reachable
```

`git maintenance start` schedules `gc`, `commit-graph`, `prefetch` and `incremental-repack` in the
background, which keeps large repositories fast without a manual `gc`. `commit-graph` is what makes
`git log --graph` and ancestry queries fast on long histories; `multi-pack-index` does the same for
object lookup across many packs.

Hygiene that prevents the emergencies:

- `.gitignore` for build outputs, virtualenvs, editor files and local env files — and check with
  `git status --ignored` before adding a broad rule.
- `.gitattributes` for line endings (`* text=auto eol=lf`), binary markers and merge drivers.
- `pre-commit` hooks for formatting, linting and secret scanning. Hooks live in `.git/hooks`, which
  is not cloned; commit them in `.githooks/` and set `core.hooksPath` so everyone gets them.
- Signed commits (`git config commit.gpgsign true`, with GPG or SSH signing) where authorship
  matters; verification is `git log --show-signature`.
- `.git-blame-ignore-revs` plus `blame.ignoreRevsFile` so a mass reformat does not obscure real
  authorship.

## Common mistakes

- Running `git gc --prune=now` while trying to recover something.
- Assuming the reflog exists on the server or on a teammate's machine.
- `git stash pop` on a conflicted stash, losing the entry.
- Reverting a merge without `-m`, or expecting a re-merge to restore reverted changes.
- Force-pushing rewritten history without telling open PR authors.
- Bisecting with a flaky test and trusting the answer.

## Production notes

Before any risky operation — rebase of a long branch, filter-repo, a force-push — record an escape
hatch: `git branch backup/$(date +%s)` or `git bundle create /tmp/repo-$(date +%F).bundle --all`.
A bundle is a single file containing refs and objects, restorable with `git clone repo.bundle`,
and it is the only backup that survives a corrupted `.git`.

Prefer `--force-with-lease` over `--force`, prefer a new commit over rewriting a shared one, and
prefer a tagged release over a moving branch. Every one of those choices trades a little tidiness
for a lot of recoverability.
