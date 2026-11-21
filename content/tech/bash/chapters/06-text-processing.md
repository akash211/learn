# Text Processing with grep, sed and awk

The shell's text toolkit is old, fast and everywhere. The interview question is rarely "what does
`-v` do" — it is "here is a log, give me the top five error codes by count", and the answer is
judged on whether the pipeline is correct on real data (empty fields, quoted values, CRLF, UTF-8).

## grep: select lines

```bash
grep -F 'connection refused' app.log       # fixed string, no regex parsing — fastest
grep -E 'ERROR|FATAL' app.log              # extended regex
grep -v '^#' config.ini                    # invert
grep -c 'timeout' app.log                  # count of matching lines
grep -n 'panic' app.log                    # line numbers
grep -o -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' access.log | sort -u   # print only matches
grep -rIl 'TODO' src/                      # recursive, skip binaries, list files only
grep -A3 -B1 'Traceback' app.log           # context after/before
grep -q 'ready' health.txt                 # quiet: status only, for if
```

Details that matter: `-q` exits at the first match, so it is the right form in conditionals — and
the reason `cmd | grep -q pat` can trigger SIGPIPE in `cmd`. `-F` avoids regex interpretation
entirely; a search for `1.2.3` without it matches `1x2y3`. `-c` counts *lines*, not matches; use
`grep -o ... | wc -l` for occurrences. `grep -l` vs `-L` is "files with" vs "files without".

GNU grep with `-P` gives PCRE (lookarounds, `\d`), but `-P` is not portable to macOS or busybox;
`-E` plus `-o` covers almost everything.

`rg` (ripgrep) is faster and respects `.gitignore`, but it is not installed on minimal images —
know both, and do not put `rg` in a Docker entrypoint.

## sed: edit the stream

```bash
sed -n '10,20p' file                 # print a range; -n suppresses default output
sed -n '/BEGIN/,/END/p' file         # from BEGIN to END
sed 's/foo/bar/' file                # first occurrence per line
sed 's/foo/bar/g' file               # all occurrences
sed -E 's/^([0-9]{4})-([0-9]{2})-([0-9]{2})/\3\/\2\/\1/' file    # ERE with groups
sed '/^$/d' file                     # delete blank lines
sed -e 's/a/b/' -e 's/c/d/' file     # multiple expressions
sed -i.bak 's/old/new/g' file        # in-place, keeping a backup
```

The portability trap: `sed -i` is GNU syntax. On macOS/BSD it requires an argument —
`sed -i '' 's/a/b/' file`. Portable scripts either detect the platform or write to a temp file and
`mv` it, which is also the atomic-write pattern.

`s///` replaces the first match per line unless `g` is given; anchoring with `^`/`$` and using
`[[:space:]]` instead of `\s` (POSIX classes are portable, `\s` is GNU) is how sed scripts survive
contact with busybox. `&` in the replacement means the whole match, and `\1`…`\9` are capture
groups. A delimiter other than `/` is legal and helps with paths: `s|/usr/local|/opt|g`.

## awk: select fields and aggregate

`awk` is a programming language whose implicit loop is "for each line": patterns select records,
actions process them, and fields split on `FS`.

```bash
awk '{print $1, $7}' access.log                  # fields, OFS-separated
awk -F: '$3 >= 1000 {print $1}' /etc/passwd      # -F sets FS; condition before action
awk 'NR==1 || /ERROR/' app.log                   # header plus matches
awk -F, 'NR>1 {sum += $3} END {printf "%.2f\n", sum}' sales.csv
awk '{count[$4]++} END {for (k in count) print count[k], k}' access.log | sort -rn | head -5
awk 'length($0) > 200 {print FNR": "substr($0,1,60)}' big.log
```

Built-ins worth knowing: `NR` (record number overall), `FNR` (per file), `NF` (field count),
`$NF` (last field), `FS`/`OFS` (input/output separator), `substr`, `index`, `split`, `gsub`, and
the `BEGIN`/`END` blocks. `$NF` is the portable way to get the last field when the count varies —
`awk '{print $NF}'` for "the last column of ps output" style problems.

