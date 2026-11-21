# Files, Permissions and find

File handling is where shell scripts most often go wrong in production: a glob that matched
nothing, a permission that was "fine" as the deploy user, a `find` that deleted one directory too
many. This chapter is the mental model plus the flags that make operations safe.

## Paths, links and names

```bash
ln -s /opt/app/releases/2024-06-01 current   # symlink
readlink -f current                          # resolve fully (GNU)
realpath current                             # same, more portable
dirname  /var/log/app/x.log                  # /var/log/app
basename /var/log/app/x.log .log             # x
mktemp -d                                    # unique temp directory
```

Every path operation must survive spaces, newlines and leading dashes. That means quoting,
`--` before operands, and driving loops from `find -print0` rather than from `ls`. A filename
containing a newline is legal on Linux; it will break any script that assumes otherwise.

Prefer absolute paths computed once (`here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)`)
over relative paths that depend on the caller's working directory — cron, systemd and `sudo`
all start you somewhere unexpected.

## Permission bits

`ls -l` shows ten characters: type, then `rwx` for user, group, other.

```
-rwxr-x---  1 deploy deploy 8123 Jun  1 10:00 deploy.sh
```

`rwx` = 4+2+1 = 7, `r-x` = 5, `---` = 0, so that file is `750`.

| Octal | Symbolic | Meaning |
|---|---|---|
| 7 | `rwx` | read, write, execute |
| 6 | `rw-` | read, write |
| 5 | `r-x` | read, execute |
| 4 | `r--` | read |
| 0 | `---` | none |

```bash
chmod 640 config.yml           # owner rw, group r, others none
chmod u+x,g-w,o= script.sh     # symbolic: add/remove/set per class
chmod -R g+rX dir              # X: execute only on dirs and already-executable files
chown -R app:app /srv/app
umask                          # e.g. 0022 -> new files 644, new dirs 755
```

`X` (capital) is the flag people do not know: `chmod -R a+rX` makes directories traversable
without marking every data file executable. Use it whenever you fix permissions recursively.

Three special bits matter operationally:

- **setuid (4000)** on an executable runs it as the file's owner. On scripts the kernel ignores it
  (Linux); it works only on real binaries. Never design around a setuid shell script.
- **setgid (2000)** on a directory makes new files inherit the directory's group — the standard
  way to build a shared group-writable directory.
- **sticky (1000)** on a directory (`/tmp`) lets only the owner delete their own files.

`umask` is subtractive: `022` removes group and other write. Services that create files consumed
by another user need the umask set explicitly in the unit file or entrypoint, because the
container default may be `0022` while the app expects `0002`.

## Ownership and the "it works as root" failure

Scripts debugged as root hide permission bugs: root can read anything, traverse any directory and
write to any file with the write bit. The script then fails as the service user — often at 3 a.m.

Habits that prevent this:

- Test as the real user: `sudo -u app ./deploy.sh`.
- Check the *directory* permission, not just the file: creating `x.log` in `/var/log/app` requires
  `w` and `x` on the directory.
- Remember that reading a file needs `x` on every parent directory.
- Watch for `noexec` mounts (`/tmp` on hardened images), which make extracted binaries unrunnable.

`id`, `id -u` (`$EUID`), `id -gn`, and `stat -c '%U %G %a %n'` (GNU) or `stat -f '%Su %Sg %Lp %N'`
(BSD) are the diagnostic set.

## find

`find` walks a tree, tests each entry, and acts. The default action is `-print`.

```bash
find . -type f -name '*.log'                      # files only, glob (quote it!)
find . -maxdepth 1 -type d                        # do not descend
find /var/log -type f -mtime +7 -delete           # older than 7 days
find . -type f -newer marker.txt                  # newer than a reference file
find . -type f -size +100M                        # larger than 100 MB (+ rounds up)
find . -type f -perm -o+w                         # world-writable — audit
find . -type l -xtype l                           # broken symlinks
find . -name '*.tmp' -exec rm -- {} +             # batched, safe quoting
find . -type f -print0 | xargs -0 -n 100 gzip     # NUL-safe pipeline
```

The differences that decide correctness:

| Form | Behaviour |
|---|---|
| `-exec cmd {} \;` | One process per file — slow but simple |
| `-exec cmd {} +` | Batched like xargs, no quoting pitfalls — preferred |
| `-print0 \| xargs -0` | Needed when you must pipe, filter or parallelise |
| `-delete` | Implies `-depth`; test the `find` without it first |

`-delete` is irreversible and dangerous in combination with a variable that is empty. The safe
pattern is two-phase: run the `find` with `-print`, inspect the output, then re-run with
`-delete`. Even better, restrict to an explicit root and assert it is non-empty and expected:

```bash
[[ -n $TARGET && -d $TARGET ]] || { echo "bad TARGET" >&2; exit 2; }
find "$TARGET" -maxdepth 1 -type f -name '*.tmp' -mtime +1 -delete
```

`-maxdepth` does not stop `-delete` from following into subdirectories unless you also constrain
type and depth — a `-name '*.tmp' -delete` under `/` is how people lose a machine.

## Disk and space

```bash
df -h /var                 # free space per filesystem
du -sh /var/log/*          # size per entry
du -xh --max-depth=1 / | sort -h    # biggest consumers, same filesystem
lsof +L1                   # deleted files still held open (space not reclaimed)
find /var/log -type f -size +1G -printf '%s %p\n'   # GNU; BSD lacks -printf
```

A deleted-but-open file is the classic "df says full, du says empty" incident: the space returns
when the process closes the descriptor (or is restarted). `lsof +L1` (or `lsof | grep deleted`)
is the answer, and truncating with `: > file` avoids it entirely for logs.

## Common mistakes

- Recursive `chmod 777` to "fix" a permission problem — it removes the diagnosis instead of
  finding it.
- `rm -rf "$DIR"/` where `DIR` is empty and unquoted: `rm -rf /`.
- Globs on paths with spaces, or a glob that matches nothing and gets passed literally.
- Running `find` from `/` with `-delete`.
- Using `-mtime -1` expecting "last 24 hours" — it means "modified within the last calendar-day
  boundary calculation", which is why `-mmin -1440` is clearer for hours.
- Forgetting `noexec` on `/tmp` when a script downloads and runs a binary.
- Editing a running script: bash reads scripts incrementally, so an in-place edit can execute a
  half-old, half-new file. Write a new file and `mv` it.

## Production notes

- Always `mkdir -p` with an explicit mode when the directory must be shared: `mkdir -p -m 2775`.
- Use `mktemp -d` plus a cleanup trap rather than predictable names in `/tmp`.
- Never write secrets to a file with default permissions; `umask 077` before creating it, or
  `install -m 600 /dev/null "$path"`.
- Prefer `install -m 0755 src dst` over `cp` + `chmod` — one command, explicit mode, atomic-ish.
- Audit world-writable files and unowned files (`find / -xdev -nouser -o -nogroup`) as part of
  hardening; both are CIS benchmark items.
