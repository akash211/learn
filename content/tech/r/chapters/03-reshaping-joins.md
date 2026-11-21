# Reshaping and Joins

Two operations account for most of the "the numbers don't match" tickets in an analytics team:
data in the wrong shape, and a join that changed the row count. Both are mechanical, both are
testable, and both are where tidyr and dplyr earn their place.

## Tidy data, and why the shape is not arbitrary

Tidy data is a convention, not a law: one row per observation, one column per variable, one value
per cell. It matters because ggplot2 aesthetics, dplyr grouping and most modelling functions all
assume it. A column holding `q1, q2, q3, q4` violates it by encoding a *variable* (quarter) in
the column name; a cell holding `"12;15;9"` violates it by packing three observations into one.

| Shape | Good for | Bad for |
|---|---|---|
| Wide (one column per period) | reading, exporting to finance, human review | grouping, plotting, modelling |
| Long (one row per period) | `group_by`, `ggplot`, `lm`, joins on period | reading, fixed-width reports |

Reshaping is cheap and reversible. Reshape late, at the boundary where a human or a downstream
system needs the other shape — not in the middle of a pipeline.

## pivot_longer: wide to long

```r
library(tidyr)
library(dplyr)

sales <- tibble(
  store = c("A", "B"),
  q1_2023 = c(120, 90), q2_2023 = c(135, 88),
  q1_2024 = c(150, 95), q2_2024 = c(160, 101)
)

sales |>
  pivot_longer(
    cols = -store,
    names_to = c("quarter", "year"),
    names_sep = "_",
    values_to = "revenue",
    names_transform = list(year = as.integer)
  )
```

The arguments that do the work:

- `cols` takes tidy-select, so `-store`, `starts_with("q")` and `where(is.numeric)` all work.
- `names_to` is a character vector when one column name encodes several variables; `names_sep`
  or `names_pattern` splits it. Use `names_pattern = "(q\\d)_(\\d{4})"` when separators are
  inconsistent.
- `names_prefix` strips a constant prefix, which is simpler than a regex when that is all you need.
- `values_drop_na = TRUE` removes rows created from empty wide cells — the usual fix for a
  ragged table where period 3 exists for some entities and not others.
- `names_transform`/`values_transform` convert types at pivot time, so you do not need a
  `mutate()` afterwards.

The `.value` sentinel handles the case where multiple measures share a key. This is the one
genuinely non-obvious feature:

```r
wide <- tibble(id = 1:2, sales_2023 = c(10, 20), cost_2023 = c(4, 9),
               sales_2024 = c(11, 22), cost_2024 = c(5, 9))

wide |>
  pivot_longer(cols = matches("^(sales|cost)_"),
               names_to = c(".value", "year"),
               names_sep = "_")
# id  year  sales  cost
```

`.value` says "the first piece of the name is a measure, the second identifies the row". It
requires the measures to be balanced across keys; an unmatched `sales_2024` with no
`cost_2024` produces `NA` in `cost`, which is usually what you want but worth checking.

`gather()` and `spread()` are the pre-2019 predecessors. They still run; do not write new code
with them.

## pivot_wider: long to wide

```r
long |>
  pivot_wider(
    id_cols = customer_id,
    names_from = metric,
    values_from = value,
    values_fill = 0,
    names_sort = TRUE
  )
```

Two behaviours matter:

- **Duplicate keys.** If `(customer_id, metric)` is not unique, `pivot_wider()` warns that values
  are not uniquely identified and produces list-columns. That warning is not cosmetic: either
  aggregate first (`values_fn = sum`) or add the missing key column. Silently taking the first
  value is how a "total revenue" column ends up 60% of the truth.
- **`names_sort`** defaults to `FALSE`, so columns appear in order of first appearance, not
  alphabetically or chronologically. For a report read left to right, set it.

`values_fn` is the explicit aggregator. `values_fn = list(value = sum)` is the safe form when the
value column is also named in `values_from`.

Adjacent tidyr functions in the same family:

```r
df |> separate_wider_delim(id, delim = "-", names = c("site", "year"))
df |> separate_longer_delim(tags, delim = ";")   # one row per tag
df |> unite("key", c(site, year), sep = "_", remove = FALSE)
df |> complete(site, year, fill = list(revenue = 0))  # materialise missing combinations
df |> fill(balance, .direction = "down")              # carry last observation forward
df |> drop_na(revenue)
```

`complete()` is the correct answer to "the chart drops months with no sales" — the rows do not
exist, so no amount of `scale_x` fiddling fixes it. For nested structures, `nest()` and `unnest()`
turn a group of columns into a list-column of tibbles and back; that is the shape `purrr::map`
expects when you fit one model per group.

