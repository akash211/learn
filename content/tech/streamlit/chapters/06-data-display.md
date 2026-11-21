# Data Display and Charts

Streamlit provides display elements for text, metrics, dataframes, tables, and common chart types. It also integrates with visualization libraries such as Plotly and Altair. Choose a rendering method based on how the user needs to inspect the data: scan a summary, explore a large result, read exact values, or interact with a visual encoding. Rendering a Python object does not remove the need to control data size, units, labels, and privacy.

## Dataframes versus static tables

`st.dataframe` renders an interactive dataframe, useful for sorting, resizing columns, inspecting records, and selecting rows where supported by the data and version. `st.table` renders a static table for compact, fixed results. For large or wide data, defaulting to a full interactive table can lead to slow serialization, browser rendering costs, and a confusing interface.

```python
st.dataframe(
    report,
    column_config={
        "revenue": st.column_config.NumberColumn("Revenue", format="$%.2f"),
        "margin": st.column_config.ProgressColumn("Margin", min_value=0, max_value=1),
    },
    hide_index=True,
    width="stretch",
)
```

Set meaningful display names and formats, but preserve the distinction between display and source values. A currency format should not imply a different unit or precision than the business definition. Hide indexes when they are meaningless; show stable IDs when they support drill-down or review. Use column configuration to explain links, dates, numbers, and other types where appropriate.

For huge result sets, query or aggregate only the rows needed. Pagination and server-side filtering are usually more effective than transferring an entire table and hoping the frontend handles it. If selection is enabled, use stable identifiers to map selected rows back to records; row positions can shift after sorting or filtering.

## Metrics and summaries

`st.metric` highlights a number, optional delta, and label. A metric without context is easy to misread. State whether change is absolute or relative, define the comparison period, and avoid implying causality from a simple delta. Use `st.caption` for provenance such as “Updated at” or “Compared with previous week.” Prefer a clear table or chart for distributions; one number cannot summarize uncertainty or outliers.

For a compact summary, calculate values in ordinary Python or a dataframe library, then render them. Keep the calculation separate from formatting so it can be tested. Avoid recalculating the entire source query separately for each metric; load once, derive several summaries, and cache appropriately.

## Built-in charts

Built-in charts such as `st.line_chart`, `st.bar_chart`, `st.area_chart`, and `st.scatter_chart` are convenient for common patterns. They are fast to add and work well for exploration, but defaults are not a substitute for clear labels and correct semantics. Check whether a line chart's x axis is treated as time or categorical, whether aggregation is appropriate, and whether sorting is explicit. A bar chart for categories should not silently reorder values if a meaningful order matters.

If the chart encodes a metric, explain the unit and time window. If multiple series have different scales, avoid one axis that makes a series unreadable. Dense data can make a chart look precise while obscuring noise; aggregate or sample with a documented method where appropriate.

## Altair and Plotly

Altair expresses charts declaratively using a data source, encodings, marks, and transforms. It is suitable for concise statistical and interactive graphics, and works naturally with dataframe-shaped data. Plotly provides interactive charts with hover, zoom, and richer chart types. Pass figure objects to `st.altair_chart` or `st.plotly_chart` and configure selection or event behavior according to the current Streamlit API version.

Keep visualization dependencies pinned and test browser behavior after upgrades; chart integration has version-specific features. Large client-side chart payloads can be expensive even if Python renders quickly. Reduce rows and columns, aggregate, or use a server-side approach before shipping enormous point clouds to the browser. Interactive selection is useful, but do not make it the only way to communicate a critical result—provide a table, text summary, or accessible explanation as appropriate.

## Formatting and correctness

Dates need timezone and granularity context. Monetary amounts need currency. Percentages need a denominator and definition. Missing values should be represented honestly, not converted to zero unless zero is semantically correct. Use consistent categories and sort order across chart and table views so the reader can compare them. Display filters and the effective query parameters near the result, particularly when screenshots or downloads may be shared.

Avoid leaking raw fields that should not be shown. A dataframe's hidden columns, index, or debug representation can reveal personal data or internal IDs. Build a display projection with only approved columns instead of passing a broad source dataframe to the frontend. Apply row-level authorization before rendering; hiding a column or a tab is not security.

## Selection and user interaction

The interactive dataframe and chart APIs can return selections in supported versions, but behavior and configuration evolve. Read the API reference for the exact installed version, and test click, selection, and rerun behavior in the actual app. Treat returned IDs as user input: validate that they exist and that the user is authorized to access them. A selected row does not prove permission to update it.

## Common mistakes

- Rendering millions of rows client-side when aggregation or pagination belongs at the query layer.
- Using `st.table` for an exploratory dataset that users need to sort or inspect.
- Assuming a chart's defaults communicate units, time zone, sorting, or aggregation correctly.
- Passing an unfiltered source dataframe with sensitive columns to the browser.
- Using an unstable row index as a record identity after interactive sorting.
- Treating successful Python-side rendering as proof that browser payload size is acceptable.

## Production notes

Test with realistic data volume and browser widths, not a ten-row sample. Keep a clear distinction between display formatting and source values. Measure serialization and client rendering as well as query time; a fast dataframe computation can still produce an unusable UI. Make every chart answer a question, show enough context to interpret it, and provide a nonvisual way to inspect consequential values.

## Choosing a display for a task

A user scanning “what changed?” benefits from a metric with a defined comparison and a short trend chart; a user investigating an exception needs searchable records and stable identifiers. Do not force both jobs into one giant chart. State the active filters near the result and make the empty state informative: distinguish “no records match” from “the source could not be reached.” An empty table without context can look like a successful report when it is actually an upstream failure.

For categorical comparisons, use a bar chart with readable labels and a deliberate sort order. For time series, make timezone, interval, and aggregation explicit. If a chart has multiple lines, label each series and avoid color-only distinctions. Keep a downloadable table aligned with the displayed filters so that users do not receive a broader dataset than they see on screen. Finally, check the result at realistic viewport sizes and browser zoom; long labels, null values, and large numeric ranges often expose problems that a small synthetic sample conceals.