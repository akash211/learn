# Pipes, Redirection and Process Substitution

Redirection is how a shell script talks to the world: three file descriptors, a set of operators,
and an ordering rule that determines whether your error messages end up in the log file or on the
terminal. Pipelines are how it composes programs without intermediate files.

## The three descriptors

| FD | Name | Default |
|---|---|---|
| 0 | stdin | terminal |
| 1 | stdout | terminal |
| 2 | stderr | terminal |

Everything else — a fourth descriptor for a lock file, a ninth for a coprocess — is bookkeeping on
top of those three.

```bash
cmd > out.txt             # stdout to file, truncate
cmd >> out.txt            # append
cmd 2> err.txt            # stderr to file
cmd > out.txt 2>&1        # both to the same file
cmd &> out.txt            # bash shorthand for the above
cmd 2>&1 > out.txt        # WRONG ORDER: stderr to terminal, stdout to file
```

That last pair is the most asked redirection question. Redirection is evaluated left to right, and
`2>&1` means "make fd 2 a *copy of whatever fd 1 currently points at*". In
`cmd 2>&1 > out.txt`, fd 2 is duplicated from the terminal first, then fd 1 is repointed at the
file — so errors still go to the terminal. `> out.txt 2>&1` does what people intend.

Order also matters for logging: `cmd >> log 2>&1` appends both streams to one file, but stdout and
stderr are separately buffered, so interleaving is approximate for anything but line-buffered
output.

## Reading and writing

```bash
cmd < input.txt                 # stdin from file
while IFS= read -r line; do     # the only safe line loop
  printf '%s\n' "$line"
done < input.txt                # note: redirect on `done`, not on `read`

grep foo <<< "$var"             # herestring: adds a trailing newline
cat <<'EOF' > config.ini        # quoted delimiter: no expansion inside
key=$value
EOF
```

Quoting the heredoc delimiter (`<<'EOF'`) disables `$var`, `$(cmd)` and backslash processing — the
right choice for templates you want verbatim, and essential when generating other scripts.
`<<-EOF` strips leading **tabs** (not spaces) so you can indent the body inside a function.

`exec` changes the current shell's descriptors permanently:

```bash
exec 3<>"$tmp/data"        # open fd 3 for read+write
exec 3>&-                  # close it
exec >> /var/log/app.log 2>&1   # from here on, everything appends to the log
```

The second form is a common daemon trick: redirect once, then every subsequent command and every
child inherits it. The risk is that a later `set -x` trace also lands in the log, including any
secrets you passed as arguments.

`noclobber` (`set -C`) makes `>` refuse to overwrite an existing file; `>|` bypasses it. It is
rarely worth the confusion, but it is the POSIX-safe "do not truncate a file someone else owns"
guard.

## Pipelines

```bash
grep ERROR app.log | awk '{print $5}' | sort | uniq -c | sort -rn | head
```

Each stage runs in its own process, connected by pipes — unidirectional, in-memory, kernel-buffered
(64 KiB by default on Linux). Two consequences:

- Stages run **concurrently**. `producer | consumer` does not wait for the producer to finish;
  this is why `yes | head -1` terminates at all.
- Each stage of a pipeline other than the last runs in a **subshell** (bash; `lastpipe` changes the
  last one). Variables set there do not survive:

```bash
count=0
grep -c foo file | read -r count    # count is still 0 in this shell
```

`PIPESTATUS` (bash) holds every stage's status, and must be read immediately:

```bash
set -o pipefail
curl -fsS "$url" | gzip > dump.gz
rc=("${PIPESTATUS[@]}")           # e.g. (0 0)
```

Without `pipefail`, `curl | gzip` reports success whenever `gzip` succeeds — including when curl
failed and gzip cheerfully compressed an empty stream. That single default is responsible for more
silent bad backups than any other shell behaviour.

### SIGPIPE

When a reader exits early (`head -1`, `grep -q`), the writer gets SIGPIPE on its next write and
exits 141. Under `pipefail` that counts as failure — and under `set -e` it kills the script:

```bash
set -euo pipefail
seq 1 1000000 | head -1        # exits 141, script dies
```

Fixes: read without a pipe (`read -r first < <(seq 1 1000000)`), tolerate it for that one line
(`... || [[ $? -eq 141 ]]`), or accept `|| true` when the truncation is intentional. Do not remove
`pipefail` globally to fix one pipeline.

## Process substitution

`<(cmd)` and `>(cmd)` present a command's output (or input) as a path — `/dev/fd/63` on Linux:

```bash
diff <(sort a.txt) <(sort b.txt)
while IFS= read -r line; do ...; done < <(find . -name '*.log' -print0 | xargs -0 ...)
tee >(gzip > out.gz) >(wc -l > count.txt) < input.txt
```

This is the clean answer to "loop over command output without losing variables": the `while` runs
in the current shell because `< <(...)` is a redirect from a file, not a pipe.

Limits worth knowing: process substitution needs bash/ksh/zsh (no POSIX `sh`), the `/dev/fd` path
does not survive being passed to a process that reopens it later, and the substituted process's
exit status is **not** checked. `diff <(failing_cmd) file` can compare against empty output and
succeed.

## xargs

`xargs` turns stdin into arguments. Defaults are dangerous — it splits on whitespace and quotes:

```bash
find . -name '*.log' -print0 | xargs -0 rm -f          # -0: NUL-delimited, mandatory
find . -name '*.jpg' -print0 | xargs -0 -n 50 -P 4 convert ...
printf '%s\n' "${files[@]}" | xargs -d '\n' -I{} cp -- {} /backup/
xargs -a urls.txt -n 1 -P 8 curl -fsSO
```

`-n` bounds arguments per invocation, `-P` runs in parallel, `-I{}` gives one line per invocation
with the placeholder replaced, `-r` (GNU) prevents running the command at all on empty input — the
difference between "no files matched" and `rm -f` with no operands.

Prefer `find -exec ... +` when you can: it batches like `xargs` and has no quoting pitfalls.

## Buffering

Output through a pipe is block-buffered, not line-buffered, so `tail -f` on a log written through a
pipe looks frozen. `stdbuf -oL cmd` (GNU coreutils) forces line buffering, `unbuffer` (expect) does
it via a pty, and setting `PYTHONUNBUFFERED=1` fixes Python specifically. `script -q /dev/null cmd`
is the pty trick that works when `stdbuf` does not.

## Common mistakes

- `2>&1 > file` ordering, then wondering why errors are not in the log.
- Using `cat file | cmd` where `cmd < file` works; the extra process also destroys `PIPESTATUS`
  semantics for the real command.
- Reading `PIPESTATUS` after another command has already overwritten it.
- `while read` in a pipeline and expecting variables to persist.
- `xargs` without `-0` on filenames containing spaces.
- Assuming `<(cmd)` propagates failure.
- Leaving `pipefail` off and treating `dump | gzip` as a valid backup.

## Production notes

- Standard log idiom: `exec >>"$LOG" 2>&1` after argument validation, so every later line is
  captured; write the validation errors before it.
- Never `2>/dev/null` on a command whose failure you need to diagnose; redirect to a file you can
  read on failure instead.
- Use `mktemp` for intermediate files, not `$$`-named paths in `/tmp` — see the production chapter.
- Log pipeline failures with `PIPESTATUS` explicitly: "curl failed with 22" is a different incident
  from "gzip failed with 1".