## Joins: what actually happens

dplyr has two families. **Mutating joins** add columns: `left_join`, `right_join`, `inner_join`,
`full_join`. **Filtering joins** keep rows: `semi_join` (keep x rows with a match) and `anti_join`
(keep x rows without one). There is also `cross_join` for the Cartesian product, and
`nest_join` for a list-column of matches.

```r
orders |> left_join(customers, by = join_by(customer_id))

# different key names on each side
orders |> left_join(customers, by = join_by(customer_id == id))

# inequality join: as-of lookup of the price valid at order time
orders |>
  left_join(prices, by = join_by(product_id, order_ts >= valid_from, order_ts < valid_to))
```

`join_by()` (dplyr 1.1) replaces the string-vector form for anything beyond equality:
`join_by(a, b)`, `join_by(a == x)`, `join_by(x >= lower, x < upper)`, and `closest(x)` for the
nearest match. Equality conditions must come first; inequalities are evaluated after them, which
is what makes an as-of join behave like an index seek rather than a nested loop in a database.

Three guards to turn on deliberately:

**`relationship`** asserts the cardinality. `relationship = "many-to-one"` errors if the right
side has duplicate keys. This is the single cheapest defence against fan-out:

```r
orders |> left_join(prices, by = join_by(product_id, order_ts >= valid_from),
                    relationship = "many-to-one")
```

**`multiple`** controls what happens when a row matches several rows. The default warns on
unexpected many-to-many matches; `multiple = "all"` accepts the expansion, `"first"`/`"last"`
pick one, `"any"` picks arbitrarily.

**`na_matches`** defaults to `"na"`, so `NA` keys match each other. That is usually desired for
reference data and usually catastrophic for fact tables — `na_matches = "never"` stops two
unknown customers from being merged into one.

Keys must be the same type. Joining an integer column to a character column errors in dplyr
(base `merge()` coerces silently and matches `"1"` to `1`). Mixing a factor with a character is
the subtler case: depending on version it errors or coerces, so cast explicitly with `as.character()`
on both sides before you join. Check `class()` on both sides before blaming the join.

Base and data.table equivalents, for when you cannot take the dependency:

```r
merge(x, y, by = "id", all.x = TRUE, sort = FALSE)   # left_join
x[x$id %in% y$id, ]                                  # semi_join, for small y
x[!x$id %in% y$id, ]                                 # anti_join
```

`merge()` sorts by the key unless `sort = FALSE`, which is why "the order changed after the join"
is a base-R complaint and not a dplyr one. `data.table`'s `x[y, on = "id"]` is the fastest of the
three and uses the same left-join semantics with the *right* table as `i`.

## Diagnosing a row-count change

Every join either preserves the left row count (`left_join` with a unique right key) or multiplies
it. There is no third option. So check before and after:

```r
n0 <- nrow(orders)
joined <- orders |> left_join(prices, by = join_by(product_id), relationship = "many-to-one")
stopifnot(nrow(joined) == n0)
```

When it *does* multiply, the cause is one of: duplicate keys in the right table (a slowly changing
dimension without a version column), a key that is `NULL`/`NA` on both sides, or a many-to-many
relationship you assumed was one-to-one. `count(y, key) |> filter(n > 1)` finds the first in
seconds.

## Common mistakes

- Pivoting with `names_sep` when the names use mixed separators; the pivot silently produces
  `NA` in `names_to` columns. Check with `anyNA()`.
- `pivot_wider()` with duplicate keys and accepting the list-column warning.
- Forgetting that `pivot_longer()` on an all-character frame makes every value character;
  `values_transform` or an explicit `type.convert()` fixes it.
- Joining on a key with different types and getting zero matches rather than an error in base R.
- Assuming `full_join()` fills missing numeric values with `0`. It fills with `NA`.
- Using `inner_join()` for a left-preserving step, then wondering where 200 customers went.
- Relying on row order after a join. Nothing guarantees it; `arrange()` explicitly.

## Production notes

Reshape and join in the middle of a pipeline only with an assertion on either side. A `stopifnot()`
on row count and on the count of distinct keys catches the two failure modes that produce a
plausible-looking wrong report.

For large joins, filter and select before joining, not after: `select()` costs nothing, and a
narrower right-hand table is the difference between a hash join that fits in memory and one that
does not. In dplyr the join is a hash join on the key; in `data.table` it is a binary search on a
sorted key, so `setkey()` first when you join repeatedly.
