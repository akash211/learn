# Functions, Sourcing and Scope

Functions are the only structure bash gives you, and they come with a scoping model that is not
what most people expect: `local` is dynamic, not lexical. That single fact explains the majority of
"why is my variable empty" bugs in larger scripts.

## Defining and calling

```bash
log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2
}

log "starting"          # no parentheses at the call site
```

Both `name() { ... }` and `function name { ... }` work; the first form is POSIX and preferred.
`name () ( ... )` defines a function whose body is a subshell — occasionally useful for isolation,
usually a surprise.

A function's return value is its **exit status**, not data:

```bash
is_root() { [[ $EUID -eq 0 ]]; }

if is_root; then ...; fi
value=$(compute_something)      # command substitution captures stdout, not status
```

`return N` sets the status (0–255); `return` with no argument returns the status of the last
command. `return` outside a function is an error. To hand back more than a status, print to stdout
and capture, or assign to a global — there is no other channel.

Never use `exit` inside a function you expect to call from a sourced file: it exits the caller's
shell. `return 1` and let the caller decide.

## local and dynamic scope

```bash
greet() {
  local name="inside"
  echo "$name"
}
name="outside"
greet            # inside
echo "$name"     # outside
```

`local` creates a variable in the function's *call frame*. But bash looks up variables dynamically:
a function sees variables from its caller's frame, and a callee can even see a `local` declared by
its caller.

```bash
inner() { echo "inner sees: $x"; }
outer() { local x=secret; inner; }
outer            # inner sees: secret
```

This is dynamic scoping, and it means you cannot reason about a function in isolation — you must
know its callers. Defensive habit: `local` every variable you introduce, including loop counters
and temporaries, and never rely on a caller's local being visible.

Two related facts:

- `local x=$(cmd)` masks the failure — the status is `local`'s, which is 0. Declare first:
  `local x; x=$(cmd) || return 1`.
- `local -r`, `local -i`, `local -a`, `local -A` and `local -n` (nameref) work, but `local` itself
  is not POSIX — `dash` has no `local` in the standard, though most implementations support it.

To modify a caller's variable deliberately, use a nameref (bash 4.3+):

```bash
fill() { local -n ref=$1; ref=(a b c); }
fill myarray
```

Namerefs are how you write "out-parameter" functions without subshells or global soup. Guard
against a name collision with the caller's own local of the same name — this is a known sharp edge.

## `$@`, `$*` and argument passing inside functions

Functions receive their own positional parameters; `"$@"` inside the function refers to the
function's arguments, not the script's.

```bash
retry() {
  local tries=$1 delay=$2; shift 2
  local i
  for ((i = 1; i <= tries; i++)); do
    "$@" && return 0
    sleep "$delay"
  done
  return 1
}

retry 3 2 curl -fsS https://example.com/health
```

`shift 2` then `"$@"` is the idiom for "options first, command after". It preserves quoting
through every layer, which `$*` would destroy.

## Sourcing

```bash
source ./lib/common.sh      # or: . ./lib/common.sh
```

`source` executes the file in the current shell: functions and variables persist. That makes it the
mechanism for shared libraries and config files — and the mechanism by which a stray `set -e`,
`IFS=` or `cd` in a library changes the caller.

Rules for sourceable libraries:

- Define functions and constants only. No top-level side effects, no `exit`.
- Guard the executable part so the file works both ways:

```bash
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
```

`${BASH_SOURCE[0]}` is the file being read (works when sourced); `$0` is the invoked script. That
guard is the bash analogue of `if __name__ == "__main__"`.

- Resolve your own directory so relative includes work regardless of the caller's cwd:

```bash
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$here/lib/common.sh"
```

Without that, `source lib/common.sh` works only when the caller happens to be in the right
directory — a favourite cause of "works in my shell, fails in cron".

## `set -e` and functions: the conditional exemption

If a function is called as part of a condition — `if f; then`, `f || die`, `f && next` — then
`set -e` is disabled for the **entire body** of that function, not just the test. A failing command
inside it will not abort; execution continues to the next line.

The consequence: a function that is sometimes used as a condition and sometimes not has
inconsistent error behaviour. Two ways out:

1. Make every step explicit: `cmd || return 1` inside the function.
2. Never use `-e` as the only protection in library functions — check the commands that matter.

## Argument parsing with getopts

```bash
usage() { echo "usage: $0 [-n name] [-d] target" >&2; exit 2; }

name=""; debug=0
while getopts ":n:dh" opt; do
  case $opt in
    n) name=$OPTARG ;;
    d) debug=1 ;;
    h) usage ;;
    :) echo "option -$OPTARG needs an argument" >&2; usage ;;
    \?) echo "unknown option -$OPTARG" >&2; usage ;;
  esac
done
shift $((OPTIND - 1))
```

`getopts` handles POSIX short options (`-n value`, `-nvalue`, combined flags) and sets `OPTIND`,
which you must shift away before reading positionals. It does **not** handle long options
(`--name=x`); for those either hand-roll a `while [[ $# -gt 0 ]]` loop with `case`, or accept that
you are writing an application and move to Python or Go.

The leading `:` in `":n:dh"` enables silent mode so you can produce your own error messages; `:`
after a letter means it takes an argument.

## Common mistakes

- Using `local` for a variable you meant the caller to see, then wondering why it is empty.
- Shadowing a global with `local` and expecting the global to change.
- `exit` inside a sourced library — kills the user's shell or the whole CI step.
- Relative `source` paths that break under cron, systemd or `sudo` (different cwd).
- Relying on function output plus status: `out=$(f)` discards the status only if you do not check
  it immediately — `f` failing is not propagated by the assignment.
- Recursion in bash: it works, there is no stack limit beyond memory, but a recursive shell
  function is almost always a design error.

## Production notes

- One file per concern under `lib/`, each sourcing nothing but its own dependencies, each safe to
  source twice (idempotent definitions).
- Prefix user-facing globals (`APP_`, `CFG_`) so `local` mistakes are visible in review.
- Keep functions under ~40 lines and give each a single exit path where possible; `return`
  discipline is what makes shell readable at 300 lines.
- Write `main "$@"` as the last line and keep it three lines long: parse, validate, call.
- Test sourced functions with `bats` or a small shim that sources the library and asserts on
  output; functions are the only part of a shell script that is unit-testable.
