# Power Query and Dataflows Gen2

Power Query is the data preparation layer used by Power BI Desktop and other Microsoft products. Its M language describes a sequence of transformations, but the editor lets analysts express most common steps without writing M directly. Dataflows Gen2 brings Power Query-based preparation into Microsoft Fabric as a reusable, cloud-executed data preparation item that can write results to supported destinations. The useful design question is not simply “where can I transform this?” but where transformation logic should live, who owns it and how it is operated.

## Query folding and transformation patterns

Power Query applies steps in order. A connector may translate compatible steps into a source-native query, a process called query folding. Folding lets the database filter, project, join or aggregate data before it crosses the network. It is especially valuable for large sources and incremental refresh. Folding is connector- and step-dependent; a step that breaks folding can cause later operations to run in the mashup engine, potentially retrieving far more data than expected.

Filter early and remove unneeded columns. Apply type conversions deliberately, use stable keys for joins, and avoid expanding a many-to-many nested join without checking row multiplication. Foldable filters, projections and aggregations are common wins. Custom M functions, row-by-row operations and some operations over local files can limit folding. Check query-folding indicators where supported and inspect source queries or diagnostics for the actual connector. Do not infer folding just because preview results appear quickly; previews can use small samples or cached data.

A clean staging query often connects to a source and defines reusable, non-loaded preparation; a final query selects and shapes fields for the model. Disable load for helper queries when appropriate. For larger systems, place durable conformance transformations in a warehouse or lakehouse so multiple consumers share them. Keep semantic calculations—especially measures that depend on report filters—in the semantic model rather than baking them into a static source extract.

## Parameters, credentials and error handling

Parameters can support environment-specific server names, paths, date ranges and reusable functions. They are not secrets. Use the platform's credential and secret mechanisms for authentication, and avoid embedding passwords or tokens in M expressions. Credentials are configured for the relevant data source identity and refresh context; a Desktop author successfully previewing a query does not prove that service refresh has the required credentials or network path.

Handle data quality intentionally. A `try` expression can capture errors, but converting every error to null may conceal a broken schema or failed cast. Prefer explicit validation columns, error tables or documented rejection logic. Preserve enough source lineage to investigate an invalid record. Set column types at a clear point and test locale-sensitive dates and decimal separators. When schemas evolve, fail visibly or map known optional fields deliberately rather than silently selecting the wrong column.

## Dataflow contracts and source boundaries

Power Query M uses lazy evaluation in many scenarios, so the displayed sequence of applied steps is a logical recipe, not necessarily a literal sequence of full-table materializations. A preview can evaluate only a subset; a service refresh may process a different volume and expose type, privacy or credential issues that were invisible during authoring. Profile data quality and distribution at the scale that matters, and inspect whether joins preserve the expected row count. After a merge, compare distinct business keys and nulls before loading. If a source returns duplicate keys, deduplicating without a deterministic rule can make the output unstable between refreshes.

Privacy levels and credential boundaries deserve attention when a query combines sources. The mashup engine may isolate sources or prevent certain combinations to avoid unintended data transfer. Do not disable privacy protections reflexively to speed a refresh. Instead, understand the data sources, organizational policy and supported combination behavior. When combining a private database with a public file, document which fields cross the boundary and whether the destination is approved. In a service-based flow, assign credentials to the managed source connection rather than embedding them in M.

A robust reusable flow also has a data contract. State column names and types, key uniqueness, nullability expectations and how schema changes are announced. A source adding an optional column can be harmless, while renaming a required key may invalidate every downstream entity. Use staging and curated layers only when each has a defined role. Name the dataflow output for its business meaning, record its consumers and ensure that a failed refresh triggers an actionable alert rather than an unnoticed stale report.

## Dataflows Gen2 and destinations

Dataflows Gen2 is a Fabric-managed Power Query experience intended to transform and persist data for reuse. It can be part of a Fabric pipeline feeding a lakehouse, warehouse or other supported destination. This differs from a Desktop query that loads directly into a single PBIX semantic model: the flow can create an upstream managed artifact with its own refresh, ownership and lineage. Evaluate which destination connectors and write behaviors are available in the current tenant and region; supported destinations and capabilities change over time.

A dataflow is useful when multiple models or teams need the same cleaned entity, or when data preparation should be centrally scheduled and monitored. But an extra layer creates another refresh dependency and another artifact to govern. Define ownership, retry behavior, failure alerting, retention and schema-change policy. Avoid duplicating the same transformation independently in a dataflow and in each report. Consider a warehouse or lakehouse for transformations that need SQL, code review, tests or broad reuse, while keeping Power Query for convenient connector-level shaping.

### Common mistakes

Source-side work should be evaluated with the source owner. A transformation that folds may still issue an expensive query, hold locks, or scan a table without an appropriate index. Coordinate extraction windows and use a read replica or analytical copy when the operational database should not serve large scans. Conversely, a source-side stored procedure can create a stable and testable contract, but it may reduce interactive parameterization or require connector support. Record the SQL or M expression used for critical entities and keep examples of expected output. Review privacy and classification as data is materialized into a destination, because prepared output can have a broader audience than the original source. Align output retention and deletion policy with governance requirements. A refresh that is technically successful but leaves obsolete sensitive records in a lakehouse or staging destination is not a safe pipeline.

- Assuming each visible Power Query step runs at the source.
- Expanding joined tables without validating keys and output row counts.
- Treating parameters as secure secret storage.
- Creating a dataflow as a universal fix for refresh time without measuring its own runtime and dependencies.
- Suppressing conversion errors so thoroughly that source data defects become invisible.

### Production notes

Test the service execution path with the intended identity and destination. Capture query diagnostics and row counts for representative large periods. Use names that explain business purpose, preserve transformation lineage, and version consequential changes. Separate reusable preparation from report-specific shaping, and avoid gratuitous query layers where a direct, well-governed model would be simpler.
