# Dashboard Design and Performance

## Design around a decision

A dashboard should answer a bounded set of related questions. Start with the audience, action, and required level of detail: is the person monitoring a process, comparing segments, or investigating a cause? Put the most important view first and use a visual hierarchy that communicates the intended reading order. An executive summary may emphasize a small set of trends and exceptions; an analyst's diagnostic dashboard can expose more filters and detail. Trying to satisfy every possible audience on one canvas often creates a dense page that serves none of them well.

Choose chart forms that match the comparison. Position and length support precise comparison; bars work well for categories, lines for ordered time, and scatterplots for relationships between measures. Pie and donut charts make small differences difficult to compare, especially across many categories. Color should have consistent meaning, limited categories, and sufficient contrast. Reserve saturated color for a signal or selection. Label units, date ranges, aggregation basis, and important exclusions. A title such as “Sales by month” is less useful than a title that states the scope and metric definition.

Use layout containers and consistent spacing to make the dashboard stable across supported screen sizes. Device layouts can adapt content, but they need testing; shrinking a desktop canvas does not automatically produce a good phone experience. Keep interactions discoverable and controls close to the views they affect. Make refresh time, selected filters, and relevant caveats visible. Provide useful empty states rather than a blank panel when a selection returns no data.

## Build fewer, purposeful sheets

Each worksheet in a dashboard can generate work, especially when it uses a separate data source or distinct query. A collection of tiny charts can be visually interesting but impose query, rendering, and maintenance overhead. Prefer a smaller number of purposeful sheets and combine information when a single view can answer the same question clearly. Avoid redundant legends, repeated filters, and labels that require excessive marks to be drawn.

Filters should be intentional. A quick filter with a huge domain can be slow or unwieldy and may trigger additional queries. A high-cardinality customer list is often better handled with search, a constrained selection workflow, or upstream scoping. Apply a filter to only the sheets that need it. Dashboard filter actions should pass only necessary fields, and parameter or set controls should expose a clear state.

Use tooltips to provide supporting detail without overcrowding the canvas. Tooltips can include relevant fields and explanatory text, but should not be a dumping ground for every column. If users need a data table or record-level export, provide an explicit detail path with appropriate permissions and volume limits.

## Diagnose performance, don't guess

A dashboard's perceived speed can be affected by query execution, network round trips, extract refresh state, server concurrency, rendering, and client/browser behavior. Establish a baseline with representative user actions and data. Tableau's performance recording and platform monitoring can help identify expensive queries, layout/render work, or other contributors, depending on environment. Inspect generated SQL and the warehouse query history for live connections; use query plans and source monitoring where available. Avoid claiming a universal “number of marks” or workbook-size threshold as a guarantee, because data shape, hardware, connector, and design differ.

For live connections, source-side modeling and query optimization matter. Use appropriate warehouse tables or views, selective fields, and predicates that the database can optimize. Check whether custom SQL, calculations, or casts prevent useful optimizations. For extracts, measure refresh and query behavior, and manage their storage and cadence. Neither switching live to extract nor reducing the worksheet count is automatically the answer; locate the expensive stage first.

## Extract optimization

An extract can be optimized by limiting it to the fields and rows necessary for the intended analysis, when doing so preserves the workbook's requirements. Removing unused columns reduces data carried and stored. Filtering old periods can constrain both footprint and query work, but it changes analytical scope and must be disclosed. Aggregate extracts can be appropriate for fixed-grain reporting; they are unsuitable if users need to drill below that grain. Make the data loss intentional, documented, and tested.

Extract creation options and performance characteristics vary by Tableau version, connector, data shape, and platform. Test representative queries and refreshes rather than relying on folklore. Use incremental refresh only when the change pattern and key support it; periodically reconcile or fully rebuild where historical changes need to be captured. A smaller extract is not a win if it silently omits rows users need or makes calculations incorrect.

## Context filters: semantics before tuning

A context filter creates a subset that other filters can depend on and changes where FIXED LOD expressions are evaluated. It is not a generic acceleration switch. If a calculation must respond to a category selection before FIXED runs, context may be required for correctness. For performance, the effect depends on cardinality, selectivity, data source, query plan, and workload. A context filter can add overhead or have little effect in a given case. Benchmark with the actual workbook and inspect performance evidence.

Where context is used, document why the filter is context and which calculations depend on it. Verify it against a known result. Avoid a dashboard where several high-cardinality context filters change a user's understanding without clear labels. A performance workaround that changes the data subset or metric is a correctness bug.

## Optimize in a sensible sequence

1. Reproduce the slow interaction and record expected behavior.
2. Identify whether time is spent in query, network, rendering, or refresh.
3. Check grain, joins, calculations, and filter scope for both correctness and unnecessary work.
4. Tune the data source or workbook using a controlled change, then measure again.
5. Test simultaneous use and the published environment, not only a local Desktop session.

A worksheet that is fast alone may become slow in a dashboard if multiple views run together or filters trigger repeated queries. Caching can affect repeat measurements, so record whether a test is cold or warm and do not compare unlike runs as though they were equivalent. Performance is also a capacity and concurrency concern, not solely a workbook authoring concern.

## Common mistakes

- Adding many tiny sheets, high-cardinality filters, and complex marks without measuring their cost.
- Assuming extracts or context filters always improve performance.
- Aggregating an extract and then presenting it as if row-level detail remains available.
- Removing data to make a dashboard faster without disclosing the changed scope.
- Testing only in Desktop and ignoring published credentials, network, and concurrent usage.
- Using color and chart types that obscure rather than clarify the comparison.

## Production notes

Design and performance should be reviewed together. Ask a user to perform the intended task, watch where they hesitate, and measure the interaction in the environment they will use. Keep a performance baseline and a correctness check for important metrics. Publish with a clear freshness indicator, supported layouts, and explicit data scope. The objective is not a minimal workbook at any cost; it is a responsive dashboard that still answers the right question.