Two habits that avoid most awk bugs:

- Set `FS` explicitly (`-F'\t'`), and remember that `FS=" "` is special — it also treats runs of
  whitespace as one separator, unlike a single tab.
- Numeric comparison is automatic for fields that look numeric, but a field with a trailing `\r`
  (CRLF input) is a *string*, so `$3 > 100` becomes a string comparison. `sub(/\r$/,"")` or
  `-v RS='\r?\n'` (gawk only) fixes it.

`awk` handles multi-GB files line by line with tiny memory; that is its real advantage over
`python -c`. Once you need JSON, nested structure or real error handling, switch tools.

## cut, paste, tr, sort, uniq, join, comm

```bash
cut -d: -f1,7 /etc/passwd          # -d delimiter, -f fields (1-based, comma list, ranges)
cut -c1-20 file                    # character positions
paste -d, a.txt b.txt              # side by side
tr -d '\r' < dos.txt > unix.txt    # delete CR
tr -s ' ' < file                   # squeeze repeated spaces
tr '[:lower:]' '[:upper:]' < f     # translate
sort -t, -k3,3n data.csv           # field 3, numeric
sort -u file                       # unique (sort + dedupe, stable on GNU)
sort -h sizes.txt                  # human sizes: 1K < 2M
sort -r -k2,2 -k1,1 file           # reverse on field 2, then field 1
uniq -c | sort -rn                 # count occurrences, biggest first
uniq -d                            # only duplicated lines (input must be sorted)
join -t, -1 1 -2 2 a.csv b.csv     # relational join on sorted keys
comm -23 <(sort a) <(sort b)       # lines only in a
```

`cut` cannot handle multi-character delimiters or reordered fields — use `awk -F` or
`awk '{print $3, $1}'`. `uniq` only collapses *adjacent* duplicates; forgetting `sort` first is the
single most common pipeline bug in this area.

## Choosing the tool

| Task | Tool | Why |
|---|---|---|
| Filter lines by pattern | `grep` | Fastest, `-q` for conditionals |
| Substitution in a stream | `sed` | Terse; use `-E` and POSIX classes |
| Field extraction, aggregation | `awk` | One pass, no pipeline of five commands |
| Fixed-column extraction | `cut -c` | Simpler than awk for byte ranges |
| Sorting and dedupe | `sort` + `uniq` | Handles keys, numeric, human sizes |
| Character translation | `tr` | Byte-for-byte, no regex |
| JSON, CSV with quotes, nested data | `jq`, `python` | awk cannot parse quoting correctly |

The last row is the one candidates get wrong. `awk -F,` on a CSV with quoted commas produces
subtly wrong output that survives every test until finance notices. If the data has quoting, use a
real CSV parser.

## Common mistakes

- `grep` without `-F` on strings containing `.` or `*`.
- `sed 's/x/y/'` expecting all occurrences.
- `sed -i` in a script meant to run on macOS.
- `uniq` without `sort`.
- `awk -F,` on quoted CSV.
- Using `grep -c` to count matches rather than matching lines.
- Parsing `ls -l` output — column layout is not a contract and breaks on wide dates or spaces in
  names.
- Forgetting `LC_ALL=C` when output format must be deterministic across hosts.

## Production notes

- `LC_ALL=C` makes `sort`, `grep` and `awk` faster and byte-deterministic; set it for parsing, not
  for anything user-facing.
- Never edit a config in place without a backup; `sed -i.bak` plus a diff check is the minimum.
- Keep one transformation per pipeline stage so a failure is attributable, and log each stage's
  `PIPESTATUS` when the pipeline writes something you depend on.
- Remember `grep`/`sed`/`awk` differ between GNU, BSD and busybox: `\s`, `\+` in BRE, `-P`, `-r`
  vs `-R`, and `sort -h` availability are the usual offenders. Test in the target image, which is
  often Alpine.
