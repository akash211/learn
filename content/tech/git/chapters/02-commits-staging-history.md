# Commits, Staging and History Surgery

Most Git mistakes are not lost data; they are history that says something other than what
happened. This chapter covers the three trees Git compares, then the four tools that rewrite
history — `reset`, `revert`, `cherry-pick`, `rebase` — and what each one creates, moves or
abandons in the graph.

## Three trees, three diffs

Git compares three states, and almost every confusing command is one of these comparisons:

| Name | What it is |
|---|---|
| `HEAD` | The commit your branch points at — the last snapshot |
| Index (staging area) | The snapshot you are composing for the next commit |
| Working tree | The files on disk, including untracked ones |

```bash
git diff              # working tree vs index   — what you have not staged
git diff --cached     # index vs HEAD           — what the next commit will contain
git diff HEAD         # working tree vs HEAD    — both combined
git status -sb        # branch, ahead/behind, and the same three states in summary
```

Staging is a feature, not bureaucracy. It lets one file's two unrelated changes become two
commits, and it lets you review exactly what you are about to record:

```bash
git add -p app.py          # stage hunk by hunk; s splits, e edits the hunk
git add -N new_file.py     # intent-to-add: shows up in git diff, content unstaged
git restore --staged app.py # unstage, keep the working-tree edit (old: git reset app.py)
git restore app.py         # discard the working-tree edit (old: git checkout -- app.py)
```

`git add -p` is the highest-leverage habit here: a commit mixing a refactor and a behaviour change
cannot be reviewed, reverted or bisected cleanly; two commits can.

## Anatomy of a commit

A commit records a tree hash, parent hashes, author and committer identities with timestamps, and
the message. Author and committer differ after a rebase or cherry-pick: the author is who wrote
the change, the committer is who last applied it. Both are visible in `git log --format=fuller`.

## reset: move the branch, choose what follows

`git reset` always moves the current branch (and `HEAD` with it). The mode decides what happens to
the index and working tree:

| Command | Branch | Index | Working tree | Typical use |
|---|---|---|---|---|
| `git reset --soft HEAD~1` | moves | untouched | untouched | Squash the last commit into the next one |
| `git reset HEAD~1` (mixed) | moves | reset | untouched | Uncommit, then re-stage selectively |
| `git reset --hard HEAD~1` | moves | reset | reset | Throw away the commit **and** local edits |
| `git reset --keep HEAD~1` | moves | reset | preserved if no conflict | Move back without losing unrelated edits |

`--hard` is the only mode that destroys uncommitted work, and it does so without asking. The
commits themselves are recoverable via reflog; the uncommitted edits are not.

`git reset` is for local, unpushed history. On a shared branch it rewrites what others have
already based work on — use `git revert` there instead.

## revert: undo forward, in public

`git revert <commit>` computes the inverse of that commit's diff and records it as a **new
commit** on top of `HEAD`. Nothing is removed, so it is safe on `main` and safe to push.

```bash
git revert --no-edit abc1234        # one commit
git revert -m 1 9f2c1ab             # undo a merge: keep parent 1 (the branch you merged into)
git revert --no-commit A..B         # stage several reverts as one commit
```

Reverting a merge is subtle: `-m 1` says "pretend the merge never brought in parent 2". Git does
not remember that decision. If you later re-merge the same branch, the changes stay reverted,
because the merge base already contains them; you must revert the revert first.

## cherry-pick: copy a commit elsewhere

`git cherry-pick <sha>` applies that commit's diff onto `HEAD` and creates a new commit with the
same message and author. The new commit has a different hash and a different parent — it is a
copy, not the original. That is exactly what you want for a hotfix on a release branch, and
exactly what creates duplicate commits when a branch is cherry-picked and later merged.

```bash
git cherry-pick -x abc1234     # appends "(cherry picked from commit abc1234)" for traceability
git cherry-pick A^..B          # a range, inclusive of A
git cherry-pick --continue     # after resolving conflicts
```

## rebase: replay commits on a new base

`git rebase main` finds the merge base of `main` and your branch, takes your commits since that
point, and re-applies them one by one onto `main`'s tip. Each replayed commit is a **new object**;
the originals become unreachable but stay in the reflog.

```bash
git switch feature
git fetch origin
git rebase origin/main
# conflicts: fix files, git add <file>, git rebase --continue
#            or git rebase --abort to return exactly to where you started
```

Interactive rebase is the editing interface for local history:

```bash
git rebase -i HEAD~4
# pick   1a2b3c4 add retry to uploader
# squash 5d6e7f8 fix typo in retry
# reword 9a0b1c2 handle timeout
# drop   3c4d5e6 debug print
# exec   pytest -q
```

| Action | Effect on the graph |
|---|---|
| `pick` | Replay as-is (new hash) |
| `reword` | Replay with a new message |
| `edit` | Stop after replay so you can amend or split |
| `squash` | Combine into the previous commit, edit the combined message |
| `fixup` | Combine, discard this commit's message |
| `drop` | Do not replay; the commit becomes unreachable |
| `exec` | Run a shell command at that point in the sequence |

`git commit --fixup=<sha>` followed by `git rebase -i --autosquash` automates the common
"fix the commit three back" loop. `--update-refs` moves other branches that point at rewritten
commits, which matters in stacked-branch workflows.

`--onto` is the sharpest tool for moving a slice of history:

```bash
# replay only feature's commits made after `old-base`, onto main
git rebase --onto main old-base feature
```

That is how you drop the first N commits of a branch without interactive editing.

## Choosing between them

| Goal | Command | Public branch? |
|---|---|---|
| Add an inverse commit | `git revert` | Yes |
| Copy one commit elsewhere | `git cherry-pick` | Yes |
| Rewrite your last commit | `git commit --amend` | No |
| Reorder/squash local commits | `git rebase -i` | No |
| Move a branch to a new base | `git rebase` | No |
| Uncommit to re-stage | `git reset` | No |

The rule interviewers listen for: **rebase local, merge or revert public.** Once commits are on a
branch someone else may have pulled, rewriting them forces everyone to recover, and the recovery
is only reliable if they have not run `git gc`.

## Common mistakes

- `git reset --hard` to undo a pushed commit, then a force-push that discards a colleague's work.
- Reverting a merge without `-m 1`, or re-merging a reverted branch and expecting the changes back.
- Cherry-picking a commit and later merging the original branch, producing duplicate changes and
  a conflict that looks nonsensical.
- Running `git rebase` with a dirty working tree, then losing track of which edits were yours.
  Commit or stash first; `rebase.autostash` exists but hides the state.
- Amending a commit that is already reviewed: the review comment now points at a hash that no
  longer exists.
- Assuming a rebase preserves commit hashes. Every replayed commit is new, so signed commits lose
  their signature unless re-signed.

## Production notes

Before any history surgery, create an escape hatch: `git branch backup/feature` or note
`git rev-parse HEAD`. The reflog is a safety net, not a plan, and it is local — it does not exist
on the server or on a colleague's clone.

Keep commits atomic and the first line of the message imperative and under roughly 50 characters,
with the body explaining why rather than what. This is convention, not enforcement, but `git log
--oneline`, changelog generators and bisect output all read better for it.

For large interactive rebases, `git range-diff origin/main...old origin/main...new` shows what
actually changed between the two versions of the series. It answers "did my conflict resolution
alter behaviour?" better than re-reading every diff.
