# Statistics Essentials in R

R was built as a statistics language, and its core modelling interface has not changed in thirty
years because it got the important thing right: the formula. `lm(y ~ x, data = df)` is still the
shortest path from a question to an answer in any language, and the same formula language runs
through `glm`, `lme4`, `survival`, `fixest`, `forecast` and hundreds of CRAN packages.

This chapter covers the inference you will actually be asked to do: comparing groups, fitting and
reading a regression, checking it, and reporting it without overclaiming.

## Formula language

A formula has a left side (response), a `~`, and a right side (predictors). The operators do not
mean arithmetic:

| Syntax | Meaning |
|---|---|
| `y ~ x` | intercept + slope for `x` |
| `y ~ x + z` | both predictors, **not** "x plus z" as a sum |
| `y ~ x:z` | interaction only |
| `y ~ x * z` | `x + z + x:z` — main effects and interaction |
| `y ~ x + I(x^2)` | `I()` protects arithmetic from the formula parser |
| `y ~ poly(x, 2)` | orthogonal polynomial, better conditioned than raw powers |
| `y ~ .` | every other column |
| `y ~ . - id` | all but `id` |
| `y ~ 0 + x` / `y ~ x - 1` | suppress the intercept |
| `y ~ factor(q)` | treat a numeric column as categorical, inline |
| `offset(log(exposure))` | fixed coefficient of 1, for rate models |

`I()` is the one people forget: `y ~ x^2` means "the interaction of x with itself", which is just
`x` — it does not square anything.

## Comparing groups

```r
t.test(revenue ~ variant, data = ab)              # Welch, var.equal = FALSE by default
t.test(revenue ~ variant, data = ab, var.equal = TRUE)   # Student, only if variances match
t.test(ab$after, ab$before, paired = TRUE)        # paired
wilcox.test(revenue ~ variant, data = ab)         # non-parametric, medians
chisq.test(table(ab$variant, ab$converted))       # association between two factors
prop.test(c(120, 95), c(1000, 980))               # two proportions with CI
cor.test(df$x, df$y, method = "spearman")         # rank correlation
```

Welch's t-test is the default in R and the right default: it does not assume equal variances and
loses almost nothing when they are equal. `var.equal = TRUE` is a historical artefact of hand
computation.

The output is a list, not a printed paragraph:

```r
test <- t.test(revenue ~ variant, data = ab)
test$estimate      # group means
test$conf.int      # CI for the difference
test$p.value
broom::tidy(test)  # one-row tibble: estimate1, estimate2, statistic, p.value, conf.low, conf.high
```

`broom::tidy()` is how you get test results into a table instead of reading them off the console —
essential when you run forty tests and need to adjust or sort them.

## Reading a regression

```r
fit <- lm(log(revenue) ~ channel + promo + month, data = orders)
summary(fit)
```

`summary()` gives five things worth reading in order:

1. **Coefficients** — estimate, standard error, t statistic, p-value. For a numeric predictor, the
   estimate is the change in the response per one-unit change, *holding the others fixed*. With a
   log response, it is approximately a proportional change: a coefficient of 0.08 is about +8%.
2. **Residual standard error** — the typical size of a residual, in response units. More useful
   than R² for judging whether the model is precise enough for the decision.
3. **R² and adjusted R²** — proportion of variance explained, in-sample. Adjusted R² penalises
   parameters; neither says anything about out-of-sample accuracy.
4. **F statistic** — a joint test that all coefficients are zero. It is almost always significant
   with a decent sample and tells you nothing you care about.
5. **Degrees of freedom** — rows minus parameters. A model with 40 parameters on 50 rows is a
   curve-fitting exercise, not an analysis.

Categorical predictors are encoded by **treatment contrasts**: the first level (alphabetically, or
the first factor level) is the reference, and each coefficient is the difference from it.

```r
levels(orders$channel)                     # "email" "paid" "search"
orders$channel <- relevel(orders$channel, ref = "paid")
contrasts(orders$channel)                  # shows the dummy coding
```

This is why "the coefficient for search is significant" is a statement about search *versus the
reference level*, not about search in isolation. Change the reference and the coefficients change
while the model does not. `emmeans::emmeans(fit, ~ channel)` gives level means with confidence
intervals, which is usually what a stakeholder actually wants.

Interactions are where interpretation gets hard:

```r
fit2 <- lm(revenue ~ promo * channel, data = orders)
```

The `promo` coefficient is now the effect of promo **at the reference channel**, and vice versa.
Reporting a main effect from a model with an interaction, without saying "at the reference level",
is a standard interview trap. Plot the interaction (`emmeans::emmip()` or a `geom_line` of
predicted values) before you describe it.

## Prediction, and the interval people confuse

