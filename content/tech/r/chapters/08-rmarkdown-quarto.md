# R Markdown and Quarto Reporting

Most R work ends in a document: an analysis memo, a weekly KPI pack, a model validation report, a
knitted HTML dashboard. R Markdown and Quarto are how that document is produced from the same code
that produced the numbers, which is the whole point — a report where the figures were copy-pasted
from a console is a report that will be wrong within a month.

## R Markdown: the anatomy

An `.Rmd` file is three things interleaved: YAML metadata, Markdown prose, and code chunks.

````markdown
---
title: "Weekly revenue"
author: "Analytics"
date: "`r format(Sys.Date(), '%d %B %Y')`"
output:
  html_document:
    toc: true
    code_folding: hide
params:
  region: "EMEA"
---

```{r setup, include=FALSE}
knitr::opts_chunk$set(echo = FALSE, message = FALSE, warning = FALSE)
library(dplyr)
```

Revenue for `r params$region` was **`r scales::comma(total)`** this week.

```{r fig-revenue, fig.width=8, fig.height=4, fig.cap="Daily revenue"}
ggplot(daily, aes(order_date, revenue)) + geom_line()
```
````

The pieces that matter:

- **Inline code** `` `r expr` `` is what makes the prose follow the data. Any number typed by hand
  will eventually disagree with the table next to it.
- **Chunk options** are the contract with the renderer: `echo` (show code), `eval` (run it),
  `include` (produce output at all), `message`/`warning`/`error` (whether conditions abort, print,
  or are swallowed), `fig.width`/`fig.height`/`fig.cap`, `results = "asis"` (emit raw Markdown/HTML
  from the chunk), `cache`.
- **`params`** turns a report into a function. Render it once per region:

```r
library(rmarkdown)
purrr::walk(c("EMEA", "APAC", "AMER"), function(r) {
  render("report.Rmd", params = list(region = r),
         output_file = paste0("report-", r, ".html"))
})
```

That is the pattern behind every "one report per store / fund / client" pipeline, and it is a much
better answer than copying the file and editing a constant.

## Quarto: the successor, and what changed

Quarto is the next generation of the same idea from Posit, and it is not R-specific: the same
`.qmd` renders with the `knitr` engine (R) or `jupyter` (Python), and the CLI is a separate binary
from R.

```yaml
---
title: "Weekly revenue"
format:
  html:
    embed-resources: true
    toc: true
execute:
  echo: false
  warning: false
params:
  region: "EMEA"
---
```

Chunk options move into the chunk as comments:

````markdown
```{r}
#| label: fig-revenue
#| fig-cap: "Daily revenue"
#| fig-width: 8
ggplot(daily, aes(order_date, revenue)) + geom_line()
```

See @fig-revenue for the daily series.
````

The `#|` syntax is the visible change; the more consequential ones are:

| Feature | R Markdown | Quarto |
|---|---|---|
| Chunk options | in the chunk header | `#|` inside the chunk |
| Cross-references | manual (`Figure 1`) | `@fig-`, `@tbl-`, `@eq-` |
| Multi-document projects | `bookdown` | native `_quarto.yml` book/website |
| Non-R engines | no | knitr or jupyter |
| Parameters | `params:` in YAML | `params:` + `quarto render --execute-param` |
| Caching | `cache=TRUE` per chunk | `freeze: auto` per project |
| Publishing | manual | `quarto publish` (Posit Connect, Netlify, GitHub Pages) |

```bash
quarto render report.qmd -P region:APAC
quarto preview report.qmd
quarto check
```

```r
quarto::quarto_render("report.qmd", execute_params = list(region = "APAC"))
```

`freeze: auto` in `_quarto.yml` is the feature that makes project renders bearable: it re-executes
only documents whose source changed, instead of re-running every chapter of a book.

Which to choose: **Quarto for anything new**, especially multi-document projects, cross-references
and mixed-language work. **R Markdown** remains correct for existing reports, for `bookdown`-based
books already in production, and where the environment has `rmarkdown` but no Quarto binary — which
is still common in locked-down enterprise images.

## Tables and model output

Plain `knitr::kable()` is fine for a few rows:

