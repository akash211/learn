# Data Frames, Tibbles and dplyr Verbs

A data frame is a list of vectors that happen to be the same length. That is the whole data
structure: column types can differ, rows are implicit, and every operation is a vector operation
over columns. Understanding it as a list explains both the speed (column-wise work is contiguous)
and the surprises (`df[, "x"]` returning a vector, `length(df)` being the column count).

## What a data frame actually is

```r
df <- data.frame(id = 1:3, name = c("a", "b", "c"))
typeof(df)        # "list"
length(df)        # 2  <- columns, not rows
nrow(df)          # rows: 3
names(df)         # c("id", "name")
class(df$id)      # "integer"
attributes(df)    # names, row.names, class
```

`nrow(df)` is not a method call into a matrix; it reads `.row_names_info(df)`, which data frames
cache as an integer vector `c(NA, -n)`. Setting row names can turn that into a character vector of
length *n*, which is one of several reasons `rownames` are discouraged: they are stored as
attributes, they must be unique, and subsetting maintains them lazily.

Base R's `[` on a data frame has `drop = TRUE` by default:

```r
df[, "name"]           # character vector — the column, dropped to a vector
df[, "name", drop = FALSE]   # one-column data frame
df["name"]             # also a data frame, because one index means "columns"
```

## Tibbles: the same data, stricter rules

`tibble` (and `dplyr::tibble`) is a data frame with different defaults. This matters because
`tidyverse` functions return tibbles whether or not you asked for them.

| Behaviour | `data.frame` | `tibble` |
|---|---|---|
| `df[, "x"]` | vector (drops) | one-column tibble |
| `df$x` partial matching | yes, with a warning option | no, exact only |
| Row names | supported | not supported |
| Printing | every row, wide | 10 rows, column types, truncation |
| Recycling | length 1 or n, else error | length 1 or n, else error |
| Non-syntactic names | `check.names = TRUE` renames | preserved, quoted with backticks |
| List columns | possible, awkward | first class |
| `df[1, ]` | data frame | tibble |

The practical difference is printing and `[`. A tibble tells you `dbl`, `chr`, `fct`, `date` in
the header, which catches a numeric column that arrived as text before you compute a mean of
`NA`s. It also never partially matches, so a typo is an error rather than a wrong column.

Two things tibbles give up: row names (relevant if you rely on them for labels) and, in older
code, the assumption that `df[, i]` is a vector. Both are worth the trade.

## The five verbs

dplyr is a grammar of data manipulation with one function per verb, each taking a data frame
first and returning a data frame. The core set is small enough to memorise:

```r
library(dplyr)

result <- orders |>
  filter(status == "paid", order_ts >= as.Date("2024-01-01")) |>
  mutate(revenue = qty * unit_price,
         month = lubridate::floor_date(order_ts, "month")) |>
  summarise(revenue = sum(revenue),
            orders = n(),
            customers = n_distinct(customer_id),
            .by = c(customer_id, month)) |>
  arrange(desc(revenue))
```

- `filter()` keeps rows. Conditions combine with `&`, or as separate arguments. **`NA` conditions
  are treated as `FALSE`**, so `filter(x > 5)` silently drops rows where `x` is missing. If you
  need them, say `filter(is.na(x) | x > 5)`.
- `select()` picks columns, with helpers: `starts_with()`, `ends_with()`, `contains()`,
  `where(is.numeric)`, `everything()`, `any_of(vars)`. Use `any_of()` when the vector of names is
  data-dependent and may not exist.
- `mutate()` adds or overwrites columns, in order — later expressions see earlier ones.
- `summarise()` collapses to one row per group. Since dplyr 1.1 it can return multiple rows per
  group, and `reframe()` is the explicit version of that.
- `arrange()` sorts, with `desc()` for descending. **`NA`s always sort last**, unlike
  `order(na.last = TRUE)`'s default of dropping them.

Grouping has two forms. `group_by()` sets persistent grouping that survives until `ungroup()`;
`.by =` (dplyr 1.1) groups for one operation only. Prefer `.by`: it cannot leak state into a
later step, and forgetting `ungroup()` is a classic source of "why is my total wrong" bugs.

```r
# persistent grouping — easy to leak
orders |> group_by(customer_id) |> mutate(share = revenue / sum(revenue)) |> ungroup()

# per-operation grouping
orders |> mutate(share = revenue / sum(revenue), .by = customer_id)
```

## Column-wise work with `across()`

`across()` applies a function to a selection of columns inside `mutate()` or `summarise()`. It
replaces the superseded `mutate_if`/`summarise_at` family.

