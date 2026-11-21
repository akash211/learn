# Calculations: LOD Expressions and Table Calcs

## Three places for analytical logic

Tableau calculations can execute at different stages and against different notions of detail. A row-level calculation is evaluated for source records or translated into source query logic. An aggregate calculation combines values at the level of the view. A level-of-detail (LOD) expression specifies a data grain that can differ from the view's visible dimensions. A table calculation operates on the marks already returned to the view and addresses them by partition and direction. These are not interchangeable syntaxes for the same job.

For a basic row-level calculation, `[Profit] / [Sales]` is computed from fields at record level, subject to data types and nulls. A view-level ratio should often be `SUM([Profit]) / SUM([Sales])`, which calculates the ratio of totals at the current view grain. The average of row-level margins is a different statistic. Tableau requires consistency between aggregate and nonaggregate expressions; mixing them without an explicit aggregation usually produces an error because the intended grain is ambiguous.

## FIXED, INCLUDE, and EXCLUDE

LOD expressions make the target dimensions explicit. `FIXED` computes at the dimensions named in the expression, independently of dimensions in the view. For example:

```tableau
{ FIXED [Customer ID] : SUM([Sales]) }
```

This yields a customer-level sales value that can be displayed in a view by Region, Customer Segment, or another dimension. `FIXED` does not mean globally fixed for all time: it still responds to data-source and extract filters, and to context filters, while ordinary dimension filters are later in the order of operations. This filter distinction is a classic source of surprises.

`INCLUDE` adds dimensions to the view's level of detail for the calculation, then allows the result to be aggregated back to the visible view. For instance, `{ INCLUDE [Order ID] : SUM([Sales]) }` computes at order detail before the outer aggregation. It can be useful when the view is by Region but the calculation needs an intermediate order grain. Since including a dimension can change mark-level results, validate with a small crosstab.

`EXCLUDE` removes one or more dimensions from the view's level of detail for the calculation. A percent-of-total calculation might compare a displayed subcategory value to its category-level total using an EXCLUDE expression. Unlike a table calculation, the LOD result is computed through the data query stage and can be used in other expressions with relevant aggregation rules. The exact behavior depends on filters and the relationships or joins in the data model.

A useful decision sequence: if the calculation is a property of each record, use a row-level expression; if it should aggregate exactly to visible marks, use an aggregate expression; if it needs a specified dimensional grain, choose LOD; if it depends on neighboring marks, ranking, running totals, or the displayed partition, use a table calculation.

## Table calculations

A table calculation runs over the result set in the visualization. Common examples include `RUNNING_SUM`, `LOOKUP`, `WINDOW_SUM`, percent of total, and rank. Its inputs are marks, not arbitrary raw rows. The marks are divided into partitions and addressed along a computation direction. In the Edit Table Calculation controls, compute using and specific dimensions determine how the calculation traverses the view. A running sum by month partitioned by Region is different from a running sum across all regions and months.

`LOOKUP(SUM([Sales]), -1)` references a preceding mark in the addressing order. If sorting or date headers change, the meaning of “previous” can change. A table calculation returning null at the first position may be correct because there is no prior mark. Running totals, moving averages, and ranks similarly depend on partitioning, sort, and visible marks. Hide a mark versus filter it out can produce different results because the data available to the table calculation can differ.

Table calculations are useful for computations over the displayed result, but they are not a general substitute for a warehouse window function. They can be difficult to reuse outside the view and may not be appropriate for row-level security or data preparation. Prefer stable upstream logic for reusable, audited metrics when a database model can express it clearly.

## Aggregation and null handling

A calculation's aggregation level should be explicit in its name or documentation. A customer lifetime sales field defined with FIXED can be repeated on every row for that customer; summing those repeated values over a view can multiply the total. Use an aggregation appropriate to its repeated nature, such as MIN or AVG at the intended grain, or restructure the view. In general, test a calculation in a text table containing the dimensions that define its grain before placing it in a polished chart.

Nulls require deliberate treatment. `IFNULL`, `ZN`, and conditional logic can replace null values, but replacement is a business decision. Zero sales and unknown sales are not necessarily equivalent. Division by zero, null dates, and missing categories should have a defined display behavior. A formula that suppresses nulls can also hide data-quality problems.

## Calculation examples

```tableau
// Aggregate margin at the current view grain
SUM([Profit]) / SUM([Sales])

// Customer sales regardless of the view's customer grouping
{ FIXED [Customer ID] : SUM([Sales]) }

// Order-level amount evaluated with order detail included
{ INCLUDE [Order ID] : SUM([Sales]) }

// Prior mark in the chosen table-calculation direction
LOOKUP(SUM([Sales]), -1)
```

The comments describe intent, but the view and filters determine behavior. If an LOD is used with multiple logical tables or relationships, verify how Tableau generates the query and what grain is preserved. Never assume a formula's braces alone make it immune to join duplication.

## Common mistakes

- Using FIXED when the desired calculation should respond to ordinary dimension filters.
- Treating INCLUDE or EXCLUDE as table calculations; LOD expressions operate at a data grain, table calcs on marks.
- Forgetting a table calculation's partitioning and addressing, then accepting a plausible but wrong rank.
- Summing a repeated FIXED value across detail rows and multiplying the result.
- Averaging row ratios when the required metric is a ratio of aggregated totals.
- Ignoring nulls, data types, or zero denominators.

## A practical calculation review

When reviewing an unfamiliar workbook, trace one important value from source row to mark. Record the source grain, the visible dimensions, the aggregation, and each filter that can affect the expression. For an LOD, compare its output before and after adding a view dimension; for a table calculation, change the partition or sort deliberately and observe which marks change. This small experiment reveals hidden assumptions more reliably than reading a formula in isolation. Keep a known test case with a few rows, including a null and a repeated key, so future edits can be checked against expected results.

## Production notes

Name calculated fields for their grain and business meaning, such as `Customer Sales (Fixed)` or `Margin % (View)`.  Keep definitions in governed data sources when they are shared. Test each expression with a diagnostic crosstab that includes the source grain, view grain, and relevant filters. Inspect query behavior and reconcile results against a SQL calculation for critical metrics. That discipline turns calculation syntax into trustworthy analytical logic.
