# Performance and Memory

R has a reputation for being slow that is half deserved and half a misunderstanding. The
interpreter is slow per operation, but almost nothing you do in analysis is a per-operation
problem — it is a per-vector problem, and the vector operations are C. The code that crawls is
usually doing one of three things: growing an object in a loop, copying a large data frame
repeatedly, or running an interpreted function a million times.

This chapter is about recognising those three, measuring before guessing, and knowing the point
where you should stop optimising R and hand the work to something else.

## Copy-on-modify, and why assignment is not free

R semantics are value semantics: `b <- a` does not copy, but the moment either name is modified,
the object is duplicated.

```r
a <- 1:1e6
b <- a                 # no copy; both names point at the same object
b[1] <- 0L             # now a full copy of a million elements
lobstr::obj_addr(a); lobstr::obj_addr(b)   # different addresses after the write
lobstr::obj_size(a)                        # ~4 MB
```

`lobstr::ref()` shows the reference count; a count above 1 means the next modification will copy.
This is why `df$new <- ...` inside a function that received `df` as an argument allocates: the
caller still holds a reference.

Two things follow. First, loops that modify a data frame row by row are quadratic: each iteration
copies every column. Second, `data.table`'s reference semantics are not a micro-optimisation, they
are a different contract — see below.

ALTREP (R 3.5+) softens this for some objects: `1:1e8` is stored as start/step/length, so
`object.size()` reports a few hundred bytes and operations on it can be lazy. It does not rescue
you from editing a materialised vector.

## Vectorisation: what it actually buys

```r
x <- runif(1e6)
y <- numeric(length(x))
for (i in seq_along(x)) y[i] <- sqrt(x[i])   # interpreted loop

y <- sqrt(x)                                  # one call into C
```

The second version is faster by a large factor, but the reason is not "R is bad at loops" — it is
that the loop pays interpreter overhead per element while `sqrt()` pays it once. Both do the same
arithmetic. Where the arithmetic is trivial (addition, comparison), that overhead dominates; where
each iteration does real work (a model fit, a file read), it is noise and a loop is fine.

The rule: **vectorise the arithmetic, loop the units of work.** `sqrt(x)` over a million numbers;
`map()` over 400 files.

## Growing objects

```r
out <- c()
for (i in 1:10000) out <- c(out, i)     # O(n^2): 50 million element copies

out <- integer(10000)
for (i in seq_len(10000)) out[i] <- i   # O(n)

out <- vapply(seq_len(10000), identity, integer(1))
```

If the final size is unknown, collect into a list and `unlist()`/`list_rbind()` once, or use
`append()` on a list (amortised cheaper than on a vector). Never `rbind()` inside a loop over
data frames — each `rbind` copies every column of every previous result.

## data.table: reference semantics and keys

`data.table` is the fastest general-purpose tool in R for grouped operations on large in-memory
data, and its syntax is worth learning even if you mostly use dplyr, because it appears in
performance-critical code everywhere.

```r
library(data.table)
dt <- as.data.table(orders)

dt[, .(revenue = sum(revenue), n = .N), by = .(customer_id, month)]
dt[, margin := revenue - cost]                 # := modifies in place, no copy
dt[, c("a", "b") := .(f(x), g(y))]             # multiple columns at once
dt[order(-revenue)][1:10]
setkey(dt, customer_id)
dt[lookup, on = .(customer_id), nomatch = NULL]   # binary-search join
fread("orders.csv"); fwrite(dt, "out.csv")        # parallel read/write
```

Four facts that matter:

- `:=` modifies by reference. `f <- function(d) { d[, x := 1] }` changes the caller's table. Call
  `copy(dt)` when you need value semantics.
- `.SD`, `.N`, `.I`, `.GRP` and `.BY` are the special symbols: `.SD` is the subset of columns, `.N`
  the group size.
- `setkey()`/`setindexv()` sort or index once so later joins and filters are binary searches rather
  than scans. Repeated joins on the same key should always be keyed.
- `fread()` and `fwrite()` are the fastest CSV tools in R and handle multi-GB files with reasonable
  memory.

`collapse` is a lighter alternative for grouped statistics (`fmean`, `fsd`, `collap`) that does not
require converting to a `data.table` and is often faster than both for simple aggregations.

## Measuring before guessing

```r
system.time(big_job())                      # coarse, once
bench::mark(                               # microbenchmark with memory
  dplyr = df |> summarise(m = mean(x), .by = g),
  dt    = dt[, .(m = mean(x)), by = g],
  check = FALSE, iterations = 10
)
```

