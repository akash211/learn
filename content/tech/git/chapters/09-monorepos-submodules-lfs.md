# Monorepos, Submodules and Large Files

Git was designed for a kernel tree: many files, many contributors, mostly text. Monorepos,
vendored dependencies and binary assets push against that design, and each has a specific
mitigation. The underlying rule is constant: **history keeps every byte you ever committed**, so
the only real fixes are not committing it, or rewriting history.

## Monorepo trade-offs

A monorepo puts many projects in one repository. The benefits are real: atomic cross-project
changes, one review workflow, one CI configuration, no version skew between internal packages.
The costs are also real:

| Cost | Symptom |
|---|---|
| Clone and checkout size | 10-minute clones, CI spending minutes on `checkout` |
| CI selectivity | Every PR runs every job |
| Ownership | CODEOWNERS files become the actual architecture |
| Blast radius | One broken commit blocks every team |
| Tooling | Needs a build graph to avoid rebuilding the world |

Polyrepos trade those for dependency management and version coordination. Neither is universally
right; the failure mode is choosing a monorepo and then not investing in the tooling that makes it
workable.

### Making checkout cheap

Partial clone and sparse checkout are the two levers:

```bash
# blobless clone: full commit/tree history, file contents fetched on demand
git clone --filter=blob:none --sparse https://github.com/acme/monorepo.git
cd monorepo
git sparse-checkout set apps/web libs/ui
```

- `--filter=blob:none` omits file contents; `git log`, `git log -- <path>` and `git diff` on trees
  still work, and blobs are fetched lazily when read. This is the default that GitHub recommends
  for large repositories.
- `--filter=tree:0` (treeless) goes further and fetches trees lazily too; good for CI jobs that
  only need one commit.
- `git sparse-checkout` narrows the working tree to selected directories. Cone mode takes
  directories, not globs, which is what makes it fast.
- `--sparse-index` (Git 2.34+) keeps the index itself sparse, so commands like `git status` do not
  scale with the number of files outside the cone.

```bash
git sparse-checkout add services/billing
git sparse-checkout list
git sparse-checkout disable      # back to a full checkout
```

Partial clone requires server support; GitHub, GitLab and modern `git-http-backend` all provide
it. A clone from such a server records a promisor remote, and later fetches can use a different
filter.

`scalar clone <url>` wraps the same settings (partial clone, sparse checkout, fsmonitor, commit
graph, scheduled maintenance) for very large repositories. It is a convenience, not a different
Git.

### Making CI selective

Running every job on every PR is the usual reason a monorepo "becomes slow". Fix it with a changed
path filter, not by splitting the repository reflexively:

```yaml
- uses: dorny/paths-filter@v3
  id: changes
  with:
    filters: |
      web:
        - 'apps/web/**'
      api:
        - 'services/api/**'
- if: steps.changes.outputs.web == 'true'
  run: make -C apps/web test
```

Build systems such as Nx, Turborepo and Bazel do this from the dependency graph, which also
handles "web depends on libs/ui, so a change to libs/ui must rebuild web". Path filters alone do
not understand that. Combine either approach with a merge queue, or two green PRs will still
break `main`.

## Worktrees instead of stashing

A worktree is a second working directory attached to the same repository, with its own `HEAD` and
index:

```bash
git worktree add ../hotfix-1.4 release/1.4
git worktree list
git worktree remove ../hotfix-1.4
```

This is the correct answer to "I need to fix production while my branch is half-finished". It
beats `git stash` because both trees stay live, and beats a second clone because objects and refs
are shared. A branch can only be checked out in one worktree at a time.

## Submodules

A submodule is a Git repository nested inside another, recorded as a **gitlink**: a tree entry with
mode `160000` pointing at a commit in the other repository. `.gitmodules` stores the URL and path.

```bash
git submodule add https://github.com/acme/protobufs.git vendor/protobufs
git commit -m "vendor: add shared protobufs"
git clone --recurse-submodules https://github.com/acme/app.git
git submodule update --init --recursive
git submodule status
```

