# Time Series and Financial Packages

R's time-series support is older than the tidyverse and split across three ecosystems: `ts` with
`forecast`, `xts`/`zoo` for irregular and financial data, and the tidyverts (`tsibble`, `fable`,
`feasts`) as the modern reimplementation. They coexist, and picking the wrong one is the first
mistake to avoid.

## `ts`: regular frequency, integer time

```r
y <- ts(sales$revenue, start = c(2019, 1), frequency = 12)
frequency(y)   # 12: monthly
cycle(y)       # 1..12 for each observation
window(y, start = c(2022, 1), end = c(2023, 12))
```

`ts` stores values plus a `tsp` attribute (start, end, frequency) and indexes time as
`1 + (t - 1)/frequency`. That representation is compact and fast, and it has two limits: time is
implicit (there is no date column to join on), and it assumes a **fixed** interval — monthly,
quarterly, weekly, or 252 trading days. Missing months must be inserted as `NA`; they cannot be
skipped.

`decompose()` uses a centred moving average and handles additive or multiplicative seasonality.
`stl()` uses loess and is the better tool for real data:

```r
fit <- stl(y, s.window = "periodic", robust = TRUE)
plot(fit)
seasonal(fit); trend(fit); remainder(fit)
```

`robust = TRUE` downweights outliers in the seasonal component, which matters because one
Black-Friday spike otherwise distorts every seasonal estimate.

Time-series objects have their own `lag()` that shifts *time*, not values:

```r
lag(y, 1)          # stats::lag — the previous period, aligned on the time axis
dplyr::lag(y)      # shifts values, keeping the time axis — different result
```

Loading dplyr after `forecast` masks `stats::lag` and breaks ts code with a confusing error. This
is the single most common time-series bug in a tidyverse-heavy script; call `stats::lag()` explicitly.

## Forecasting with `forecast`

```r
library(forecast)

y <- ts(df$revenue, start = c(2019, 1), frequency = 12)

baseline <- snaive(y, h = 12)                       # seasonal naive: last year, repeated
ets_fit  <- ets(y)                                  # exponential smoothing, chosen by AICc
arima_fit <- auto.arima(y, seasonal = TRUE, stepwise = FALSE, approximation = FALSE)

accuracy(baseline, y)
accuracy(arima_fit)
checkresiduals(arima_fit)     # ACF of residuals + Ljung-Box
forecast(arima_fit, h = 12) |> autoplot()
```

Read this in order of effort:

1. **Always fit a naive baseline.** `naive()` (last value) or `snaive()` (same period last year).
   If your model cannot beat seasonal naive on held-out data, it is not a model, it is decoration.
2. `ets()` chooses among exponential smoothing variants by AICc and is remarkably hard to beat on
   business series with trend and seasonality.
3. `auto.arima()` searches ARIMA orders. `stepwise = FALSE, approximation = FALSE` gives a genuine
   search rather than a heuristic one — slower, and worth it for a monthly series with 100 points.
4. `checkresiduals()` is the diagnostic: if the residual ACF has spikes or the Ljung-Box p-value is
   small, the model has left structure on the table.

Stationarity underlies ARIMA. `ndiffs()` and `nsdiffs()` suggest differencing orders;
`tseries::adf.test()` and `tseries::kpss.test()` test for unit roots — and they have opposite null
hypotheses, which is why a series can "pass" one and fail the other.

Reading ACF and PACF for a manual ARIMA order is still interview material: ACF decaying slowly
suggests differencing; a sharp cut-off in ACF with a tail-off in PACF suggests MA; the reverse
suggests AR. On real data, trust `auto.arima()` and the residual diagnostics more than the textbook
patterns.

## Backtesting without fooling yourself

A random train/test split on time series leaks the future into the past. Use rolling origin
evaluation:

```r
far <- function(y, h) forecast(auto.arima(y), h = h)
e <- tsCV(y, far, h = 1)         # one-step-ahead errors, expanding window
sqrt(mean(e^2, na.rm = TRUE))    # RMSE

# or an explicit holdout
train <- window(y, end = c(2023, 12))
test  <- window(y, start = c(2024, 1))
accuracy(forecast(auto.arima(train), h = length(test)), test)
```

Two rules. The forecast horizon must match how the forecast is used — a 12-month-ahead model
validated one step ahead looks far better than it is. And any feature (a holiday flag, a promotion
calendar, a competitor price) must be known at forecast time; a `xreg` containing the actual
temperature next month is leakage.