```r
df |>
  summarise(across(where(is.numeric), \(x) mean(x, na.rm = TRUE))) |>
  tidyr::pivot_longer(everything(), names_to = "variable", values_to = "mean")

df |> mutate(across(c(qty, unit_price), \(x) coalesce(x, 0)))
df |> mutate(across(where(is.character), trimws))
```

`\(x) x + 1` is the lambda syntax added in R 4.1; the older form is `function(x) x + 1`.
`.names` controls output names, e.g. `across(everything(), mean, .names = "{.col}_mean")`.

## Tidy evaluation, without the theory

dplyr arguments are not evaluated normally: `filter(df, revenue > 100)` looks up `revenue` inside
`df`. When you write a function that wraps a verb, you need to say what to do with the user's
column name.

```r
# embrace the argument
mean_of <- function(data, var) {
  data |> summarise(mean = mean({{ var }}, na.rm = TRUE))
}
mean_of(orders, revenue)

# refer to a column by name held in a string
summarise_col <- function(data, name) {
  data |> summarise(mean = mean(.data[[name]], na.rm = TRUE))
}

# create a column whose name comes from a variable
add_flag <- function(data, name, value) {
  data |> mutate("{name}" := value)
}
```

Three rules cover almost everything: `{{ }}` for a bare column name passed as an argument,
`.data[[ ]]` for a string, `"{name}" :=` to build a name on the left of an assignment. Outside
dplyr, `df[[name]]` is the base equivalent and needs no ceremony.

The tidyverse also ships a base pipe, `|>` (R 4.1), and magrittr's `%>%`. They differ in detail:
`%>%` supports the `.` placeholder anywhere in the call and is what older code uses; `|>` is
faster, has no dependency, and only pipes into the first argument unless you use `_` explicitly.
Mixing the two in one pipeline is legal but confusing.

## Window functions and rank

Grouped `mutate()` is R's window function. These come up in every analytics interview:

```r
df |>
  group_by(customer_id) |>
  arrange(order_ts) |>
  mutate(prev_order = lag(order_ts),
         seq = row_number(),
         running = cumsum(revenue),
         share = revenue / sum(revenue)) |>
  ungroup()
```

`lag()`/`lead()` shift within groups, `row_number()`, `min_rank()` and `dense_rank()` rank,
`ntile(x, 4)` buckets into quartiles, `cumsum()`/`cummean()` accumulate. `slice_max(df, revenue,
n = 3, by = customer_id)` is the "top N per group" shortcut, and `slice_sample(n = 100)` is a
random sample that respects grouping.

Base R's equivalents are worth knowing for code you cannot add dependencies to:

| dplyr | base R |
|---|---|
| `filter(df, cond)` | `df[cond, , drop = FALSE]` or `subset(df, cond)` |
| `select(df, a, b)` | `df[, c("a", "b")]` |
| `mutate(df, z = x + y)` | `df$z <- df$x + df$y` or `transform()` |
| `arrange(df, x)` | `df[order(df$x), ]` |
| `summarise(mean(x), .by = g)` | `aggregate(x ~ g, df, mean)` |
| `left_join(a, b)` | `merge(a, b, all.x = TRUE)` |
| `bind_rows(a, b)` | `do.call(rbind, list(a, b))`, names must match |

## Common mistakes

- `filter(x > 5)` and assuming `NA` rows survive. They do not.
- Forgetting `ungroup()` after `group_by()`, so a later `mutate()` computes group totals.
- Using `summarise()` when you meant `mutate()` — the row count collapses.
- `select(-c(a, b))` when `a` is absent: it errors. `select(-any_of(c("a", "b")))` does not.
- Writing `df$revenue` inside a function where `revenue` should be a parameter, then wondering
  why it ignores the argument.
- Assuming `arrange()` and `order()` treat `NA`s the same way.
- Using `nrow()` on a grouped tibble to mean "rows per group"; use `n()` inside `summarise()`.

## Production notes

dplyr is fast enough for tens of millions of rows when the work is column-wise, but the pipe is
not free: every verb materialises a new data frame, and a long pipeline holds several copies at
once. `dplyr::compute()`/`collapse`/`data.table` matter when memory is the binding constraint
(chapter 9).

Two habits make pipelines reviewable. Keep each verb on its own line so a diff shows which step
changed, and put a `count()` or a `stopifnot(nrow(...) == expected)` after any join or filter that
is supposed to preserve row counts. A pipeline that silently drops 4% of rows is worse than one
that fails, because the report still renders.
