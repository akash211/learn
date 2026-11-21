# Filters and Their Order of Operations

## Why filter order matters

A Tableau filter is not just a visual control that hides marks. Different filter types act at different stages of query and view processing, so the same predicate can produce different results depending on how it is applied. This becomes especially visible with FIXED level-of-detail expressions, percent-of-total calculations, Top N filters, and table calculations. In interviews, “What is Tableau's order of operations?” is often a test of whether a candidate can reason about a concrete discrepancy, not whether they can recite a list from memory.

Consider a FIXED expression for sales by customer. An ordinary Region dimension filter generally does not change the FIXED result because FIXED is evaluated earlier. If the requirement is “customer sales only within the selected region,” promote the Region filter to context or change the calculation/model. A context filter is evaluated before FIXED LOD calculations and establishes the subset against which the FIXED expression is computed. But context has costs and should be used only when it expresses the intended logic, not reflexively to make a view faster.

## A practical order

The commonly taught order, from earlier to later, is:

1. Extract filters.
2. Data source filters.
3. Context filters.
4. FIXED LOD expressions.
5. Dimension filters.
6. INCLUDE and EXCLUDE LOD expressions.
7. Measure filters.
8. Table calculations.
9. Table calculation filters.

This is a useful mental model, not a substitute for understanding all connector, data model, and product-specific details. Other operations such as sets, sorting, totals, and forecasting have their own relevant behavior. For exact edge cases, consult documentation for the deployed Tableau version and reproduce the case in a small workbook.

An extract filter restricts what is brought into an extract. A data source filter applies broadly to a data source, including across worksheets using that source, subject to its use and configuration. A context filter is a worksheet-level filter that defines a primary subset for dependent filters and FIXED LOD evaluation. A dimension filter typically restricts categorical values, while a measure filter restricts aggregated results. Table calculation filters remove marks after table calculations have been computed, which can preserve calculations over marks no longer displayed.

## FIXED and context filters

Suppose a workbook contains Sales by Region, and a calculation is `{ FIXED [Customer ID] : SUM([Sales]) }`. A normal Region filter is later than FIXED, so the calculation can include sales from all regions even while the sheet shows only one region. That can be correct if you want each selected region's customers ranked by their all-region sales, but wrong if you want sales within the selected region. Adding Region to context makes the selected region available before FIXED is evaluated. Then the result is computed within that subset.

Context filters can also support dependent filters by limiting the domain from which later filter values are computed. However, a context filter may add work, affect query execution, or complicate dashboard behavior. Do not convert every filter to context. Identify which calculation depends on which subset and make only those filters context. Verify with a simple worksheet showing the raw measure, FIXED measure, and relevant dimensions before applying the logic across a complex dashboard.

Data source filters and extract filters can be useful for broad scoping, but they are not a safe replacement for authorization. A user who can access a workbook or data source in another way may not be constrained as expected by a presentation filter. Security should use a supported security design and least-privilege access, not merely hide values in a chart.

## Top N and dimension filters

A common requirement is “show the top 10 products within the selected category.” The product Top N filter and category filter must interact in the intended order. If the Top N is evaluated before the category selection, Tableau may select the top ten across all categories and then show only the members in the selected category, potentially leaving fewer than ten. Making Category a context filter can cause the Top N computation to use the selected category subset. An alternative is a carefully designed calculation or parameter-driven filter, but verify its behavior with ties and changing selection.

A Top N filter is often based on an aggregate such as SUM(Sales), and ties can result in more members than N depending on the configuration and data. If the business requires exactly N, define a tie-break rule such as a stable secondary sort. Ranking via a table calculation has different order-of-operations semantics from a dimension Top N filter. Ask whether the intended ranking is global, per pane, or per partition.

Dimension filters usually restrict members before aggregate results are presented, while measure filters remove marks based on aggregate values. For example, filtering out products with SUM(Sales) below a threshold is a measure filter. That can change the visible set of categories and can interact with table calculations such as percent of total, depending on the later stages involved.

## Table calculations and filters

A table calculation sees the marks available at its stage. A table calculation filter is applied later, hiding selected marks after calculations. This allows a view to display only the most recent months while a running calculation can still be computed across earlier months. A conventional date dimension filter usually removes earlier months before the table calculation, changing the running total or moving average. This distinction is valuable for “show last 12 months but calculate year-to-date from January” style questions.

There are multiple ways to implement display-only filtering, including table calculation filters and carefully structured date logic. The right method depends on whether hidden marks should contribute to the calculation, how the view partitions, and whether other sheets use the same filter. Make the behavior explicit and test boundary periods. A view that looks correct for the latest date may fail at year transitions or when data is missing.

## Debugging a filter problem

When a result is surprising, write down the requirement in data terms: which rows should be eligible, at what grain should the metric be computed, and which records should be visible? Then identify the calculation type and filter type. Create a small table with the key dimensions, base measure, LOD, and filter result. Test removing filters one at a time. For a table calc, inspect compute using, partitioning, and sort. For a Top N result, check whether the N is computed before or after the desired subset.

Validate the answer against a SQL query or known control total when possible. Be careful with the source's grain, null handling, and many-to-many joins: filter order is not the only source of mismatch. Naming a filter “context” does not prove the logic is correct; the data subset and business rule must be checked.

## Common mistakes

- Assuming every dimension filter affects a FIXED expression.
- Promoting every filter to context without explaining the required calculation stage.
- Confusing a dimension Top N filter with a rank table calculation.
- Using an ordinary date filter when hidden earlier marks must contribute to a table calculation.
- Treating filters as a security boundary.
- Memorizing a sequence without verifying a particular workbook's model and behavior.

## Production notes

Write acceptance examples for important filters: a selected category, a tied Top N boundary, a year start, and a user with restricted data. Keep filter scopes clear across dashboard actions and worksheets. Review query performance after context changes, but do not claim a generic speed gain. Correctness comes first: state what subset each calculation should see, choose the filter stage to match it, then test the result.
