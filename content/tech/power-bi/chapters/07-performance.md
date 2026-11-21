# Performance Tuning

Power BI performance depends on the whole query path: visual design, DAX, semantic-model shape, storage mode, network, source engine, gateway and shared capacity. Start with a reproducible slow interaction and measurements. “Power BI is slow” does not identify whether the bottleneck is a costly visual query, oversized model, source timeout, refresh contention or rendering behavior.

## Reduce model size and improve compression

VertiPaq is a columnar in-memory engine. It stores columns separately and compresses repeated values effectively. Low-cardinality attributes such as country codes often compress well; high-cardinality identifiers, timestamps and free-form strings are harder to compress. Model size is influenced by distinct values, data types, row count, dictionary encoding and relationships—not merely source file size. Remove unused columns, reduce unnecessary precision and avoid importing descriptive text that no report uses. Keep numeric values numeric and use integer surrogate keys where they provide a sound model design.

Reducing rows can be more valuable than reducing bytes per row. Aggregate old data if users do not need its transaction-level detail, while retaining appropriate drill paths. Do not round or discard business-relevant values just to save memory. A calculated column adds storage and processing; a measure is computed at query time. Avoid duplicate date, key or label columns when one dimension can supply them, but preserve clarity and correct grain.

## Diagnose DAX and visual queries

Use Performance Analyzer in Desktop to capture visual refresh durations and copy the DAX query for investigation. DAX Studio can connect to a model and inspect server timings, query plans, storage-engine versus formula-engine work, and model metadata. The precise tool output depends on connection and model configuration. Compare cold and warm behavior, and test the same filter context. A visual's total time can include client rendering and other overhead, so do not attribute all duration to DAX.

In DAX, prefer simple aggregations when they express the business rule. Reduce large row-by-row iterators and repeated expensive expressions when measurement proves they are hot. Variables can avoid duplicate evaluation and improve readability. Keep filters selective and use a star schema that allows efficient dimension-to-fact propagation. High-cardinality slicers, too many visuals on a page and complicated custom visuals can each raise query or rendering cost. Reduce unnecessary visual interactions and page-level query fan-out.

For DirectQuery, inspect source query duration and execution plans, source indexes and workload concurrency. A good DAX expression cannot compensate for an overloaded source or a transformation that prevents query pushdown. For Import, inspect model size, refresh duration and capacity pressure. For Direct Lake, inspect Fabric capacity and the current model/query path. Tune the layer that measurements implicate.

## Model-level and capacity considerations

Model architecture sets an important performance ceiling. A dimension should have a clear unique key, and a fact should avoid unnecessarily wide text fields. Relationship chains and ambiguous paths can force complex filter resolution. When a visual asks for a combination that crosses several facts, decide whether a conformed dimension is enough or whether a purpose-built aggregate is warranted. Do not create a new physical table for every report: overlapping aggregates increase refresh, storage and governance work. Check that any aggregation table covers the dimensions and measures expected in common queries and that detail requests can still reach the correct source.

Capacity contention is another common hidden factor. A report might be quick in Desktop and slow in the service because other models refresh or other users issue expensive queries at the same time. Compare timings by time of day and examine available capacity monitoring signals. Refresh and interactive workloads can compete for memory and compute. Coordinate heavy refresh windows, reduce unnecessary parallel work and test realistic concurrency. Scaling capacity without diagnosing a model problem can mask inefficiency; conversely, a well-tuned model can still need more capacity when usage grows.

Measure distributions, not just averages. A mean latency may conceal a poor p95 experience for a subset of filters or users. Include high-cardinality selections, empty-result cases and drill-through. Keep a small benchmark suite with stable data or controlled fixtures so a model change can be compared reliably. Record the query, date, model version and capacity state alongside timings. This makes performance a regression-tested product characteristic rather than an anecdotal complaint.

## Establish a repeatable tuning loop

1. Record the exact report, page, visual, slicers, user and time of a slow interaction.
2. Capture Performance Analyzer output and identify query versus rendering time.
3. Reproduce the query and inspect DAX Studio server timings or source telemetry as appropriate.
4. Form one hypothesis: reduce columns, change an iterator, adjust a relationship, fold a filter or redesign a visual.
5. Change one thing, rerun the same workload and compare correctness and latency.
6. Test at realistic concurrency and with representative data volume before release.

Document baseline and target measures such as p95 interaction latency, model memory, refresh duration, DirectQuery source load and capacity utilization. A model can become faster for one visual but slower for refresh or another query. Check correctness after every change, especially when rewriting filter logic, changing relationships or aggregating data.

### Common mistakes

Separate model tuning from report usability. Users may interpret a page as slow because it has too many choices, unclear navigation or a large visual query, even if the underlying model is healthy. Use fewer high-value visuals per page, provide sensible default filters and make expensive drill paths explicit. A slicer with thousands of unique values is both a usability and query concern; a searchable dimension or guided filter may improve both. Custom visuals can add rendering cost and introduce their own compatibility or security review, so test them on the target device and service. Accessibility features such as alt text and keyboard navigation are not optional cleanup: they shape report quality and should be verified alongside performance. Keep a balance between responsive interaction and explainable results. If a visual is made faster by removing context users need to interpret the metric, the optimization has traded away analytical value.

- Assuming a smaller PBIX file guarantees low in-memory model size or fast queries.
- Optimizing DAX by intuition without capturing the actual visual query.
- Replacing a correct star schema with denormalized tables to avoid understanding relationships.
- Reducing cardinality by truncating identifiers that are required for drill-through or reconciliation.
- Measuring only one warm query with no concurrent users.

### Production notes

Use a small set of representative benchmark reports and repeat them after model or capacity changes. Track model size, refresh outcomes, query duration and source workload over time. DAX Studio and Performance Analyzer are diagnostic instruments, not automatic optimization buttons; interpret evidence in the context of the model's intended semantics and service execution environment.