What trips people up:

- **The parent repo records a commit, not a branch.** Updating the submodule means checking out a
  new commit inside it and committing the new gitlink in the parent. `git submodule update
  --remote` moves to the tip of the tracked branch, but the parent still has to commit the change.
- **Fresh clones get an empty directory** unless you pass `--recurse-submodules` or run `git
  submodule update --init`. CI must do the same (`submodules: recursive` on `actions/checkout`).
- **Detached HEAD is normal.** `git submodule update` checks out a specific commit; commits made
  there are not on any branch until you create one and push.
- **Deleting a submodule** requires more than `rm -rf`: `git submodule deinit -f path`, `git rm
  path`, then remove the `.git/modules/path` directory and the `.gitmodules` entry.

```bash
git submodule foreach 'git fetch --all && git checkout origin/main'
git submodule update --remote --merge
git submodule absorbgitdirs      # move .git dirs into the parent's .git/modules
```

Submodules are appropriate when the dependency is a separate repository with its own release
cadence that you genuinely want to pin. They are inappropriate as a package manager: every
developer needs access to every submodule repository, and CI must clone them all.

## Subtrees

`git subtree` copies another repository's history into a subdirectory of the parent. Consumers
need no special tooling — it is just files.

```bash
git subtree add --prefix=vendor/lib https://github.com/acme/lib.git main --squash
git subtree pull --prefix=vendor/lib https://github.com/acme/lib.git main --squash
git subtree push --prefix=vendor/lib https://github.com/acme/lib.git main
```

Compared with submodules: simpler for consumers, no extra clone step, but the history is duplicated
and `push` re-splits it, which is slow on large histories. Choose subtrees when you want to vendor
code and forget about it; submodules when the nested repository must stay independently
authoritative.

## Git LFS

Large File Storage replaces big binaries with small pointer files and stores the content on a
separate server. It reduces clone size only if the binaries are actually large and change rarely.

```bash
git lfs install
git lfs track "*.psd" "*.zip"
git add .gitattributes
git lfs ls-files
git lfs migrate import --include="*.zip" --everything
```

The pointer file is a few lines of text; the real object lives on the LFS endpoint. Consequences:

- `git clone` without LFS installed yields pointer files, not content.
- CI checkout needs `lfs: true`, and the runner needs network access to the LFS endpoint.
- Bandwidth and storage are metered separately on most hosts, and CI re-downloading large assets
  on every run gets expensive.
- `git lfs migrate import` rewrites history, so coordinate it like any other rewrite.
- LFS does not help with build outputs that change every commit; do not commit those at all.

## Deleting a large file that is already committed

```bash
git rm --cached huge.bin
echo "huge.bin" >> .gitignore
git commit -m "chore: stop tracking huge.bin"
```

This stops future tracking; the blob remains in history and every clone still downloads it.
Removing it requires a rewrite:

```bash
git filter-repo --path huge.bin --invert-paths
```

Everyone must re-clone or reset to the rewritten history, and open PRs must be rebased. Plan it,
announce it, and do it on a fresh mirror clone.

## Common mistakes

- Committing build outputs, datasets or virtualenvs "just this once", then paying for it in every
  clone forever.
- Adding a submodule and not documenting the `--recurse-submodules` requirement.
- Expecting a submodule to follow a branch automatically.
- Using LFS for files that compress well or change constantly.
- `git rm` on a large file and believing the repository shrank.
- Turning a monorepo into a monorepo without path-filtered CI, then blaming Git for the queue.

## Production notes

Measure clone cost with `git count-objects -vH` and `git verify-pack -v`. If the pack is dominated
by a handful of blobs, find the paths with `git rev-list --objects --all | git cat-file
--batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | sort -k3 -n | tail`.

In CI for monorepos, always set a job timeout, use shallow or partial clones, and cache the build
graph rather than the working tree. And keep one full, unshallow mirror somewhere for release
tooling and `git describe`: partial clones are excellent for developers and fragile for
version-derivation scripts that assume history is present.
