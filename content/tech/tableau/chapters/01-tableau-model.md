# Tableau's Data and Visual Model

## Start with the question and the grain

A Tableau view is a query-shaped visual result, not merely a drawing over a spreadsheet. Before placing fields, establish what one row in the underlying data represents. A sales table might have one row per order line, while a returns table has one row per returned line and a customer table one row per customer. Joining tables at incompatible grains can duplicate values. If each customer has several orders and several support tickets, joining both child tables on customer can multiply order and ticket rows. The resulting SUM of sales may look plausible but be wrong. Use the data model's relationships where appropriate, validate row counts and totals, and be explicit about the intended level of detail.

A worksheet combines fields, shelves, and the Marks card to describe a view. Rows and Columns define axes or headers; Marks determines the visual mark type and encodings. A field on Color, Size, Label, Detail, or Tooltip changes how marks are drawn. The number of marks depends on dimensions in the view and the data's grain; adding a dimension to Detail can split one mark into many even when no label is shown.

## Dimensions and measures

Dimensions are fields used to segment, identify, or describe data: Region, Product, Order Date, and Customer. Measures are fields that are usually aggregated: Sales, Profit, and Quantity. The distinction is a default role, not an eternal statement about the meaning of a column. A numeric customer ID may be a dimension because summing IDs is meaningless. A date can be a dimension when used to group by month, or a continuous axis when plotting a timeline. You can change a field's role and aggregation to fit the question.

Tableau typically aggregates measures in a view. If SUM(Sales) is displayed by Region, Tableau computes a regional aggregate rather than showing every input row. A measure displayed without a dimension may yield a single mark for the whole filtered dataset. Adding dimensions subdivides that aggregation. This is why a table of daily sales can show a different level of detail from a single KPI, while the underlying data remains the same.

Default aggregation matters. SUM is appropriate for additive amounts, but not for every number. A balance is often semi-additive: it can be summed across accounts at a point in time, but not across dates. Ratios should generally be recomputed from their component totals, such as SUM(Profit) / SUM(Sales), rather than averaged row by row. Choose AVG, MIN, MAX, COUNT, COUNTD, or a custom expression based on the metric definition. Format is not semantics; displaying a sum as currency does not make it a valid financial measure.

## Discrete and continuous: blue versus green

Discrete fields create headers and partitions; continuous fields create an axis. Tableau signals discrete pills in blue and continuous pills in green. This color convention applies to pills, not to dimension-versus-measure status. A date dimension can be blue when used as discrete YEAR(Order Date), producing year headers, and green when continuous as a date axis. A numeric dimension can be discrete, and a measure can be converted to a discrete role for headers. Do not infer a field's role solely from its color.

Discrete date parts such as YEAR or MONTH name buckets. A continuous date value, or a continuous date truncation, places values along a scale. Continuous month can span years in chronological order; discrete month names can group January together across years. The right choice depends on whether the analytical task requires ordered positions or named categories. For a line chart showing monthly trend across multiple years, a continuous date axis is usually a natural choice; for a heat map by month name and weekday, discrete headers can be clearer.

Green pills often create axes with a range and tick marks, while blue pills create headers. Multiple discrete dimensions can form nested headers. These are defaults, not laws: chart type, formatting, sorting, and table layout can be adjusted. A continuous axis may start at zero or use a narrowed range; use care because axis choices change visual interpretation.

## Marks, aggregation, and table layout

The Marks card maps data to visual properties. Position is generally strongest for accurate comparison, followed by length and area; color is useful for grouping but makes precise comparisons harder. A bar chart by Region uses position and length. Adding Segment to Color can encode categories, but too many colors reduce legibility. Labels should support the task rather than repeat every visible value.

When Tableau displays a crosstab, row and column headers still define a query grain. Measure Names and Measure Values can show multiple measures in a common view. Totals and subtotals are computed by Tableau's aggregation behavior, which may not equal summing displayed rounded cells. When users report a discrepancy, compare source rows, aggregation, filters, and total computation rather than assuming it is a rendering defect.

A dual-axis chart combines two measures with separate axes; synchronizing axes is meaningful only when units and scales justify it. A dual axis with unrelated units can mislead even when colors make it look polished. Separate panes or indexed measures can be more honest. Use an explicit date hierarchy drill only if the levels answer a useful sequence of questions.

## The data model and relationships

In modern Tableau data sources, logical tables can be connected with relationships. The logical layer preserves each table's level of detail and allows Tableau to generate queries based on fields used in a view. Physical joins combine rows within a logical table; unions stack similarly structured rows. Relationships are not a magical guarantee against duplication: keys, cardinality, referential integrity, and the actual view still matter. Inspect generated results with representative fields and reconcile critical totals to a trusted query.

Use a relationship when tables have different grains and users need flexible analysis across them. Use a physical join when row-level combination is required and the join semantics are understood. Union partitions such as monthly files with the same schema. Data blending is a separate, legacy-style way of combining aggregated results from separate sources; it has different behavior and limitations from a relationship or join.

## Common mistakes

- Treating every numeric column as a measure and summing identifiers.
- Treating blue as synonymous with dimension or green as synonymous with measure.
- Averaging a ratio or summing a snapshot without checking its definition.
- Adding detail fields without realizing they split marks and alter the visible grain.
- Joining multiple one-to-many tables and trusting inflated aggregates.
- Choosing continuous or discrete dates by habit rather than by the task.

## Production notes

Document metric definitions and source grain in a published data source or companion documentation. Validate totals at key cuts, and keep a small set of reconciliation queries for important dashboards. Make chart encodings, aggregation, filters, and date treatment visible enough that another analyst can explain the view. Tableau's visual workflow is most reliable when the data model is sound and the grain is made explicit.