```r
new <- tibble(channel = "paid", promo = TRUE, month = as.Date("2024-07-01"))
predict(fit, newdata = new, interval = "confidence")   # CI for the mean
predict(fit, newdata = new, interval = "prediction")   # CI for one new observation
```

The confidence interval is narrow and about the fitted line; the prediction interval is wide and
about a single future point. Reporting the former as "the range next month's revenue will fall in"
understates uncertainty by a lot. For anything a business will act on, use `"prediction"`.

`predict()` also silently recycles factor levels and errors on unseen ones, which is an operational
issue rather than a statistical one.

## Diagnostics

```r
plot(fit)          # residuals vs fitted, QQ, scale-location, residuals vs leverage
```

- **Residuals vs fitted**: curvature means the functional form is wrong (add a term, transform, or
  use a spline); a funnel means heteroscedasticity (log-transform the response, or use robust SEs).
- **QQ plot**: heavy tails or a few extreme points. Mild deviation is normal; a hockey stick is
  not.
- **Scale-location**: the same funnel check, on standardised residuals.
- **Residuals vs leverage**: points with high leverage and high residual drive the fit.
  `influence.measures(fit)` and `cooks.distance(fit)` quantify it.

```r
car::vif(fit)                    # multicollinearity: > 5 worth looking at, > 10 is a problem
lmtest::bptest(fit)              # Breusch-Pagan for heteroscedasticity
lmtest::coeftest(fit, vcov = sandwich::vcovHC(fit, type = "HC3"))   # robust SEs
```

Clustered standard errors are the right default for panel or grouped data, because observations
within a customer, store or region are not independent:

```r
fixest::feols(revenue ~ promo | customer_id + month, data = orders, cluster = ~ customer_id)
```

`feols()` absorbs the fixed effects instead of estimating a dummy per level, which is the
difference between a model that runs and one that exhausts memory on a million customers.

## Beyond linear: `glm` and mixed models

```r
churn <- glm(churned ~ tenure + plan, family = binomial, data = customers)
exp(coef(churn))                       # odds ratios
exp(confint(churn))                    # CI for the odds ratios

claims <- glm(n_claims ~ age + offset(log(exposure)), family = poisson, data = policy)
```

For a logit model, `exp(coef())` is an odds ratio and the coefficient itself is a log-odds change.
Neither is a percentage-point effect on probability, which depends on where you start — use
`marginaleffects::avg_slopes()` or `emmeans` for that.

Random effects, for repeated measures:

```r
lme4::lmer(score ~ time + (1 | student), data = panel)          # random intercept
lme4::lmer(score ~ time + (time | student), data = panel)       # random slope
```

## Many models at once

The tidy equivalent of "fit one model per group" is `nest()` + `map()` + `broom`:

```r
library(dplyr); library(tidyr); library(purrr); library(broom)

by_region <- orders |>
  nest(data = -region) |>
  mutate(model = map(data, ~ lm(revenue ~ promo + month, data = .x)),
         stats = map(model, glance)) |>
  unnest(stats) |>
  select(region, r.squared, sigma, p.value)
```

`glance()` gives one row per model, `tidy()` one row per coefficient, `augment()` the data with
fitted values and residuals. This is how you produce a coefficient table for twenty segments
without copy-paste, and it is a strong interview answer.

## Multiple comparisons

Running twenty t-tests and reporting the ones with p < 0.05 guarantees false positives:

```r
p.adjust(p_values, method = "BH")   # Benjamini-Hochberg, controls false discovery rate
p.adjust(p_values, method = "bonferroni")   # stricter, controls family-wise error
```

Pre-register the analysis, or adjust. Testing everything and reporting the survivors is what
produces retracted findings.

## Common mistakes

- Interpreting a coefficient as a causal effect from observational data.
- Reporting a main effect from a model containing an interaction, without the reference level.
- Reading R² as predictive accuracy, or comparing R² across models with different responses
  (raw versus log).
- Using `interval = "confidence"` where a prediction interval is needed.
- Ignoring the reference level and concluding "channel has no effect".
- Assuming `p < 0.05` means a large effect; with 100,000 rows, everything is significant.
- Fitting a model with more parameters than observations and trusting `summary()`.
- Treating `NA` rows as zero rather than letting `lm()` drop them — and then comparing models fit
  on different subsets. Use `na.action = na.exclude` and check `nobs(fit)`.

## Production notes

Store the model, not the printed summary. An `.rds` of the fitted object plus the `sessionInfo()`
of the run is reproducible; a screenshot of coefficients is not. Save the factor levels with the
model, because `predict()` on new data with a new level fails or returns `NA`, and pin the package
versions (chapter 10) — a model fitted under one version and scored under another shifts at the
margins.