## The tidyverts alternative

`tsibble` + `fable` + `feasts` reimplement the same models with tidy data and multiple series per
table:

```r
library(tsibble); library(fable); library(feasts)

fit <- as_tsibble(df, key = region, index = month) |>
  model(ets = ETS(revenue),
        arima = ARIMA(revenue),
        snaive = SNAIVE(revenue))

fit |> forecast(h = 12) |> autoplot()
fit |> accuracy() |> arrange(region, RMSE)
```

The payoff is many series in one object: hierarchical reconciliation (`fable` has
`reconcile()`), consistent accuracy tables, and no per-series loop. If your problem is "forecast
400 SKUs", this is the right tool. If it is "forecast one series and explain the model", `forecast`
is more direct.

`prophet` (Meta's decomposable model) is available via the `prophet` package and handles multiple
seasonalities plus holidays with little configuration. It is a reasonable choice for daily data
with weekly/yearly patterns and a holiday calendar; it is not magic, and its uncertainty intervals
are wider than they look.

## Financial data: `xts`, `quantmod`, `TTR`

Financial series are irregular (holidays, half-days), timestamped to the second, and priced on
several exchanges. `ts` is the wrong container; `xts` (built on `zoo`) is the standard.

```r
library(quantmod)
getSymbols("AAPL", from = "2020-01-01")     # assigns AAPL in the global environment
head(AAPL)
Ad(AAPL)                                     # adjusted close: splits and dividends applied
Cl(AAPL)                                     # raw close

library(TTR)
sma  <- SMA(Cl(AAPL), n = 20)
rsi  <- RSI(Cl(AAPL), n = 14)
macd <- MACD(Cl(AAPL))
```

`Ad()` versus `Cl()` is not cosmetic: unadjusted prices jump on split dates, producing a fake 4:1
return. Use adjusted prices for returns, raw prices only for things like limit orders.

```r
ret <- dailyReturn(Ad(AAPL))                 # or periodReturn(..., period = "monthly")
library(PerformanceAnalytics)
table.AnnualizedReturns(ret)
SharpeRatio.annualized(ret)
maxDrawdown(ret)
chart.CumReturns(ret)
```

`xts` subsetting is by time string, which is its best feature:

```r
aapl["2024"]              # all of 2024
aapl["2024-03"]           # March
aapl["2024-03-01/2024-03-15"]
apply.daily(aapl, sum)    # or period.apply / to.period
```

For volatility modelling, `rugarch` fits GARCH family models:

```r
spec <- ugarchspec(
  variance.model = list(model = "sGARCH", garchOrder = c(1, 1)),
  mean.model = list(armaOrder = c(1, 0), include.mean = TRUE),
  distribution.model = "std"
)
fit <- ugarchfit(spec, ret)
```

For portfolio construction, `PortfolioAnalytics` and `fPortfolio` do constrained mean-variance and
risk-parity optimisation; `tidyquant` wraps `quantmod` and `TTR` in tidy verbs (`tq_get`,
`tq_mutate`) for people who want the tidyverse interface. Backtesting frameworks exist
(`quantstrat`, `backtest`) but are dated compared with Python's ecosystem — this is one place where
R is genuinely weaker.

## Common mistakes

- `dplyr::lag()` in ts code, or `stats::lag()` on a data frame expecting value shifts.
- Monthly data with `frequency = 12` but a date column that skips months — the series silently
  shifts by a month after the gap. `tsibble` catches this; `ts` does not.
- Daily financial data with `frequency = 365` to "make it annual-comparable". Use 252 for trading
  days, or better, use `xts` and stop pretending.
- Random train/test split on time series.
- Using `Cl()` instead of `Ad()` for returns.
- Reporting an ARIMA forecast without a naive baseline, so nobody can tell whether it adds value.
- `auto.arima()` on 18 observations and believing the order it picked.
- Ignoring time zones in intraday data. `xts` indexes carry a timezone; two feeds in different
  zones align to different bars.

## Production notes

Seasonality is the part that breaks in production: a model trained through December and scored in
January can be excellent in backtest and useless in January, because the seasonal pattern is
estimated from one or two cycles. Require at least two full seasonal cycles before trusting a
seasonal model, and say so in the report.

Store the forecast alongside its interval and the training window end date. A forecast without the
date it was made is unfalsifiable, and a schedule that silently re-fits on a different window will
produce revisions nobody can explain.
