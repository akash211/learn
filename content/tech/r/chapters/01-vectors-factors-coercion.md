# Vectors, Factors and Coercion Traps

R has no scalar type. `1` is a vector of length one, `length(1)` is `1`, and every operator is
vectorised. Once that clicks, most of R's stranger behaviour stops being strange: the language is
built around a single object — the vector — with an attribute system bolted on to make it a
factor, a date, a data frame or a model.

This chapter covers the objects everything else is built from, and the coercions that silently
change your data.

## The coercion ladder

`c()` and the `as.*` family coerce to the *highest* type present, in this order:

```
logical  <  integer  <  double  <  complex  <  character
```

```r
c(1L, 2.5)          # double: 1.0 2.5
c(TRUE, 1L)         # integer: 1 1
c(1L, "a")          # character: "1" "a"
c(TRUE, 2.5)        # double: 1 2.5
```

Upward coercion is lossless and silent. Downward coercion via `as.integer()` throws information
away without complaint:

```r
as.integer(2.9)     # 2  — truncates toward zero
as.integer(-2.9)    # -2
as.integer("2.9")   # 2, and "abc" becomes NA with a warning
```

Two integer facts bite in production. `1` is a double; `1L` is an integer, and `:` returns
integers. And integers are 32-bit: anything past `2^31 - 1` (about 2.1 billion) becomes `NA` with
a warning, which is how row counts silently vanish after a `sum()` on a large table. Use
`double` or `bit64::integer64` when IDs and counts can exceed that.

## Three ways to build a sequence

```r
n <- 0
1:n              # 1 0     <- wrong, and it does not error
seq_len(n)       # integer(0)
seq_along(x)     # 1:length(x), always correct
```

`1:n` is the most common off-by-one bug in R because `:` counts *down* when `n < 1`. It appears
in loops that "work" on test data and produce a phantom row on empty input. Write `seq_len(n)`.

## Subsetting: `[`, `[[` and `$`

`[` returns a **subset of the same type**; `[[` returns **one element, unwrapped**.

```r
x <- list(a = 1:3, b = "text")
x[1]        # list of one element
x[[1]]      # integer vector 1 2 3
x$b         # "text", with partial matching: x$b matches x$bb if unambiguous
x[["b"]]    # exact by default
```

| Expression | Result | Note |
|---|---|---|
| `x[2]` | same type, length 1 | keeps names and attributes |
| `x[[2]]` | the element itself | errors if absent; `$` returns `NULL` |
| `x[-1]` | all but the first | cannot mix positive and negative |
| `x[c(TRUE, FALSE)]` | logical mask | recycled to length, silently |
| `x[0]` | empty vector | not `NULL` |
| `x[NA]` | `NA`-filled, length of `NA` | logical mask of unknown value |
| `x["name"]` | by name | missing name gives `NA`, not an error |

The dangerous ones are the last two rows. `x[NA]` does not mean "missing element"; it means
"select an unknown element", and the result is a vector of `NA`s. And a logical index shorter
than the vector recycles without warning, so `x[c(TRUE, FALSE)]` on a length-4 vector takes
elements 1 and 3 — often intended, sometimes a bug that looks like a data problem.

Character subsetting never errors on unknown names: `df[, "revenue"]` where the column is spelled
`revnue` is a hard error, but `df$revnue` returns `NULL` and then flows into a calculation as an
empty vector. Prefer `[[` with a variable, `dplyr::all_of()` in selections, or validate names at
the boundary of a script.

## NA, NaN and the logic of missing data

`NA` is a *logical* constant that can be coerced into any type. Each type has its own flavour —
`NA_integer_`, `NA_real_`, `NA_character_` — and `typeof(NA)` is `"logical"`.

```r
NA == NA            # NA, not TRUE
is.na(NA)           # TRUE  — the only safe test
is.nan(NaN)         # TRUE
is.nan(NA_real_)    # FALSE
is.na(NaN)          # TRUE  — NaN is a kind of missing value
0/0                 # NaN
1/0                 # Inf
```

Because comparisons propagate `NA`, `if (x == NA)` is a bug in two ways: it is never `TRUE`, and
`if` requires a length-one `TRUE`/`FALSE`, so it raises *"missing value where TRUE/FALSE
needed"*. Use `is.na(x)`.

Aggregates have an `na.rm` argument that defaults to `FALSE`, so one missing value poisons a
sum. But `na.rm = TRUE` on an all-`NA` vector returns `0` for `sum()` and `NaN` for `mean()` —
different answers to "how much?" and "what average?", and both are usually wrong. Decide
explicitly:

```r
revenue <- c(120, NA, 90)
sum(revenue, na.rm = TRUE)                  # 210
mean(revenue, na.rm = TRUE)                 # 105
if (all(is.na(revenue))) NA_real_ else mean(revenue, na.rm = TRUE)
```

