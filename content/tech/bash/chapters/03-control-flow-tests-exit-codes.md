# Control Flow, Tests and Exit Codes

Shell branching looks like other languages and is not. `if` tests the *exit status* of a command;
`[` is a command; `0` means success. Getting those three facts straight fixes most conditional
bugs before they are written.

## Exit status is the boolean

Every command returns an integer 0–255. `0` is success; anything else is failure. `if`, `while`,
`until`, `&&` and `||` all branch on that status, not on any value the command prints.

```bash
if grep -q '^root:' /etc/passwd; then
  echo "root exists"
fi
```

Nothing is being compared here — `grep`'s status is the condition. This is why the `[` and `[[`
builtins exist: they are commands whose whole job is to compute a status from a comparison.

Common statuses worth memorising:

| Status | Meaning |
|---|---|
| 0 | success |
| 1 | general failure (also "no match" for `grep`, `cmp`, `diff`) |
| 2 | misuse of a builtin or shell syntax error |
| 126 | found but not executable |
| 127 | command not found |
| 128+N | killed by signal N (130 = SIGINT, 143 = SIGTERM) |
| 141 | SIGPIPE — writer died because the reader closed early |

A script's exit status is the status of its last command. That is why `main "$@"` at the end of a
script matters, and why a trailing `echo done` can turn a failed script green.

## `[` versus `[[`

`[` is a POSIX command (`test`), so its arguments go through the normal expansion pipeline and
word splitting applies. `[[` is a bash keyword: it suppresses splitting and globbing on its
operands and has its own grammar.

```bash
# POSIX — quote everything
if [ -f "$file" ] && [ "$mode" = "fast" ]; then ...; fi

# bash — no quoting needed on the left of =~ or inside [[ ]]
if [[ -f $file && $mode == fast ]]; then ...; fi
if [[ $name == *.tar.gz ]]; then ...; fi          # glob match, not regex
if [[ $line =~ ^([0-9]{4})-([0-9]{2}) ]]; then    # ERE; capture in BASH_REMATCH
  year=${BASH_REMATCH[1]}
fi
```

Rules that follow:

- Inside `[[ ]]`, `==` and `!=` are pattern matches, and the right side must be unquoted for the
  pattern to work (`[[ $f == "*.log" ]]` compares literally — often the bug).
- `=~` takes an ERE, not a glob; quote the variable, not the regex. In bash 3.2, quoting the regex
  makes it literal.
- `[` needs `]` as its last argument and spaces around every operator. `[ -f"$f" ]` is a syntax
  error.
- `-a` and `-o` inside `[` are deprecated and ambiguous; use `&&` and `||` between separate `[ ]`
  commands.

## The test operators that matter

| Test | True when |
|---|---|
| `-e p` | path exists (any type) |
| `-f p` / `-d p` | regular file / directory |
| `-r p` / `-w p` / `-x p` | readable / writable / executable by you |
| `-s p` | exists and is non-empty |
| `-L p` | symbolic link |
| `-z s` / `-n s` | string is empty / non-empty |
| `s1 = s2` / `s1 != s2` | string equality / inequality |
| `n1 -eq n2` (`-ne -lt -le -gt -ge`) | integer comparison |
| `f1 -nt f2` / `-ot` | newer / older than (mtime) |

The classic mistake is using `-eq` on strings: `[ "$a" -eq "$b" ]` with `a=abc` prints
`integer expression expected` and returns 2, which an `if` reads as false — silently. Use `=` for
strings, `-eq` for integers, and `(( ))` when you actually want arithmetic:

```bash
if (( count > 10 )); then ...; fi       # arithmetic context, no $ needed
(( total += n ))                         # returns 1 (false) if the result is 0
```

That last line is a genuine trap: `(( x++ ))` returns false when `x` was 0, so under `set -e` it
aborts the script. Use `x=$((x+1))` or `(( ++x ))` instead.

## Loops

```bash
for host in "${hosts[@]}"; do ...; done
for i in {1..10}; do ...; done            # brace expansion, no seq needed
for ((i = 0; i < n; i++)); do ...; done   # C-style
while IFS= read -r line; do ...; done < file
while IFS= read -r -d '' f; do ...; done < <(find . -type f -print0)
until ping -c1 -W1 host >/dev/null; do sleep 1; done
```

`read -r` prevents backslash mangling; `IFS=` stops leading whitespace being trimmed; `-d ''`
reads NUL-delimited records. Those three flags together are the only correct way to loop over
filenames or arbitrary lines.

Two scoping facts bite here. `cmd | while read ...` runs the loop in a subshell, so variables set
inside it vanish — use process substitution (`done < <(cmd)`) or `shopt -s lastpipe` (bash 4.2+,
non-interactive only). And `break` inside a loop inside a subshell does not break the outer loop.

## case

`case` is pattern matching, not string equality, and it is the cleanest way to parse subcommands:

```bash
case $1 in
  start|up)      do_start ;;
  stop|down)     do_stop ;;
  --help|-h)     usage; exit 0 ;;
  ""|*)          usage >&2; exit 2 ;;
esac
```

Patterns support globs (`*.log`), alternation with `|`, and `;;` terminates a branch. `;&` falls
through to the next branch (bash 4) and `;;&` continues testing later patterns — both are bash
extensions, and `;&` is rarely what you want.

## Functions, blocks and `&&`/`||`

`&&` and `||` are short-circuit lists, not boolean operators returning values:

```bash
mkdir -p /var/tmp/app && cd /var/tmp/app || { echo "cannot enter dir" >&2; exit 1; }
```

The braces need spaces and a trailing semicolon because `{ ...; }` is a compound command. `(...)`
would run it in a subshell, so `exit` would not leave the script.

A word of warning on `a && b || c`: if `b` fails, `c` runs — the construct means "b failed", not
"a failed". Use a real `if` when the distinction matters.

## Common mistakes

- `if [ $var = "x" ]` with `var` unset — expands to `[ = x ]` and errors. Quote it.
- `[ $? -eq 0 ]` after an `echo` instead of immediately after the command whose status mattered.
- Using `-eq` for strings, or `=` for numbers.
- `grep pattern file` in an `if` without `-q`, flooding logs with matches.
- Relying on `while read` in a pipeline to set variables.
- `(( x++ ))` under `set -e`.
- `case` patterns quoted, which turns them into literal strings.

## Production notes

- Use `[[ ]]` in bash scripts and `[ ]` only where POSIX portability is required; mixing them in
  one file is worse than either.
- Always give usage errors exit status 2 and operational failures something else (1, 3, 4…), so
  callers and alerting can distinguish "you called it wrong" from "it broke".
- Validate with `command -v jq >/dev/null || { echo "jq required" >&2; exit 127; }` at startup
  rather than discovering a missing dependency halfway through.
- Prefer `case` over nested `if` for three or more string alternatives; it reads like a table and
  cannot suffer from quoting bugs.
