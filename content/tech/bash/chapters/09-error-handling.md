# Error Handling: set -euo pipefail, Traps and Logging

Shell's default is to continue after failure, print nothing useful, and exit 0. Every mature
script fights that default with three tools: strict mode, an `ERR` trap that says where it broke,
and an `EXIT` trap that cleans up. The senior-level part is knowing exactly where strict mode stops
working.

## The header

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true
IFS=$'\n\t'
```

| Flag | Effect |
|---|---|
| `-e` (errexit) | Exit when an untested command returns non-zero |
| `-u` (nounset) | Error on an unset variable instead of expanding to empty |
| `-o pipefail` | A pipeline fails if *any* stage fails, not just the last |
| `-E` (errtrace) | The `ERR` trap is inherited by functions, subshells and command substitutions |
| `inherit_errexit` | `set -e` applies inside `$(...)` (bash 4.4+) |

`-u` is what turns `${1}` into a fast, loud failure instead of a script that silently operates on
an empty string — the most dangerous class of shell bug, because `rm -rf "$BASE"/` with an empty
`BASE` is a catastrophe while `rm -rf "$BASE"` is merely wrong.

`IFS=$'\n\t'` removes space from the split set, so an unquoted expansion splits on lines rather
than words. It is a safety net, not a substitute for quoting — and it changes `read` behaviour, so
use `IFS=` explicitly in `read` loops.

## Where set -e does not stop the script

This list is the actual interview answer, and it is long:

```bash
# 1. Commands used as conditions are exempt
if failing_cmd; then ...; fi
while failing_cmd; do ...; done
failing_cmd || echo "handled"
! failing_cmd
failing_cmd && echo ok        # the left side is tested, not fatal

# 2. A function called as a condition disables -e for its WHOLE body
check() { false; echo "still here"; }
if check; then :; fi          # prints "still here"

# 3. local/declare/export/readonly mask the status
local x=$(false)              # status is local's: 0
declare -r y=$(false)         # same

# 4. Background jobs are never checked
failing_cmd &                 # script continues, status lost unless you wait

# 5. Left side of a pipe without pipefail
failing_cmd | cat             # status is cat's

# 6. Command substitution used in an assignment
out=$(failing_cmd)            # assignment's status IS the substitution's
                              # ...so this one *is* caught, but `local out=$(...)` is not

# 7. Arithmetic that evaluates to zero
(( count++ ))                 # returns 1 when the old value was 0 -> exits
```

Point 6 surprises people in both directions:
`out=$(false)` under `set -e` **does** exit, while `local out=$(false)` does not. Declare first,
assign on the next line, always.

Also note that `set -e` is disabled while the shell is in a `trap` handler unless you re-enable it,
and that `-e` behaviour differs between bash versions and POSIX mode. Treat it as a seat belt:
keep it, and still check the commands whose failure you care about.

## Explicit checks and a die helper

```bash
die() { local rc=$1; shift; printf 'ERROR: %s\n' "$*" >&2; exit "$rc"; }

cp -- "$src" "$dst"      || die 3 "cannot copy $src -> $dst"
curl -fsS "$url" -o "$tmp" || die 4 "download failed: $url"
command -v jq >/dev/null || die 127 "jq is required"
```

`|| die` is the pattern to reach for whenever a step matters more than the general net. It gives a
precise message and a chosen exit status, and it works in `if`-tested functions where `-e` does
not. `curl -f` is part of the same idea: without `-f`, curl returns 0 on HTTP 404 and writes the
error page to your output file.

## Traps

```bash
tmp=$(mktemp -d)
cleanup() {
  local rc=$?
  rm -rf -- "$tmp"
  return "$rc"          # or exit "$rc" — see below
}
trap cleanup EXIT
trap 'echo "error: line $LINENO: $BASH_COMMAND (status $?)" >&2' ERR
```

Facts that decide whether this works:

- `EXIT` runs on normal exit, `exit N`, `set -e` aborts **and** on a trapped signal that exits. It
  is the only correct place for cleanup.
- Inside an `EXIT` trap, `$?` is the status the script was about to exit with. Save it first if you
  run any command, because `$?` is overwritten.
- An `ERR` trap needs `-E` to fire inside functions and subshells. `$LINENO` and `$BASH_COMMAND`
  inside it are what make the message useful; `$BASH_COMMAND` can contain secrets, so log it to
  stderr, not to a shared file.
- `trap - EXIT` removes a trap (useful when a temp file should be kept on success).
- Traps are reset in subshells and in `bash -c` children.
- A trap for INT/TERM should end in `exit 130`/`exit 143`; returning lets the script continue
  after a signal it was meant to die from.
- New traps replace old ones for the same signal; append with
  `trap "$(trap -p ERR | cut -d"'\" -f2)" ...` only if you really need composition (you rarely do).