`%in%` is the exception worth memorising: it is built on `match()`, so it never returns `NA`.
`NA %in% c(1, NA)` is `TRUE`, which makes it the right tool for "is this value in the reference
list" checks where `==` would return `NA`.

`any()` and `all()` short-circuit on `NA` in a way that depends on argument order: `any(c(TRUE,
NA))` is `TRUE`, `any(c(FALSE, NA))` is `NA`. In an `if`, that `NA` is an error.

## Floating point, rounding and equality

```r
0.1 + 0.2 == 0.3            # FALSE
abs((0.1 + 0.2) - 0.3) < 1e-8   # TRUE — tolerance, not equality
dplyr::near(0.1 + 0.2, 0.3)     # TRUE
all.equal(0.1 + 0.2, 0.3)       # TRUE, with a tolerance of about 1.5e-8
```

`identical(0.1 + 0.2, 0.3)` is `FALSE` and `all.equal()` is `TRUE`; they answer different
questions. For assertions in tests, use `testthat::expect_equal()` (tolerant) rather than
`expect_identical()` unless you mean bit-identical.

`round()` uses round-half-to-even, per IEC 60559:

```r
round(2.5)   # 2
round(3.5)   # 4
round(-2.5)  # -2
```

This is not a bug, but it is not what finance teams expect on a `.5` boundary. When the business
rule is "half up", say so in code (`floor(x + 0.5)` for positives) rather than arguing with
`round()`.

## Factors are integers wearing a label

A factor is an integer vector plus a `levels` attribute. That design is efficient for modelling
and the source of most factor bugs.

```r
x <- factor(c("2", "10", "2"))
levels(x)                     # "2" "10"  — sorted as text, not numerically
as.integer(x)                 # 1 2 1      — codes, not values
as.numeric(x)                 # 1 2 1      — same thing, the classic bug
as.numeric(as.character(x))   # 2 10 2     — correct, slower
as.numeric(levels(x))[x]      # 2 10 2     — correct, fast, idiomatic
```

The rule: **never call `as.numeric()` on a factor.** It returns level codes. This is why
"the average of the score column is 2.4" reports appear when the scores are 10, 20 and 30.

Other factor facts that matter:

- Assigning a value not in `levels()` produces `NA` with a warning: *"invalid factor level, NA
  generated"*. This is how a new product code silently becomes missing data.
- `<` and `>` on an unordered factor warn and return `NA`. Comparison uses level order, not
  alphabetical or numeric order — `factor("10") < factor("9")` is `TRUE` because `"10"` sorts
  first as text.
- `table()` reports zero for levels with no rows; `count()` drops them unless you pass
  `.drop = FALSE`. `droplevels()` or `forcats::fct_drop()` removes them for good, which matters
  when the factor reaches a model matrix (an unused level becomes an `NA` coefficient) or a join.
- `ifelse()` on a factor returns integer codes, not labels.

Since R 4.0.0, `data.frame()` and `read.csv()` default to `stringsAsFactors = FALSE`, so text
stays character. Older tutorials and older scripts assume the opposite; a script written before
4.0 that relied on implicit factors behaves differently on a modern interpreter. Convert
deliberately with `factor()` when you want levels, and use `forcats` for the operations base R
lacks:

```r
library(forcats)
fct_relevel(f, "control")          # reference level first
fct_reorder(f, revenue, median)    # order levels by a statistic, for charts
fct_lump(f, n = 8)                 # keep the top 8, lump the rest into "Other"
fct_infreq(f)                      # most frequent first
```

## Common mistakes

- `1:n` when `n` can be zero or negative. Use `seq_len(n)`.
- `as.numeric(factor)`. It returns codes; go through `levels()`.
- `if (x == NA)`. Use `is.na(x)`.
- `sum(x, na.rm = TRUE)` on an all-missing column and reading `0` as a real zero.
- Growing a vector with `x <- c(x, y)` in a loop — quadratic copying, not a syntax error.
- Treating `==` on doubles as exact and concluding a value "changed".
- Assuming `x[NA]` returns `NA` of length one.
- Building a factor, filtering most rows away, and leaving the unused levels to reappear as `NA`
  coefficients, empty `table()` rows or a misleading level count.

## Production notes

Coercion failures are quiet, so make them loud at the edges of a pipeline. `readr::read_csv()`
prints a column specification and reports parsing failures instead of silently producing `NA`;
`vroom` does the same with more speed. After every ingest, assert the types you expect
(`stopifnot(is.numeric(df$amount))`) rather than discovering them three joins later when a
character column makes `mean()` return `NA`.

For a scheduled job, log `sum(is.na(x))` per critical column after each transform. Missingness
that appears between two steps is nearly always a coercion, a factor level or a failed join —
in that order.
