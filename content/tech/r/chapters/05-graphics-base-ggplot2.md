# Base Graphics and the ggplot2 Grammar

R ships with a complete plotting system and also has the most influential grammar of graphics
implementation in any language. They are not competitors so much as different tools: base graphics
is a pen you move around a page, ggplot2 is a description of a chart that the library renders.

Knowing both matters because diagnostic plots, package internals and 30-year-old scripts all use
base graphics, while anything a stakeholder sees should probably be ggplot2.

## Base graphics: a canvas with state

```r
plot(x, y, pch = 19, col = "steelblue", xlab = "Month", ylab = "Revenue")
abline(h = mean(y), lty = 2)
lines(seq_along(y), fitted(loess(y ~ seq_along(y))), col = "firebrick")
legend("topleft", legend = c("actual", "trend"), col = c("steelblue", "firebrick"),
       pch = c(19, NA), lty = c(NA, 1))
```

Each call draws onto the *current device* and mutates it. That is why base graphics is described
as "painting": `plot()` starts a new canvas (unless `add = TRUE`), and `points()`, `lines()`,
`text()`, `abline()` and `legend()` add to it. Order matters, and there is no object to inspect
afterwards — the chart exists only as pixels.

Global state lives in `par()`:

```r
par(mfrow = c(2, 2), mar = c(4, 4, 1, 1))
plot(fit)              # the four lm diagnostic panels, in base graphics
par(mfrow = c(1, 1))   # reset — this is not automatic
```

`par()` settings persist across calls and across functions. A helper that sets `par(mfrow)` and
does not restore it corrupts every plot drawn afterwards in the session — a real bug in shared
scripts and Shiny apps. Save and restore:

```r
old <- par(no.readonly = TRUE); on.exit(par(old))
```

Where base wins, decisively:

- `plot(lm_object)` — four diagnostic panels, correct and instant.
- `hist()`, `boxplot()`, `pairs()`, `acf()`, `image()` for a quick look at data.
- Zero dependencies: a package that only needs a plot should not import ggplot2.
- Very large scatter plots, where base `plot()` draws points faster than a ggplot build.
- Precise, absolute positioning when you need it.

Devices are the file format layer: `pdf()`, `png()`, `svg()`, `jpeg()`, then `dev.off()`. Modern
practice is `ragg::agg_png()` for better text rendering and font handling than the default cairo
device.

## The grammar: seven nouns

A ggplot2 chart is declared, not drawn:

```r
library(ggplot2)

ggplot(orders, aes(x = order_ts, y = revenue, colour = channel)) +
  geom_line(linewidth = 0.8) +
  geom_point(data = dplyr::filter(orders, revenue > quantile(revenue, 0.99)),
             size = 2) +
  scale_y_continuous(labels = scales::dollar) +
  scale_colour_viridis_d(end = 0.8) +
  facet_wrap(~ region, ncol = 2, scales = "free_y") +
  labs(x = NULL, y = "Revenue", colour = "Channel",
       title = "Revenue by channel", subtitle = "Daily, 2024",
       caption = "Source: orders") +
  theme_minimal(base_size = 11) +
  theme(axis.text.x = element_text(angle = 45, hjust = 1),
        legend.position = "bottom")
```

The components, and what each one is for:

| Component | Function of | Example |
|---|---|---|
| data | the nouns | `orders`, or a filtered copy in one layer |
| mapping | which column plays which role | `aes(x, y, colour, size, fill)` |
| geom | the mark | `geom_point`, `geom_col`, `geom_line`, `geom_boxplot` |
| stat | the transform | `geom_histogram` (bin), `geom_smooth` (loess/lm) |
| scale | the value → visual encoding | `scale_x_log10`, `scale_fill_viridis_c` |
| facet | small multiples | `facet_wrap(~ g)`, `facet_grid(a ~ b)` |
| coord | the space | `coord_fixed`, `coord_cartesian(ylim = ...)` |
| theme | everything non-data | `theme_minimal`, fonts, legends, gridlines |

Because the object is data, it composes: `p + geom_smooth()` returns a new plot, and
`patchwork` composes plots (`p1 | p2`, `p1 / p2`).

Two consequences that surprise people:

1. **`+` builds lazily.** Nothing is drawn until the object is printed. At the console that is
   automatic; inside a `for` loop or a function that returns invisibly, you must call
   `print(p)` explicitly.
