# The apply Family and purrr

R's iteration story is confusing because it has three overlapping generations of tools: the
`apply` family from S, `purrr` from the tidyverse, and plain `for` loops that were slow in 2005
and are fine now. Knowing which to reach for — and why `sapply` is a trap — is a standard
interview topic and a real source of production bugs.

## Why not just write a loop?

You can, and often should. Since R 3.4 the interpreter byte-compiles loops in packages and
top-level scripts, so a `for` loop that does real work per iteration is not the bottleneck.
What is slow in a loop is *growing an object*:

```r
out <- numeric(0)
for (i in seq_len(n)) out <- c(out, f(i))   # copies the whole vector every iteration

out <- numeric(n)
for (i in seq_len(n)) out[[i]] <- f(i)      # preallocated: linear
```

The idiom "vectorise instead of looping" is really "move the loop into C". Functions like
`sum()`, `paste0()`, `ifelse()` and the whole of `dplyr` are vectorised because their loop is
compiled. When there is no vectorised primitive — fitting 200 models, reading 400 files, calling
an API — a loop or a `map` is the right tool, and the choice between them is about readability and
error handling, not speed.

## apply: matrix-oriented, and older than it looks

`apply(X, MARGIN, FUN)` runs a function over rows (`MARGIN = 1`) or columns (`MARGIN = 2`) of a
matrix.

```r
m <- matrix(1:6, nrow = 2)
apply(m, 1, sum)    # 9 12
apply(m, 2, mean)   # 1.5 3.5 5.5
```

The trap: `apply()` **coerces its input to a matrix first**. A data frame with a numeric and a
character column becomes an all-character matrix, and `apply(df, 1, mean)` then fails or returns
nonsense. Even on an all-numeric frame it is slow, because each row is extracted and passed as a
new vector.

```r
df <- data.frame(x = 1:3, y = c("a", "b", "c"))
apply(df, 1, paste, collapse = "-")   # works: everything is character
apply(df, 1, function(r) sum(as.numeric(r[-2])))  # fragile
```

Rule: `apply()` for matrices, `lapply()`/`map()` for lists and data frames. Never `apply()` on a
data frame because you want row-wise operations — use `rowSums()`, `dplyr::rowwise()` or
`purrr::pmap()`.

## lapply, sapply, vapply

`lapply(x, FUN)` always returns a list of the same length. That predictability is the point.

```r
files <- list.files("data", pattern = "\\.csv$", full.names = TRUE)
tables <- lapply(files, readr::read_csv)      # list of tibbles
```

`sapply()` is `lapply()` plus a guess about how to simplify the result. The guess is the problem:

```r
sapply(1:3, function(i) i^2)          # numeric vector
sapply(1:3, function(i) c(i, i^2))    # 2 x 3 matrix — not a list!
sapply(1:3, function(i) if (i == 2) NULL else i)   # list, silently
sapply(c(1, 2), function(i) if (i > 1) "big" else 1)  # character: "1" "big"
```

Four different return types from the same function, decided by the data. A function that returns
`NULL` for one element, or a different length for another, changes the shape of the output and
breaks whatever consumed it. This is the single most common source of "it worked on my sample"
in R code.

`vapply()` forces you to declare the return type, and errors if reality disagrees:

```r
vapply(1:3, function(i) i^2, numeric(1))            # safe
vapply(models, function(m) summary(m)$r.squared, numeric(1))
vapply(x, paste, character(1), collapse = ",")      # extra args go after FUN.VALUE
```

Use `vapply()` in packages and anything scheduled. Use `sapply()` interactively if you like, but
do not ship it.

## The rest of the family

| Function | Input | Returns | Use for |
|---|---|---|---|
| `lapply(x, f)` | vector/list | list, same length | the default |
| `sapply(x, f)` | vector/list | guessed | interactive only |
| `vapply(x, f, T)` | vector/list | declared type | production |
| `apply(x, m, f)` | matrix | vector/matrix | matrix margins |
| `mapply(f, ...)` | several vectors | vector/list | element-wise zip |
| `Map(f, ...)` | several vectors | list | `mapply(SIMPLIFY = FALSE)` |
| `tapply(x, g, f)` | vector + grouping | array | grouped summary |
| `split(x, g)` | vector + grouping | list | then `lapply` |
| `by(df, g, f)` | data frame + grouping | list | grouped frame ops |
| `rapply(x, f)` | nested list | list | recursive apply |

`tapply()` and `split()` are the base-R ancestors of `group_by() |> summarise()` and
`group_by() |> nest()`. They appear constantly in older code and in packages that avoid
dependencies.

```r
tapply(sales$revenue, sales$region, mean)
split(sales, sales$region) |> lapply(function(d) lm(revenue ~ month, data = d))
```

`split()` + `lapply()` is a legitimate pattern when each group needs its own model object and you
want a named list keyed by group.