`bench::mark()` reports median time and `mem_alloc` per expression, and `check = FALSE` stops it
complaining that the results differ in class. `microbenchmark::microbenchmark()` is the older
equivalent.

For a whole script, profile rather than reason:

```r
Rprof("prof.out", interval = 0.01, memory.profiling = TRUE)
source("job.R")
Rprof(NULL)
summaryRprof("prof.out")     # by self time and by total time

profvis::profvis({ source("job.R") })   # flame graph in RStudio/browser
```

`summaryRprof()` gives `$by.self` (time inside a function) and `$by.total` (including callees).
Read `by.total` to find the expensive subtree, `by.self` to find the hot primitive. `profvis` shows
the same as a flame graph, and its memory panel attributes allocation to the call that caused it —
which is how you find the copy you did not know about.

Three profiling truths: the bottleneck is almost never where you guessed; the second run is faster
than the first because of caching and JIT; and a profile of a job that spends 80% of its time in
`read.csv` is telling you to fix the I/O, not the model.

## Memory: where it goes

```r
object.size(df)        # base: no shared-string accounting
lobstr::obj_size(df)   # accounts for shared columns and ALTREP
pryr::object_size(df)  # the older equivalent
```

- Doubles are 8 bytes, integers 4, logical 4 (in a vector), and every element of a list is a
  56-byte-ish pointer plus its own object. A list of 1e6 small vectors is far larger than a
  1e6-row data frame.
- Character vectors are pointers into a global string pool, so repeated strings are cheap, but
  unique strings (IDs, free text) are expensive. A factor is 4 bytes per element plus the levels —
  smaller than a character column of long unique strings, and the reason `factor()` still helps on
  large data.
- Logical `NA` in an integer column is 4 bytes; a numeric column with `NA` stays 8 bytes per element.
  An integer column is often a 2× memory win over a double column that holds whole numbers.

`rm(x); gc()` frees memory, but only if nothing else references `x`. In a function, locals are
freed on exit; at top level, they persist until removed. `gc()` is rarely needed manually, and
calling it in a loop is a symptom of a memory problem, not a fix.

When the data does not fit:

```r
arrow::read_parquet("orders.parquet")          # columnar, memory-mapped, zero-copy to Arrow
duckdb::dbConnect(duckdb::duckdb())            # SQL over Parquet/CSV without loading it all
```

`arrow` and `duckdb` are the honest answer to "R cannot handle this file". Both integrate with
dplyr verbs (`arrow` via `arrow_table()`, duckdb via `tbl()`), so you keep the syntax and push the
work down. `duckplyr` goes further and runs dplyr verbs through DuckDB.

## Parallelism, and the trap that eats the gain

```r
future::plan(future::multisession, workers = 4)
furrr::future_map(items, slow_fn)
future::plan(future::sequential)    # reset; the plan is global state
```

Two failure modes:

1. **BLAS oversubscription.** Each worker inherits a multi-threaded BLAS. Four workers × four BLAS
   threads on four cores is slower than one worker. Set
   `RhpcBLASctl::blas_set_num_threads(1)` (or `OMP_NUM_THREADS=1`) in workers doing linear algebra.
2. **Copy-on-write memory.** Forked workers (`multicore`, `mclapply`) share memory until they write;
   a worker that modifies a large frame gets its own copy, and four of those exhaust RAM.

Parallelism only helps CPU-bound work. An I/O-bound job parallelised four ways usually hits a rate
limit and gets slower.

## Common mistakes

- `c()` or `rbind()` inside a loop.
- Profiling with `system.time()` on a single run and drawing conclusions from noise.
- `as.data.frame(dt)` to "be safe", copying a multi-GB table.
- `:=` inside a function on a caller's table, mutating state the caller did not expect.
- Converting unique IDs to factors and assuming it saves memory — with 5 million distinct IDs, the
  level vector costs more than the original.
- Parallelising before profiling; the bottleneck is usually I/O or one slow function called once.
- Assuming `gc()` will fix an out-of-memory error caused by holding three copies of the frame.

## Production notes

Most production R jobs are memory-bound, not CPU-bound. The two changes that pay off repeatedly are
reading only the columns you need (`readr::read_csv(col_select = ...)`, `arrow::open_dataset()` with
`select`) and filtering before joining rather than after.

Measure the peak, not the mean: `gc()` reports max memory used, and a job that peaks at 14 GB on a
16 GB box will fail intermittently depending on what else is running. Leave headroom, and put the
limit in the scheduler, not in a comment.