```r
knitr::kable(head(df), digits = 1, caption = "Top rows")
```

Beyond that, pick by output:

- `gt` — best-looking HTML tables, with grouping and footnotes.
- `flextable` — Word and PowerPoint output, which is where most corporate reporting lands.
- `DT` — interactive, sortable tables in HTML.
- `modelsummary` or `gtsummary` — regression tables and descriptive summaries with correct
  formatting; `modelsummary::modelsummary(list(m1, m2), output = "gt")` is two lines for a
  publication-style table.

## Caching, and how it lies

`cache: true` (Quarto) or `cache=TRUE` (knitr) stores chunk results keyed on the code. It does
**not** know that the CSV on disk changed, that an API returned different data, or that a package
upgraded. The classic failure is a report that renders in 3 seconds with last month's numbers.

If you cache, declare the dependencies:

```r
#| cache: true
#| dependson: "data/raw/orders.csv"
```

and prefer `freeze: auto` at project level, which keys on file modification times. When a cached
render disagrees with reality, delete `_cache/` (or `*_cache/`) before debugging anything else.

## Reproducibility

A report is reproducible when the same source, data and environment produce the same output:

```r
set.seed(20240101)          # before any simulation or sampling
here::here("data", "orders.csv")   # paths relative to the project root, not the working dir
sessionInfo()               # appended to the report, or written to a sidecar file
```

`setwd()` in a script is the number one cause of "works on my machine": it makes the script depend
on where it was launched from, and Quarto/RStudio/`Rscript` all launch differently. `here::here()`
anchors to the project root (it looks for `.Rproj`, `.git` or `.here`).

`renv` pins package versions (chapter 10); without it, a report that rendered in March may fail in
June because `dplyr` changed a default or `ggplot2` changed an argument name.

## Rendering in production

The failure mode to design against is a report that renders successfully but says the wrong thing.
Two cheap defences:

1. **Assert before you print.** `stopifnot(nrow(df) > 0)`, `stopifnot(all(!is.na(df$revenue)))`,
   and a check that the latest date in the data is the expected one. A render that fails is far
   better than a render that silently uses last week's extract.
2. **Make the render exit non-zero on failure.** `quarto render` and `rmarkdown::render()` return
   non-zero on error, but only if the scheduler checks the exit code. `error = TRUE` in a chunk
   option is useful for showing an error in a teaching document and dangerous in a production
   report — it converts a failure into a published document.

Headless rendering needs more than R:

- `pandoc` ships with RStudio and with Quarto, but a bare container needs one installed explicitly.
- PDF output needs a LaTeX distribution (TinyTeX) or the `typst` backend, which is far smaller and
  faster to install and is Quarto's modern default for PDFs.
- Fonts must exist in the image, or PDF text falls back or fails (chapter 5).
- `chromote`/`webshot2` is needed for rendering HTML widgets or screenshots to PNG.

```bash
Rscript -e 'quarto::quarto_render("report.qmd")'
# or, in CI, the CLI directly:
quarto render report.qmd --output-dir out
```

## Common mistakes

- Numbers typed into prose instead of inline code, so the text and the table diverge.
- `echo = FALSE` globally, then a chunk that needs to show code — set it back per chunk.
- Relying on `cache = TRUE` for a report that reads live data.
- `setwd()` to make relative paths work.
- Rendering a report with `error = TRUE` in a production pipeline.
- A parameterised report that silently reuses the previous parameter because the loop variable
  was captured late (`purrr::walk` with `\(r)` is fine; a `for` loop with a lazily evaluated
  expression is not).
- Committing the rendered HTML but not the source, so nobody can tell how a number was produced.
- Assuming a machine with `R` can render PDF: it also needs LaTeX or Typst, and fonts.

## Production notes

Treat each report as a small program with an entry point, parameters, assertions and a versioned
environment. `targets` is the right tool when a report depends on expensive upstream steps: it
hashes inputs and skips work that has not changed, which is what `cache=TRUE` pretends to do.

Keep the rendered artifact and the `sessionInfo()` together. When someone asks in September why
the July number changed, the pair answers the question; the HTML alone does not.