2. **The `+` must end the line, or R parses the previous expression as complete.** This is a
   syntax error, not a logic error, and it is the most common ggplot2 beginner bug.

## Long data is not optional

ggplot2 maps *columns* to aesthetics, so a wide frame with `revenue_2023` and `revenue_2024`
cannot produce two lines without reshaping:

```r
sales_long <- sales |> tidyr::pivot_longer(starts_with("revenue_"),
                                           names_to = "year",
                                           names_prefix = "revenue_",
                                           values_to = "revenue")
ggplot(sales_long, aes(x = month, y = revenue, colour = year)) + geom_line()
```

This is the strongest practical argument for tidy data (chapter 3): the reshape you do for
grouping is the reshape you need for plotting.

## Programming a ggplot

`aes()` evaluates its arguments inside the data, which breaks when the column name is a variable:

```r
scatter <- function(df, xvar, yvar) {
  ggplot(df, aes(x = .data[[xvar]], y = .data[[yvar]])) + geom_point()
}
```

`.data[[ ]]` is the current idiom. `aes_string()` is deprecated and `aes_(x = as.name(xvar))` is
the older, uglier predecessor. Do not build formulas with `paste()` and `eval(parse())`.

## Base versus ggplot2, honestly

| Task | Better | Why |
|---|---|---|
| One-off look at data | base | one line, no object |
| Diagnostic plots for `lm`/`glm` | base | `plot(fit)` is the reference implementation |
| A chart for a report | ggplot2 | consistent defaults, facets, legends, scales |
| Small multiples | ggplot2 | `facet_wrap` is one argument |
| Precise overlay of many series | base | `lines()` in a loop is simpler than building layers |
| Themed, branded output | ggplot2 | `theme_set()` + a company theme object |
| Huge scatter (millions of points) | base or `scattermore` | faster rendering |
| Interactive | either, via `plotly` | `ggplotly(p)` | 

Base is not "the old one" to be avoided; it is a different abstraction with less ceremony and more
immediate control.

## Saving output

```r
ggsave("revenue.png", plot = p, width = 8, height = 5, dpi = 300, bg = "white")
ggsave("revenue.pdf", p, width = 8, height = 5)     # vector, for print
```

`ggsave()` infers the device from the extension and defaults to the last printed plot, which is a
hidden dependency — pass `plot =` explicitly in scripts. `dpi` only affects raster output; the
default 300 is right for documents and too low for print. `bg = "white"` prevents the transparent
background that shows up as black in PowerPoint.

For base graphics, wrap the drawing calls:

```r
ragg::agg_png("plot.png", width = 2400, height = 1500, res = 300)
plot(x, y); dev.off()
```

## Common mistakes

- Leaving `par(mfrow = c(2, 2))` set and corrupting later plots.
- `+` on the next line: `ggplot(...) \n + geom_point()` is a syntax error.
- Building a plot in a loop and never calling `print()`.
- Plotting a factor without `fct_reorder()`, so bars appear alphabetically instead of by value.
- Using `coord_cartesian(ylim = c(0, 100))` and `scale_y_continuous(limits = ...)`
  interchangeably — the latter *drops* rows outside the limits before computing stats, so a
  boxplot or smooth changes shape. `coord_cartesian()` only zooms.
- Overplotting: thousands of points on top of each other. Use `alpha`, `geom_jitter()`,
  `geom_bin2d()` or `geom_hex()`.
- A colour scale with twelve categories. No palette distinguishes twelve; facet instead, or use
  `fct_lump()` to keep eight.
- `size` for line width in ggplot2 ≥ 3.4 — it is `linewidth` for lines, `size` for points.

## Production notes

Set a house theme once and stop restyling every chart:

```r
theme_set(theme_minimal(base_size = 11) + theme(legend.position = "bottom"))
```

Fonts are the classic container problem: a plot rendered in a Linux container without the font
falls back to something ugly or errors in `pdf()`. Install `systemfonts`/`ragg` and check the
output, or use `showtext`. Embed fonts in PDFs (`cairo_pdf`) if the document will be printed
elsewhere.

For scheduled reports, pin the device and the dimensions in code, not in a chunk option someone
can edit — a chart that renders at 3 inches wide is a silent regression, not an error.
