# Objects, Refs and the Commit DAG

Every confusing Git behaviour becomes predictable once you hold one picture in your head: an
append-only store of immutable objects, plus a small set of labels that move. This chapter builds
that picture from the plumbing up, because `reset`, `rebase` and `force-push` are only
frightening while the graph is abstract.

## Everything is content-addressed

Git stores data as objects named by the SHA-1 hash of their contents and type. The name is not
assigned; it is computed, which gives three properties for free: identical content is stored once,
any corruption changes the hash and is detected, and two repositories that receive the same
object can verify they received the same bytes. Git also supports SHA-256 repositories
(`git init --object-format=sha256`), producing 64-character names; the object model is identical
and the hash length is the only visible difference. SHA-1 collision detection was hardened after
the 2017 SHAttered attack, which is why a deliberately colliding pair is rejected rather than
silently stored.

The hash covers a header (`blob 12\0`, then the bytes), so a blob and a tree with the same payload
still hash differently.

## The four object types

| Object | Holds | Identified by |
|---|---|---|
| blob | Raw file bytes. No name, no mode, no history. | Hash of content |
| tree | Sorted list of `mode type hash name` entries; can point at blobs or subtrees | Hash of entries |
| commit | One tree, zero or more parent commits, author, committer, message | Hash of that payload |
| tag | Annotated tag: target object, tagger, message, optional signature | Hash of that payload |

A directory is a tree, and a file is a blob. Renames are not stored: Git records a delete and an
add, and detects renames later by similarity when it displays a diff. That is why `git log
--follow` is heuristic and why a rename plus heavy edit can look like two unrelated changes.

You can inspect all of this without a working tree:

```bash
git cat-file -t HEAD          # commit
git cat-file -p HEAD          # tree, parent, author, message
git cat-file -p HEAD^{tree}   # the root tree: modes, types, hashes, names
git cat-file -s HEAD:README.md # size in bytes
git hash-object -w notes.txt   # write a blob, print its hash
```

`HEAD^{tree}` means "dereference HEAD to a commit, then take its tree". The same `rev^{}` syntax
peels an annotated tag to the commit it points at, which matters constantly in release scripts.

## Refs are labels; HEAD is a label pointing at a label

A ref is a file containing a hash. Loose refs live under `.git/refs/`; once there are many, Git
packs them into `.git/packed-refs` and the loose file wins if both exist.

- `refs/heads/main` — a local branch. A branch is a movable pointer to one commit, nothing more.
- `refs/remotes/origin/main` — your last known position of `main` on the remote. It only changes
  when you fetch or push.
- `refs/tags/v1.4.0` — a tag, expected to be stable once published.
- `HEAD` — normally a symbolic ref: the file contains `ref: refs/heads/main`, not a hash.

Because `HEAD` points at a branch, committing updates the branch and `HEAD` follows. When you
check out a commit hash instead of a branch, `HEAD` contains the hash directly and you are in
**detached HEAD**: commits you make are reachable only through `HEAD` and the reflog, and
switching away orphans them. That is not corruption, it is the graph working as designed.

```bash
git symbolic-ref HEAD            # refs/heads/main
git rev-parse --abbrev-ref HEAD  # main (or HEAD when detached)
git show-ref --heads             # every local branch and its hash
git update-ref refs/heads/tmp HEAD  # plumbing equivalent of git branch tmp
```

## The DAG and reachability

Each commit points to its parents, so history is a directed acyclic graph walked backwards. A
branch name is just an entry point; the commits it can reach are its history. `main` and
`feature` share everything below their merge base and diverge above it.

Reachability explains the operations that scare people:

- `git reset` moves a branch pointer. Commits that were only reachable from the old position
  become unreachable — still on disk, still in the reflog, eventually collected by `git gc`.
- `git commit --amend` writes a new commit object and moves the branch to it. The original is
  unreachable but recoverable by hash or reflog. Nothing is ever edited in place.
- `git push --force` moves a remote ref to a commit that may not descend from the old one. The
  server keeps the old objects until its own GC runs, which is why recovery depends on how fast
  you act and whether anyone still has the old commit locally.

Objects with no ref reaching them are garbage. `git fsck --unreachable` lists them, and
`git gc` prunes ones older than the grace period.

## Naming commits

| Expression | Meaning |
|---|---|
| `HEAD~2` | First-parent grandparent: two commits back along the main line |
| `HEAD^2` | Second parent of a merge commit (the branch that was merged in) |
| `main@{yesterday}` | Where `main` pointed yesterday, from the reflog |
| `A..B` | Commits reachable from B but not A — "what B adds" |
| `A...B` | Symmetric difference: commits on either side since the merge base |
| `:/fix login` | Most recent commit whose message matches the regex |

`A..B` is what `git log main..feature` uses and what a pull request shows. `A...B` is what
`git diff main...feature` uses, and it is usually what you want when reviewing a branch: the
three-dot diff compares the merge base to the branch tip, so unrelated commits added to `main`
after the branch started do not pollute the diff.

## Packfiles and what "size" means

Loose objects are zlib-compressed files. `git gc` packs them into a packfile with delta
compression against similar objects, plus a `.idx` for random access. This is why a repository
with a long history of similar text is far smaller than the naive sum of its files, and why
committing large binaries repeatedly is expensive: each version is a new blob that deltas poorly.

```bash
git count-objects -vH      # loose and packed size, object counts
git verify-pack -v .git/objects/pack/*.idx | sort -k3 -n | tail
```

The second command shows the largest objects in the pack — the standard way to find out why a
clone is 2 GB.

## Common mistakes

- Believing a commit stores a diff. It stores a full tree; diffs are computed on demand.
- Believing `git checkout <sha>` puts you on a branch. It detaches `HEAD`.
- Treating `origin/main` as live. It is a cache updated by fetch and push, nothing else.
- Assuming renames are recorded. They are detected, with a similarity threshold.
- Thinking `git reset --hard` deletes commits. It moves a ref; the objects survive until GC.
- Expecting `git log` to show everything. It shows what is reachable from `HEAD` unless you pass
  `--all`.

## Production notes

When a repository is slow to clone or fetch, measure before changing workflow: `git count-objects
-vH` and `git verify-pack` identify oversized blobs, and `git rev-list --objects --all` piped
through a sort finds the paths that own them. Deleting the file in a new commit does not shrink
the clone; the blob is still reachable from history, and only a history rewrite or LFS migration
removes it.

On CI, shallow clones (`--depth=1`) save time but remove history: `git describe` fails, `git
diff origin/main...HEAD` has no merge base, and `git blame` degrades. `actions/checkout` defaults
to depth 1, so any job doing version derivation or changed-file detection needs `fetch-depth: 0`
or an explicit `git fetch --deepen`.