- `trap -p` lists installed handlers; check it when a trap seems not to run.

## Logging

```bash
log() {
  local level=$1; shift
  printf '%s %-5s [%s] %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "${BASH_SOURCE[0]##*/}:$LINENO" "$*" >&2
}
log INFO "starting sync for $# targets"
```

Rules that make logs usable:

- Timestamps in UTC, RFC 3339 — sortable and unambiguous across timezones.
- Everything to stderr. stdout is the script's data channel; mixing the two is what breaks
  `results=$(./script.sh)` in a caller.
- One line per event, no embedded newlines: `tr '\n' ' '` any external output before logging it,
  or multi-line stack traces become unparseable.
- Never log secrets. Do not `set -x` around a command whose arguments contain a token; bash 4.1+
  has `BASH_XTRACEFD` to send the trace elsewhere, and `PS4` can include `$LINENO`.
- Give the reader the failing command, the exit status and the input — "upload failed (rc=22) for
  s3://bucket/key" beats "something went wrong".

## Exit codes as an API

| Code | Convention |
|---|---|
| 0 | success |
| 1 | generic failure |
| 2 | usage / bad arguments |
| 3–125 | script-specific failures (documented in `usage`) |
| 126 | not executable |
| 127 | command not found |
| 130 / 143 | interrupted / terminated |

Callers, CI steps and alerting all branch on these. A script that returns 1 for everything forces
the operator to read the logs; one that separates "config invalid" (2) from "upstream unavailable"
(4) can be retried automatically.

## Retries, carefully

```bash
retry() {
  local tries=$1 delay=$2; shift 2
  local i rc
  for ((i = 1; i <= tries; i++)); do
    "$@" && return 0
    rc=$?
    (( i < tries )) && sleep "$((delay * i))"
  done
  return "$rc"
}
```

Retry only idempotent operations, bound the attempts, add backoff, and do not retry 4xx responses
or validation failures — that turns a deterministic bug into a slow one. Under `set -e`, remember
that `"$@" && return 0` inside the loop is fine but a bare failing command would exit the script;
the `if`-style `||` form keeps control.

## Common mistakes

- Copying the header without `-E`, then wondering why the `ERR` trap never fires in functions.
- `local x=$(cmd)` under `set -e` and believing the failure is caught.
- Trapping EXIT and using `$?` after another command in the handler.
- `set -e` plus a function called in `if`, where half the body silently continues.
- Adding `|| true` to silence a check that was actually reporting a real failure.
- Logging to stdout in a script whose stdout is consumed as data.
- `exit 1` in a sourced library.

## Production notes

- Keep the header, `die`, `log` and `retry` in one `lib/common.sh` and source it everywhere; five
  variants of `die` across a repo is how exit-code conventions die.
- In CI, `set -o pipefail` belongs in the job's shell definition too — a runner default of
  `bash -e` still hides failures on the left of pipes.
- Alert on exit status and duration, not on log text. Text changes; 124 (timeout) does not.
- Test the failure paths: run the script with a missing argument, a read-only directory and a
  bogus host, and confirm the message and status. Untested error paths are the ones that fail in
  production.
