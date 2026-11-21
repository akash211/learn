# Production Scripting — Idempotency, Temp Files and Portability

A script that works once on your laptop and fails on the second run in CI is not finished. The
difference is a set of habits: making operations repeatable, never using predictable temp paths,
being explicit about which shell you require, and testing the thing in the image it will actually
run in.

## Idempotency

An operation is idempotent when running it twice has the same effect as running it once. Almost
every provisioning step can be written this way:

```bash
mkdir -p /srv/app/logs                      # not mkdir
ln -sfn /opt/app/current /srv/app/current    # -n: replace, do not nest
install -d -m 0755 /etc/app
grep -qxF 'export PATH=/opt/bin:$PATH' ~/.bashrc || echo ... >> ~/.bashrc
useradd -m -s /bin/bash app 2>/dev/null || true   # or: id -u app >/dev/null 2>&1 || useradd ...
```

The pattern is "check, then act" or "use the flag that already means 'make it so'". `ln -sfn` is
the one people miss: without `-n`, linking into an existing symlink-to-directory creates the link
*inside* the target directory, and a second run produces `/srv/app/current/current`.

Deletion steps need the same care: `rm -rf "$dir"` is idempotent, `rmdir "$dir"` is not. Directory
creation is idempotent with `-p`; file creation with `>` truncates (idempotent in effect, lossy in
content).

## Atomic writes

A partially written file is worse than no file — a consumer can read half a config, a half JSON
payload, a half-compressed dump.

```bash
tmp=$(mktemp "$dir/.file.XXXXXX")
write_content > "$tmp"
mv -f -- "$tmp" "$final"        # rename(2) within the same filesystem: atomic
```

The requirements are: same filesystem (`mv` across devices is copy+delete, not atomic), same
directory (so permissions and SELinux context are right), and `mktemp` in that directory rather
than in `/tmp`. This is exactly how package managers and config management tools replace files.

For "append a line once", the atomic version is a lock (`flock`) plus a check; a bare `>>` under
concurrency interleaves writes.

## Temp files and cleanup

```bash
tmpdir=$(mktemp -d) || exit 1
cleanup() { local rc=$?; rm -rf -- "$tmpdir"; exit "$rc"; }
trap cleanup EXIT
```

Rules:

- `mktemp`, never `/tmp/myapp.$$` — `$$` is guessable and reused, which is a symlink-attack and a
  collision in one.
- Clean up in an `EXIT` trap, and remember `kill -9` cannot be trapped: a crashed run leaves the
  directory behind. `systemd-tmpfiles` or a periodic sweep handles that residue.
- Put temp files on the same filesystem as the destination when you intend to `mv` them.
- `umask 077` before creating anything that might contain credentials, or `install -m 600`.
- For scratch space inside a container, `/tmp` may be a small tmpfs — check `df` before writing
  gigabytes there.

## Locking

```bash
exec 9>/var/lock/app-sync.lock
flock -n 9 || { echo "another sync is running" >&2; exit 0; }
```

`flock` holds the lock for the lifetime of the open descriptor, so it is released when the script
exits or is killed — no stale lock files. `-n` fails immediately instead of queueing; `-w 30`
waits up to 30 seconds. This is the correct answer to "cron job overlaps itself".

PID-file locking is the older pattern and has two failure modes: PID reuse and a stale file after
`kill -9`. If you must use it, check `ps -p "$pid" -o cmd=` and store the process start time.

## Portability: POSIX sh versus bash

`#!/bin/sh` is a contract. On Debian/Ubuntu it is `dash`; on Alpine, `busybox ash`; on macOS,
bash in POSIX mode. Writing to that contract means giving up:

