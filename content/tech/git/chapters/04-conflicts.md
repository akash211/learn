# Conflicts and the Resolution Workflow

A conflict is not an error. It is Git refusing to guess when two branches changed the same region
of the same file in different ways. The mechanic is a three-way merge; the skill is resolving it
without silently changing behaviour, and the discipline is not producing conflicts that were
avoidable.

## How a three-way merge works

Git finds the **merge base**: the best commit reachable from both branches, usually their most
recent common ancestor. It then compares three trees:

- base → ours (the branch you are on)
- base → theirs (the branch being merged in)

If only one side changed a region, that change is taken. If both changed it identically, the
result is that change. If both changed it differently, Git writes conflict markers and leaves the
decision to you. Changes in different regions of the same file merge cleanly, which is why two
people can edit one large file all day and only collide on the same function.

When there are multiple merge bases (criss-cross merges after years of branch merges), the
recursive strategy merges them into a virtual base first; the `ort` strategy, the default since
Git 2.34, does the same job in memory and is much faster.

The merge base is also what makes `git diff main...feature` useful: it compares base to feature,
excluding anything `main` gained after the branch started.

## What a conflict looks like

```
<<<<<<< HEAD
timeout = 30
=======
timeout = 60
>>>>>>> feature/retry
```

With `merge.conflictStyle=diff3` (or `zdiff3`, which trims common lines) Git also shows the
original:

```
<<<<<<< HEAD
timeout = 30
||||||| merged common ancestors
timeout = 10
=======
timeout = 60
>>>>>>> feature/retry
```

The base hunk is the most useful part: it tells you what each side was changing *from*. Set it
once and keep it:

```bash
git config --global merge.conflictStyle zdiff3
```

## The resolution loop

```bash
git status                      # "Unmerged paths" lists the conflicted files
git diff --name-only --diff-filter=U   # just the conflicts, scriptable
$EDITOR src/client.py           # keep the right combination, delete the markers
git add src/client.py
git commit                      # or: git merge --continue / git rebase --continue
```

Useful moves while resolving:

| Command | Effect |
|---|---|
| `git checkout --ours <path>` | Take your side of the file wholesale |
| `git checkout --theirs <path>` | Take the incoming side wholesale |
| `git checkout --conflict=diff3 <path>` | Re-create markers with the base section |
| `git diff --cc <path>` | Combined diff showing only conflicted hunks |
| `git merge --abort` | Return to the pre-merge state exactly |
| `git rebase --abort` | Same for a rebase |
| `git log --merge -p <path>` | The commits from each side that touched the file |

`--ours` and `--theirs` are **inverted during a rebase**. In a merge, ours is your branch and
theirs is the branch being merged. In a rebase, Git has checked out the upstream branch and is
replaying your commits onto it, so "ours" is the upstream side and "theirs" is your own commit.
Taking `--ours` during a rebase therefore keeps the other branch's version — a classic way to
delete your own change while believing you kept it.

## Resolve, don't just silence

Three resolutions are common and only one is usually right:

1. **Combine.** Both changes are needed, in some order. This is the normal case and needs
   understanding of both intents.
2. **Pick one.** One side is obsolete. Say so in the commit message; silence looks like an
   accident.
3. **Regenerate.** Generated files — lockfiles, `go.sum`, compiled protobufs, snapshots — should
   almost never be hand-merged. Take one side, then re-run the generator (`npm install`,
   `go mod tidy`, `buf generate`) and commit the real result.

For lockfiles, the correct workflow is to resolve the manifest conflict by hand, then regenerate:

```bash
git checkout --theirs package-lock.json
npm install
git add package-lock.json
```

A hand-merged lockfile passes review and breaks the build a week later.

## Proving the resolution is correct

A conflict resolution is code you wrote, and it is untested until you test it. At minimum:

```bash
git diff --check                 # whitespace errors introduced by marker cleanup
git grep -n '<<<<<<<\|>>>>>>>'   # no leftover markers anywhere
make test                        # or the narrowest suite covering the file
```

After a rebase of several commits, `git range-diff old-base...old-tip new-base...new-tip` shows
what changed between the two versions of the series, which is the fastest way to spot a resolution
that altered a commit it should not have touched.

## Reducing conflicts before they happen

| Cause | Fix |
|---|---|
| Branch open for weeks | Merge or rebase on the main line daily |
| Huge PRs | Split by module; review smaller units |
| Formatting churn | `.gitattributes` + a formatter run in CI, or a `.git-blame-ignore-revs` entry |
| Two people in one file | Agree ownership for the duration, or split the file |
| Generated files | Mark them `-merge` in `.gitattributes` or regenerate |
| Line endings | `* text=auto` in `.gitattributes`, and `core.autocrlf=false` on Linux/macOS |

Custom merge drivers help for structured files:

```gitattributes
CHANGELOG.md merge=union
*.pbxproj merge=union
```

`merge=union` concatenates both sides without conflict markers. It is right for append-only files
and wrong for almost everything else, because it can silently duplicate entries.

## rerere: reuse recorded resolutions

`git rerere` ("reuse recorded resolution") records how you resolved a hunk and replays it when the
same conflict appears again — which is exactly what happens when you rebase the same branch
repeatedly or rebuild a long series.

```bash
git config --global rerere.enabled true
git rerere status        # what it has recorded
git rerere diff          # current resolution vs the original conflict
git rerere forget path   # discard a bad recorded resolution
```

It records by conflict content, so it is safe across branches but not across genuinely different
changes. Enable it globally; it costs nothing when there are no conflicts.

## Common mistakes

- Deleting conflict markers without understanding both sides, leaving code that compiles and
  behaves wrongly.
- Using `--ours`/`--theirs` during a rebase and keeping the wrong side.
- Hand-merging a lockfile or generated file instead of regenerating it.
- Committing with markers still in the file. Git does not scan for them; a grep in CI or a
  pre-commit hook does.
- Resolving a conflict and not running the tests that cover that path.
- `git merge --abort` after starting to resolve and losing the resolution work — abort discards it.

## Production notes

When a merge goes badly wrong, abort rather than fight: `git merge --abort` restores the exact
pre-merge state, and a fresh attempt with `-X ours` or a smaller scope is cheaper than untangling
a half-resolved tree. If the abort itself fails, `git reset --hard` to the hash recorded in
`ORIG_HEAD` (Git sets it before a merge or rebase) is the fallback.

For release branches, cherry-pick the fix rather than merging the whole branch; a merge brings
every unrelated commit with it. Record the original hash with `-x` so the same fix can be found on
both branches later.

Finally, treat a recurring conflict as a design signal. Two teams editing the same registry file
every sprint is a missing seam in the code, not a Git problem.
