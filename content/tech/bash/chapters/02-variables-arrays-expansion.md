# Variables, Arrays and Parameter Expansion

Shell variables are strings with extra powers. Bash adds arrays, associative arrays, integer
attributes and a parameter-expansion syntax rich enough to replace most `cut`, `sed` and `basename`
calls. Used well, it keeps scripts short and dependency-free; used carelessly, it produces strings
that silently collapse to empty.

## Assignment is not splitting

The right-hand side of an assignment is exempt from word splitting and globbing:

```bash
msg="hello   world"      # one space run preserved
files=*.txt              # literal *.txt unless the assignment is an array
arr=(*.txt)              # array assignment DOES glob — one element per match
total=$(( 3 + 4 ))       # arithmetic context
```

There must be no spaces around `=`. `x = 1` runs a command called `x` with arguments `=` and `1`.

Variables are untyped strings, but a variable can be *declared* with attributes:

```bash
declare -i n=0        # integer: n=1+1 stores 2, and n="abc" becomes 0
declare -r CONFIG=/etc/app.conf   # readonly
declare -l lower       # value lowercased on every assignment
declare -u upper
export PATH="/opt/bin:$PATH"      # visible to child processes
readonly VERSION="1.4.0"
```

`export` marks a variable for inheritance by child processes. A plain `VAR=x` is *not* exported —
the distinction between shell variables and environment variables is a classic interview question.
`export VAR` promotes an existing shell variable without changing its value.

## Parameter expansion: defaults and required values

This table is the workhorse of defensive scripting. All of it is POSIX except the ones marked.

| Form | Meaning |
|---|---|
| `${v:-default}` | Use `default` if `v` is unset **or** empty |
| `${v-default}` | Use `default` only if `v` is unset |
| `${v:=default}` | Assign `default` to `v` if unset/empty (POSIX, but avoid in scripts) |
| `${v:?message}` | Error and exit if `v` is unset/empty; prints `message` |
| `${v:+alt}` | Use `alt` only if `v` is set and non-empty |
| `${#v}` | Length in characters (bytes under `LC_ALL=C`) |
| `${v:offset:len}` | Substring, 0-based; negative offsets need a space: `${v: -3}` |
| `${v#pat}` | Strip shortest matching prefix |
| `${v##pat}` | Strip longest matching prefix |
| `${v%pat}` | Strip shortest matching suffix |
| `${v%%pat}` | Strip longest matching suffix |
| `${v/pat/repl}` | Replace first match (bash) |
| `${v//pat/repl}` | Replace all matches (bash) |
| `${v^^}` / `${v,,}` | Upper/lower case, all chars (bash 4+) |
| `${!name}` | Indirect expansion — value of the variable named by `$name` (bash) |

The quoting inside the braces matters: `${v:-"a b"}` keeps the space, `${v:-$other}` re-splits if
the whole expansion is unquoted.

Every required-argument check in a good script looks like this:

```bash
: "${SRC:?usage: sync.sh SRC DST}"
: "${DST:?usage: sync.sh SRC DST}"
```

The `:` builtin is a no-op that gives the expansion somewhere to live. If `SRC` is empty the shell
prints `sync.sh: line 3: SRC: usage: sync.sh SRC DST` and exits with status 1 — no `if` needed,
and it works under `set -u`.

`${v:?}` with `set -u` is the only form that is safe in every shell; note that without `-u` a bare
`$v` silently becomes empty, which is why `-u` is in the standard header.

## Pattern stripping is `basename` and `dirname`

```bash
path=/var/log/app/2024-06-01.log
file=${path##*/}          # 2024-06-01.log      (longest prefix ending in /)
dir=${path%/*}            # /var/log/app
stem=${file%.log}         # 2024-06-01
ext=${file##*.}           # log
```

`##*/` and `%/*` are faster than spawning `basename` and work on strings that are not paths at
all. If you need a real path with symlinks resolved, use `realpath` or `readlink -f` instead —
pattern stripping knows nothing about the filesystem.

## Indexed arrays

```bash
servers=(web1 web2 web3)
servers+=(web4)                 # append
echo "${#servers[@]}"           # 4        — element count
echo "${servers[0]}" "${servers[-1]}"   # web1 web4 (negative index: bash 4.3+)
echo "${servers[@]:1:2}"        # web2 web3 — slice
printf '%s\n' "${servers[@]}"   # one per line, boundaries preserved
echo "${!servers[@]}"           # 0 1 2 3  — the indices
for s in "${servers[@]}"; do ...; done
```

Arrays are sparse: `a[5]=x` on an empty array gives `${#a[@]}` of 1, not 6, and `${!a[@]}` tells
you which indices exist. Iterating `for i in $(seq 0 $((${#a[@]}-1)))` is therefore wrong; iterate
the values or the indices from `${!a[@]}`.

`"${arr[@]}"` is to arrays what `"$@"` is to positional parameters: it expands to one word per
element. `${arr[*]}` joins with the first character of `IFS`.

## Associative arrays

Bash 4 added string-keyed maps. They must be declared, and they cannot be exported or nested:

```bash
declare -A colour=([apple]=red [lime]=green)
colour[sky]=blue
echo "${colour[apple]}"
for k in "${!colour[@]}"; do printf '%s=%s\n' "$k" "${colour[$k]}"; done
[[ -v colour[sky] ]] && echo present      # bash 4.2+
unset 'colour[sky]'
```

Order is unspecified — never rely on it. macOS ships bash 3.2, so a script using `declare -A`
fails there; portability in this area is a real constraint, not a theoretical one.

## Positional parameters and shift

```bash
$0    # script name as invoked
$1..$9, ${10}   # arguments — braces required above 9
$#    # argument count
"$@"  # all arguments, boundaries preserved
shift 2   # drop the first two, renumber the rest
```

`shift` fails (non-zero) when the count is exhausted, which makes `while [[ $# -gt 0 ]]` loops
terminate cleanly. `${10}` needs braces because `$10` means `$1` followed by `0`.

## Common mistakes

- `local x=$(false)` — the status is `local`'s (0), so `set -e` never sees the failure. Declare,
  then assign.
- Using `${#v}` expecting bytes on UTF-8 data; it counts characters unless `LC_ALL=C`.
- `${v:-default}` to test "is set at all" — it also fires on empty. Use `${v-default}`.
- Forgetting braces: `$file.txt` is `$file` followed by `.txt`… unless `file` is a name like
  `$12`, where it becomes `${1}2`. Always brace when concatenating.
- Mutating `IFS` globally to split a string instead of using `read -r -a`.
- `arr=($string)` to split input — it globs and splits on every space. Prefer
  `read -r -a arr <<< "$string"`.

## Production notes

- Use `declare -r` for constants and `readonly` for values that must not be reassigned after
  config load; a typo that overwrites `DB_HOST` is an outage.
- Prefer `[[ -v var ]]` (bash 4.2+) over `${var+x}` when the intent is "was it set".
- Keep configuration in the environment, defaults in the script, and validation at the top:
  `${PORT:-8080}` plus a range check. Do not scatter fallbacks through the code.
- Never store secrets in variables you then `export` to a child you do not control, and remember
  that environment variables are readable from `/proc/<pid>/environ` by the same user.
