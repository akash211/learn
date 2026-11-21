# DAX Fundamentals and Interview Questions

DAX (Data Analysis Expressions) is the formula language used by Power BI semantic models and related Microsoft tabular engines. Understanding evaluation context is more valuable than memorizing a long function list. The same expression can produce different results because a visual cell, slicer, row iterator or relationship changes the rows visible to the calculation.

## Row context and filter context

Row context means “the current row.” Calculated columns have row context, and iterator functions such as `SUMX` create one while walking a table. Filter context is the set of filters active for a query: visual grouping, slicers, page and report filters, relationship propagation, and filters introduced by DAX. A measure is evaluated in filter context. Row context by itself does not automatically filter a related table or turn into a filter on the current row's table.

For example, `SUM(Sales[Net Amount])` aggregates rows visible in the current filter context. `SUMX(Sales, Sales[Quantity] * Sales[Net Unit Price])` iterates visible Sales rows, evaluates the multiplication for each row, then sums the results. Iterators are not inherently slow or wrong; they are useful when the expression must be evaluated row by row. Prefer a simple storage-engine aggregation where it expresses the same business rule.

## CALCULATE and context transition

`CALCULATE` evaluates an expression in a modified filter context. Its filter arguments can add or replace filters, and it can modify relationship behavior or remove selected filters. A typical measure is:

```DAX
Sales All Products :=
CALCULATE ( [Net Sales], REMOVEFILTERS ( Product ) )
```

This removes filters from Product while retaining other context, such as date or geography. `KEEPFILTERS` intersects a filter with the existing filter rather than replacing it in the usual column-filter case. `ALL`, `REMOVEFILTERS`, `ALLEXCEPT` and `ALLSELECTED` have distinct semantics; choosing one requires stating which filters should remain. `ALLSELECTED` often supports visual totals, but its behavior is tied to query context and should be tested in the actual visual.

Context transition is the conversion of an existing row context into equivalent filter context. `CALCULATE` performs context transition when invoked under row context. A measure reference inside an iterator is implicitly evaluated with context transition, which is why patterns can work even when no explicit `CALCULATE` is visible. A common interview prompt asks why `CALCULATE([Sales])` inside `SUMX(Customer, ...)` differs from using a raw scalar expression: the measure needs the current customer row to become a filter on the model. Explain the contexts first, then trace the rows.

## Iterators, variables and safe ratios

Use variables to name intermediate results and avoid repeating expressions:

```DAX
Margin % :=
VAR Revenue = [Net Sales]
VAR Margin = [Net Sales] - [Cost]
RETURN
    DIVIDE ( Margin, Revenue )
```

`DIVIDE` handles a zero or blank denominator safely; its optional alternate result should be chosen deliberately. `SUMX`, `AVERAGEX`, `FILTER`, `RANKX` and other iterators evaluate an expression across a table. Be alert to the table being iterated and the context transition of measures inside it. For example, filtering an entire large fact table in a measure may be less efficient than applying a selective filter to a dimension or using a storage-engine-friendly aggregation.

A running total often uses a Date dimension and `CALCULATE` to keep dates up to the current date while clearing the current date filter. The exact formula depends on calendar and visual semantics. Test subtotal, grand-total, future-date and sparse-data behavior rather than copying a pattern without checking assumptions.

## Interview questions: show reasoning

A reliable way to debug a measure is to simplify the query. Put the measure in a matrix with the dimensions that should affect it, then remove slicers one at a time. Create temporary measures for numerator, denominator and row counts. If a value changes unexpectedly, inspect the filter path and relationship state before adding more DAX. For a ratio, first establish whether the numerator and denominator share the same grain and filters. A measure can be syntactically valid while referring to different populations in its two parts.

For time intelligence, use a marked, continuous Date table and confirm that its active relationship points to the intended fact date. Functions such as `DATEADD` and `SAMEPERIODLASTYEAR` assume a meaningful date context and can produce surprising results with incomplete calendars or nonstandard fiscal periods. Fiscal year, week numbering and comparable trading days may need explicit date attributes or tailored logic. Test missing dates, partial periods and the total row. Interviewers value stating these assumptions more than reciting a memorized “year over year” formula.

**Why can a total differ from the sum of visible percentages?** A measure is reevaluated in the total's filter context. `DIVIDE([Profit], [Sales])` at the grand total calculates the overall ratio, not the arithmetic sum or necessarily the average of displayed row percentages. State which aggregate is meaningful; if an average of group ratios is required, define its weighting explicitly with an iterator.

**What does CALCULATE do?** It evaluates an expression in a modified filter context and performs context transition when row context exists. Describe how filters are added, replaced or retained in the example instead of saying it “changes context” without detail.

**When would you use SUMX instead of SUM?** Use an iterator when each visible row must first evaluate an expression, such as quantity times price. If a correctly prepared amount column exists, a simple `SUM` is usually preferable. Discuss source calculation, rounding, blanks and performance.

**Why does a measure work in a visual but not as a calculated column?** A measure is query-time and responds to filter context; a calculated column is processed row-by-row and stored. A column cannot naturally respond to a report slicer, and row context does not equal measure filter context.

### Common mistakes

When explaining a complex expression in an interview, avoid jumping directly to function names. Define the expected result, state the grain, identify filter context and then walk through the calculation. If a filter is removed, say exactly which table or column is cleared and which slicers remain. This method makes it easier to spot when an expression accidentally ignores a report selection. It also gives the interviewer a way to challenge assumptions constructively. A good answer can mention that several DAX patterns may produce the same result on one visual but differ on totals or under another filter. Prefer the simplest formula that states the requirement clearly, and use a small table example to demonstrate how each row contributes. If unsure about a subtle function's behavior, state the test you would run rather than claiming universal behavior from memory.

- Saying row context and filter context are interchangeable.
- Wrapping every expression in `CALCULATE` without knowing which filters change.
- Using `ALL` to “fix” a denominator and accidentally removing a date or security-relevant filter.
- Replacing blanks with zero everywhere, thereby hiding missing or undefined results.
- Treating a grand total as the sum of visible row outputs for every measure.

### Production notes

Use explicit measures for core business metrics and centralize them in the shared model. Give measures meaningful names, formats and descriptions. Test them in a small matrix containing dimensions, subtotals and slicers before building elaborate visuals. DAX Studio can reveal query plans and server timings; use measurements to identify formula-engine work, high-cardinality scans or repeated queries before rewriting a correct expression.
