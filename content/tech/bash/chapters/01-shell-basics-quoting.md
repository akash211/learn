# Shell Basics and Quoting Rules

A shell script is a list of words that the shell expands and then executes. Two ideas carry most
of the chapter: the shell is a *macro processor* that rewrites your line before anything runs, and
quoting is how you tell it which characters to leave alone. Almost every "the script does something
weird" bug is one of those two.

## What runs your script

The first line decides the interpreter:

```bash
#!/usr/bin/env bash
```

`#!/usr/bin/env bash` finds `bash` on `PATH`, which is what you want on macOS, NixOS and anywhere
bash is not at `/bin/bash`. `#!/bin/sh` promises POSIX behaviour — and on Debian, Ubuntu and Alpine
`/bin/sh` is `dash` or `busybox ash`, which have no arrays and no `[[`. Pick deliberately; do not
write bash syntax under a `sh` shebang.

Execution has three entry points with different semantics:

| Invocation | Effect |
|---|---|
| `./script.sh` | Needs the executable bit and a shebang; runs in a child process. |
| `bash script.sh` | Ignores the shebang and the executable bit; runs in a child process. |
| `source script.sh` / `. script.sh` | Runs in the *current* shell, so variables, functions and `cd` persist. |

That last row is the one people forget: sourcing a script that calls `exit` exits your interactive
shell, and sourcing one that sets `IFS` changes every later command.

## The expansion pipeline

Bash processes a command line in a fixed order. Knowing the order explains the surprising cases:

1. **Tokenising** — split on metacharacters (`|`, `&`, `;`, `(`, `)`, `<`, `>`).
2. **Brace expansion** — `{a,b}.txt` → `a.txt b.txt`; `{1..3}` → `1 2 3`. Purely textual, runs first.
3. **Tilde expansion** — `~`, `~user`.
4. **Parameter, command and arithmetic expansion** — `$VAR`, `$(cmd)`, `$((1+2))`.
5. **Word splitting** — unquoted results are split on `IFS` (space, tab, newline by default).
6. **Pathname expansion (globbing)** — `*`, `?`, `[a-z]`.
7. **Quote removal** — the quotes themselves disappear.

The consequences are concrete:

```bash
f="my file.txt"
ls $f          # two arguments: "my" and "file.txt"  -> word splitting
ls "$f"        # one argument: "my file.txt"          -> correct

x="*"
echo $x        # expands to every file in the directory (globbing)
echo "$x"      # literal *
```

Note that `x="*"` is *not* a quoting problem at assignment time — the assignment quotes already.
The glob happens on the later unquoted `echo $x`. Globbing runs after splitting, so a variable
containing `*` cannot be protected by changing `IFS`.

## The four quoting forms

| Form | Protects | Expands |
|---|---|---|
| `'single'` | Everything except `'` itself | Nothing — no `$`, no backslash, no glob |
| `"double"` | Splitting, globbing, most metacharacters | `$var`, `$(cmd)`, `$((...))`, `` `...` ``, `\` before `$ ` ` " \` |
| `\x` | One character | Nothing |
| `$'ansi'` | As single quotes | Backslash escapes: `\n`, `\t`, `\x41`, `\u00e9` |

Rules that follow from the table:

- Single quotes are for literal text: regexes, JSON fragments, SQL, awk programs.
- Double quotes are the default for variables. `"$var"` is correct unless you have a specific
  reason to split.
- Inside double quotes, `\` is only special before `$`, `` ` ``, `"`, `\` and newline. So
  `"\d+"` is a literal backslash-d, while `"$var\n"` keeps the backslash-n.
- `$'...'` is the portable-in-bash way to write a tab or newline:
  `IFS=$'\n\t'`.

`echo` is not a reliable way to print arbitrary text — it interprets `-n` and, in some shells,
backslash escapes. Use `printf '%s\n' "$var"` when the content is untrusted or contains
backslashes.

## "$@" versus "$*" and the argument list

These two look interchangeable and are not:

```bash
set -- "a b" c
printf '[%s]\n' "$@"     # [a b] then [c]   -> one word per argument
printf '[%s]\n' "$*"     # [a b c]          -> one word, joined by first IFS char
```

`"$@"` is the only correct way to forward arguments: it preserves the original boundaries.
Unquoted `$@` splits each argument again. `"$*"` is only right when you deliberately want a single
joined string, for example in a log line.

The same logic applies to `for` loops. `for f in $(ls)` is wrong twice over — it parses `ls`
output, and it splits filenames on whitespace. Use `for f in *.txt` (globbing) or
`find ... -print0 | while IFS= read -r -d '' f`.

## When globbing is the enemy

A pattern that matches nothing stays literal in bash (unless `nullglob` is set), which is a
common source of "file not found: *.log" errors:

```bash
shopt -s nullglob
for f in ./*.log; do
  [[ -e $f ]] || continue   # belt and braces if nullglob is unavailable
  ...
done
```

Also note that `-` and `--`: a filename beginning with `-` is read as an option. Use `--` to end
option parsing (`rm -- "$f"`) and prefix globs with `./` when passing them to commands that could
mistake them for flags.

## Common mistakes

- Unquoted `$var` in `[ ]`, `rm`, `cp` and `for` — splitting and globbing both apply.
- Using `'...'` around a variable and expecting expansion.
- `echo "$x" | read y` — the pipe puts `read` in a subshell, so `y` is lost.
- Assuming `#!/bin/sh` means bash; then using `[[` or arrays and breaking on Alpine.
- Writing `if [ $x = y ]` with an empty `x`, which becomes `[ = y ]` and errors. Quote it:
  `[ "$x" = y ]`.
- Forgetting that `cd` inside `$(...)` or a pipeline does not affect the parent shell.

## Production notes

- Run `shellcheck` on every script. It catches unquoted expansions, `local x=$(cmd)`, useless
  `cat`, and most of the traps in this module — it is the single highest-value habit here.
- Set `IFS=$'\n\t'` near the top of bash scripts so accidental splitting ignores spaces. It is a
  safety net, not a licence to stop quoting.
- Prefer `printf` over `echo` for anything that might contain `-` or backslashes.
- Keep scripts ASCII, use `LC_ALL=C` for parsing command output, and never parse `ls`.
