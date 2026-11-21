# Releases, Tags, Semantic Versioning and Changelogs

A release is a promise: this commit, these artefacts, this version number. Git's part is the tag;
GitHub's part is the Release object and its assets; the hard part is deciding what the number
means and making the changelog true.

## Two kinds of tag

| | Lightweight | Annotated |
|---|---|---|
| Command | `git tag v1.4.0` | `git tag -a v1.4.0 -m "1.4.0"` |
| Object | A ref pointing straight at a commit | A tag object with tagger, date, message, optional signature |
| Contains | Nothing extra | Who released it, when, why |
| `git describe` | Ignored by default | Used |
| Appropriate for | Local bookmarks | Anything published |

Annotated tags are the right default for releases because they carry provenance. Signed tags add
verification:

```bash
git tag -s v1.4.0 -m "1.4.0: retry budget for uploads"
git verify-tag v1.4.0
git show v1.4.0            # tag object, then the commit it points at
git rev-parse v1.4.0^{}    # peel to the commit hash
```

The `^{}` matters in scripts: `git rev-parse v1.4.0` on an annotated tag returns the *tag object*
hash, not the commit. Build systems that record "the commit for this release" need the peeled
form.

## Tagging the right commit

A tag points at one commit. For a release cut from `main`, that is usually the merge commit (or
squashed commit) that concluded the release PR — not an arbitrary later commit that happens to be
green. Tagging a merge commit records which branch was integrated; tagging a squash commit records
the whole change as one.

```bash
git switch main && git pull --ff-only
git tag -a v1.4.0 -m "1.4.0"
git push origin v1.4.0        # tags are not pushed by a normal branch push
git push --follow-tags        # annotated tags reachable from the pushed commits
git push --tags               # every tag, including ones you did not mean to publish
```

`--follow-tags` is the safer habit: it sends annotated tags that are reachable from the refs being
pushed, and skips lightweight local bookmarks.

Tags are refs, so they can be moved or deleted — `git tag -f`, `git push --force origin v1.4.0`.
Do not. A published tag may already be in a container image label, a lockfile, a customer's build
or another repository's submodule pointer. If a release is wrong, publish a new patch version and
mark the old one as bad; rewriting the tag makes two different artefacts claim the same identity.
Protect release tags with a tag ruleset where the platform supports it.

## Semantic versioning

`MAJOR.MINOR.PATCH`, with the contract attached to the numbers:

- **MAJOR** — incompatible API change.
- **MINOR** — backwards-compatible functionality.
- **PATCH** — backwards-compatible bug fix.

Pre-release identifiers sort before the release: `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta.2 <
1.0.0-rc.1 < 1.0.0`. Build metadata (`1.0.0+20260101.abc1234`) is ignored for precedence, which
makes it safe for commit stamps but useless for ordering. For `0.y.z`, the spec says anything may
change at any time; treat minor bumps as potentially breaking and do not promise stability you
have not shipped.

Semver describes an API, not a repository. A monorepo with five packages has five versions; a
service with no public API has a version only for deployment traceability. Applying semver to an
internal application is mostly a convention for changelog discipline, and that is fine as long as
nobody pretends a patch bump guarantees anything.

## Deriving a version from history

Two approaches, and mixing them causes drift:

**Tag-driven.** The tag is the single source of truth. CI reads it and stamps the artefact.

```bash
git describe --tags --always --dirty
# v1.4.0-12-gab12cd3  → 12 commits after v1.4.0, at ab12cd3, dirty tree
git describe --tags --match 'v*' --abbrev=0
```

**Commit-driven.** Tooling inspects commit messages since the last tag and computes the next
version, then creates the tag. `release-please`, `semantic-release`, `changie` and `changesets`
work this way.

Commit-driven release needs conventional commit discipline:

```
feat(upload): retry transient 5xx with backoff
fix(auth): refresh token before expiry
feat(api)!: drop /v1/upload                 # ! marks a breaking change
```

`feat` → minor, `fix` → patch, `!` or a `BREAKING CHANGE:` footer → major. Anything else is
ignored by the version calculation, which is why `chore:` and `docs:` commits do not produce
releases. If the team will not write consistent messages, use tag-driven releases and a
hand-written changelog; a generator fed inconsistent input produces a confident, wrong changelog.

## Changelogs

A changelog is for users, not for Git. `git log --oneline v1.3.0..v1.4.0` is the raw material;
the published document groups by impact and explains migration.

```markdown
## [1.4.0] - 2026-11-21

### Added
- Retry transient 5xx responses from the upload service (#482)

### Changed
- `upload()` now returns `UploadResult` instead of a tuple (#491)

### Fixed
- Token refresh raced with request signing (#487)

### Breaking
- Removed `upload_legacy()`. Use `upload()`; see docs/migration-1.4.md.
```

Keep a Changelog's categories (Added, Changed, Deprecated, Removed, Fixed, Security) are a
reasonable default. Link the PR or issue, not the commit hash — hashes mean nothing to users and
break when history is rewritten.

```bash
git-cliff --tag v1.4.0 -o CHANGELOG.md
gh release create v1.4.0 --generate-notes --title "1.4.0"
```

GitHub's generated notes group merged PRs by label and list contributors; they are a good
starting point and a poor final document, because they describe pull requests rather than
user-visible changes.

## Release branches and hotfixes

For software with supported versions, cut a branch at the release commit and keep it alive:

```bash
git switch -c release/1.4 v1.4.0
git switch -c hotfix/1.4.1 release/1.4
# fix, test
git commit -am "fix: handle empty manifest"
git tag -a v1.4.1 -m "1.4.1"
git push origin release/1.4 v1.4.1
```

The fix must also land on `main`, either by merging the hotfix branch or cherry-picking it with
`-x` for traceability. Do not merge `main` into the release branch to pick up a fix — that drags
every unreleased change into a patch release. Cherry-pick the specific commits.

## GitHub Releases

A Release is a GitHub object attached to a tag: title, notes, assets, draft/prerelease flags. It
does not exist in Git, so a clone knows the tag but not the release notes or binaries. Publishing a
Release also creates the tag if it does not exist, which is convenient and occasionally produces a
tag on the wrong commit when run from the wrong branch.

```bash
gh release create v1.4.0 dist/*.whl --title "1.4.0" --notes-file CHANGELOG.md
gh release create v1.5.0-rc.1 --prerelease --generate-notes
gh release download v1.4.0
```

Mark release candidates as prereleases so they do not become "latest", and keep release assets
reproducible: attach the artefact whose digest is recorded in the provenance attestation, not a
locally rebuilt one.

## Common mistakes

- Pushing a branch and assuming the tag went with it.
- Tagging a commit that is not on any branch, so nobody can find it later.
- Moving a published tag to "fix" a release.
- Bumping the major version for an internal refactor that changed no API.
- Generating a changelog from inconsistent commit messages and shipping it unread.
- Merging `main` into a release branch and shipping unreleased features.
- Using `git rev-parse <tag>` in a script and recording the tag object hash as the commit.

## Production notes

Put the version in exactly one place and derive everything else. A `package.json`, `pyproject.toml`
or `Cargo.toml` version that disagrees with the tag is a recurring source of "the image says 1.4.0
but the tag says 1.4.1". Pick either "tag is truth, build stamps it" or "file is truth, release
tooling updates it and creates the tag", never both.

Automate the release PR: a workflow that opens a version-bump PR on merge to `main`, and tags when
that PR merges, gives reviewable releases with a clean audit trail. Keep the signing key or OIDC
role scoped to that workflow and to the release environment.