## purrr: the same idea with types

`purrr::map()` is `lapply()` with a consistent interface, and the typed variants replace `sapply`'s
guessing with an explicit contract:

```r
library(purrr)

map(x, f)          # list
map_dbl(x, f)      # double vector; errors if any element is not length-1 numeric
map_chr(x, f)      # character
map_lgl(x, f)      # logical
map_int(x, f)      # integer
map_dfr(...)       # superseded: row-binds results into a data frame
```

`map_dbl()` failing loudly is the entire value proposition. `sapply()` returns `"2"`; `map_dbl()`
stops with "Can't coerce element 1 from a character to a double".

Since purrr 1.0, the `map_dfr()`/`map_dfc()` family is superseded in favour of composing:
`map(x, f) |> list_rbind()` and `map(x, f) |> list_cbind()`. `list_rbind()` takes a `names_to`
argument, so the list names become a column — a pattern that replaces a lot of manual `mutate()`
after the fact.

```r
files |>
  set_names(basename) |>
  map(readr::read_csv) |>
  list_rbind(names_to = "file")
```

Multiple inputs use `map2()` (two) or `pmap()` (any number, from a list of vectors):

```r
map2(regions, years, fetch_sales)
pmap(list(df = dfs, formula = formulas), function(df, formula) lm(formula, data = df))
```

`imap(x, f)` passes the element and its name or index, which is what you want when the result
should carry its key. `iwalk()` is the side-effect version.

## Failure, side effects and reduction

purrr's advantage over `lapply()` is the error-handling vocabulary. One bad file should not kill
a 400-file job.

```r
safe_read <- safely(readr::read_csv)          # list(result = , error = )
out <- map(files, safe_read)
ok <- out |> map_lgl(function(x) is.null(x$error))
map(out[ok], "result") |> list_rbind()

read_or_empty <- possibly(readr::read_csv, otherwise = tibble())
walk(files, function(f) message("reading ", f))   # walk: like map, returns input invisibly
compact(x)        # drop NULLs
keep(x, is.numeric) ; discard(x, is.null)
```

`safely()` captures both value and condition; `possibly()` substitutes a default; `quietly()`
captures printed output, messages and warnings.

`reduce()` and `accumulate()` fold a list:

```r
reduce(list(a, b, c), left_join, by = "id")     # a |> left_join(b) |> left_join(c)
accumulate(1:5, `+`)                            # 1 3 6 10 15
```

`reduce()` with `left_join` is the clean way to join twenty tables that share a key, though a
`full_join` + `reduce` on a list with inconsistent keys produces the same fan-out you would get by
hand.

## Parallelism

R is single-threaded at the language level, so CPU-bound `map()` work needs processes:

```r
library(future)
library(furrr)
plan(multisession, workers = 4)   # or multicore on Linux/macOS
future_map(files, slow_parse)
plan(sequential)
```

`parallel::mclapply()` forks and is Linux/macOS only; `future` + `furrr` works everywhere. Two
caveats that waste days: forked children inherit the parent's state but not its loaded connections
(database handles, sockets), and BLAS threading inside each worker multiplies — four workers on four
BLAS threads is sixteen threads fighting for four cores.
Set `RhpcBLASctl::blas_set_num_threads(1)` in workers.

## When a loop wins

Use `for` when you need: early exit (`break`), sequential dependency between iterations, progress
reporting on a long job, or memory discipline (process one item and discard it). `purrr::map()`
holds every result in memory until the pipeline finishes; a loop that writes each result to disk
and moves on is the correct choice for a 50 GB job on a 16 GB machine.

`purrr::map()` is worth it when the result is a list you will immediately combine, when the typed
variants can catch a shape error, or when you want `safely()` without writing `tryCatch()`.
`lapply()` is worth it when you want zero dependencies. Neither is faster than the other: both are
R loops calling an R function.

## Common mistakes

- `sapply()` in a function that must return a stable type.
- `apply(df, 1, ...)` on a mixed-type data frame — silent coercion to character.
- `lapply()` and forgetting it returns a list, then `unlist()`-ing and losing names.
- `map()` over a list of data frames and `rbind()`-ing with base `rbind`, which needs identical
  column names. Use `list_rbind()`.
- Parallelising an I/O-bound job and hitting the API's rate limit instead of going faster.
- `future_map()` inside a package function without resetting `plan()`; the caller's plan leaks.
- Writing new code with `map_dfr()`/`map_dfc()` when `map() |> list_rbind()` is the current form.

## Production notes

The `map()` + `list_rbind()` pattern with a `names_to` column is the most reusable idiom in
modern R: it turns "read every file in this folder" into a tidy table with provenance, and it fails
per file rather than per batch when combined with `safely()`.

Log the failures, not just the successes. A job that reports "398 of 400 files parsed" is
actionable; one that reports "done" is not.