| Feature | POSIX sh | bash |
|---|---|---|
| `[[ ]]` | no | yes |
| Arrays (`a=(1 2)`) | no | yes (4+ for associative) |
| `local` | not specified (widely supported) | yes |
| `$'...'` | no | yes |
| `<<<` herestrings | no | yes |
| Process substitution `<(...)` | no | yes |
| `${v//a/b}`, `${v^^}` | no | yes |
| `+=` for variables | no | yes |
| `set -o pipefail` | no (dash has no pipefail) | yes |
| `function name { }` | no | yes |
| `source` | no (use `.`) | both |

Note the last few well: `pipefail` is **not** POSIX, so a `#!/bin/sh` script cannot rely on it, and
`local` is common but not standardised (POSIX leaves it unspecified; most shells have it).

Practical portability rules:

- Use `command -v tool` rather than `which` (which is an external program with inconsistent
  behaviour and exit codes).
- Use `printf '%s\n'` rather than `echo -e`; `echo` behaviour varies.
- Use `${var}` braces in all expansions that are concatenated.
- Avoid `test -a`/`-o`; use `[ ... ] && [ ... ]`.
- Use `$(...)` not backticks; they nest without escaping.
- `sort -h`, `sed -i` and `grep -P` are GNU extensions — detect or avoid.
- `readlink -f` is GNU; `realpath` is the more portable spelling, though also not universal on
  very old systems.
- Quote `"$@"`, always.

Detect at startup rather than failing mid-run:

```bash
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 127; }; }
for t in curl jq tar gzip; do need "$t"; done
[[ ${BASH_VERSINFO[0]} -ge 4 ]] || { echo "bash 4+ required" >&2; exit 1; }
```

## Environment hygiene

- `set -u` plus explicit defaults: `${PORT:-8080}`.
- `cd -- "$(dirname -- "$0")" || exit 1` only if you truly need the script's directory; prefer
  absolute paths passed in.
- Clear the environment for child processes when it matters: `env -i PATH=/usr/bin:/bin cmd`.
- Set `PATH` explicitly in cron and systemd, which do not inherit your shell's profile. This is the
  number-one "works interactively, fails in cron" cause after `cd`.
- `LC_ALL=C` for parsing; `TZ=UTC` for logs and date arithmetic.
- `export -n` or `unset` any variable you no longer want inherited.

## Testing

```bash
bash -n script.sh            # syntax check, no execution
shellcheck script.sh         # static analysis: quoting, traps, useless cat, SC2086...
bash -x script.sh            # trace (noisy; use PS4='+$LINENO: ' to see line numbers)
```

`bats` gives real unit tests for functions:

```bash
@test "parses --env flag" {
  source lib/args.sh
  run parse_args --env prod
  [ "$status" -eq 0 ]
  [ "$output" = "prod" ]
}
```

Test the three failure modes explicitly: missing argument, missing dependency, unwritable
destination. Those are the paths nobody exercises manually and the ones that run at 3 a.m.

## Common mistakes

- `mktemp` for the file but `mv` across filesystems, so the "atomic" write is not atomic.
- Assuming `#!/bin/sh` supports `[[ ]]` or arrays because it worked locally.
- `which` in a script; `command -v` is the portable test.
- Relying on the caller's `PATH` or working directory.
- Trapping EXIT but forgetting `kill -9` leaves residue, so the next run must tolerate a stale
  temp directory.
- Locking with a PID file and no liveness check.
- Editing a script in place while it is running (bash reads incrementally) — write a temp file and
  `mv`.
- Using `#!/bin/bash` in a `FROM alpine` image where bash is not installed. Use `sh`, or install
  bash deliberately.

## Production notes

- A script over ~300 lines with data structures, retries and error taxonomy is a program; write it
  in Python or Go and keep the shell for orchestration. That decision is a senior-level judgement,
  not a failure.
- Version scripts in the repo, run `shellcheck` in CI, and fail the build on warnings — a lint gate
  is cheaper than an incident.
- Add `--dry-run` to anything destructive. Print what would happen, let a human read it, then run
  for real.
- Emit a single summary line at the end (`synced 14/14 targets in 32s`) so the log's last line is
  the outcome, and return a status that matches it.
