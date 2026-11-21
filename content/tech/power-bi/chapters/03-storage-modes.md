# Storage Modes and Choosing

Storage mode describes where a table's data is held and how queries reach it. It changes freshness, response time, source load, model behavior and operational dependencies. Pick a mode after measuring workload and source capabilities, not because one sounds newest or most real-time.

## Import

Import loads data into the semantic model, where the VertiPaq in-memory engine stores a compressed representation. Visual queries are usually fast because they run against the model rather than making a round trip to the source for every interaction. Import supports rich modeling and DAX behavior and can reduce load on operational systems after refresh. Its trade-offs include refresh duration, model memory and capacity limits, and data freshness bounded by refresh cadence. Import often fits curated analytics where interactive performance is more important than second-by-second freshness.

A model can still be large even when the source tables look modest. High-cardinality text, unnecessary columns and overly granular data can reduce compression and consume memory. Filter and aggregate at source when semantics permit; keep the grain needed for analysis. Refresh is a separate workload from report interaction, so plan its window and source impact.

## DirectQuery

DirectQuery leaves table data at the source and translates model queries into source queries. It can provide access to changing data without importing all rows, but it does not guarantee real-time results: source caches, query execution, network latency and visual refresh all matter. Each visual or interaction may generate one or more source queries, so a report that looks fine in Desktop against a fast local source can burden a shared production database. Connector capabilities and source performance shape which modeling features are available.

Design for query pushdown. Keep transformations foldable, use a source schema suited to filtering and grouping, and test the actual generated workload. A DirectQuery model may have limitations or behavior differences for calculated tables, calculated columns, relationships, DAX functions and composite models. Check current connector documentation. Avoid making a heavily used transactional system the untested query engine for dozens of interactive reports.

## Dual and composite models

Dual is available in composite-model designs for supported sources such as some Analysis Services and Power BI semantic model scenarios. A Dual table can behave as imported for queries that can be answered locally or as DirectQuery when a query requires source access. This can let shared dimensions support imported aggregations and DirectQuery facts without forcing every query into the source. It is not a general switch that makes a table both perfectly fresh and free of memory cost. Model relationships and query shape determine which path is selected.

Composite models combine tables with different storage modes, including Import and DirectQuery, and may use aggregations. They can deliver fast common summaries while preserving detail access at the source. They also add complexity: cross-source relationships, source credentials, query routing, cache behavior and security propagation must be understood. Test totals and drill-through paths, not only the landing-page visuals.

## Direct Lake

Direct Lake is a Microsoft Fabric storage mode for semantic models that read Delta tables in OneLake without the conventional full import process or DirectQuery translation path. It can combine an in-memory analytical engine experience with data stored in Fabric. Its behavior and fallback considerations depend on the Fabric item and configuration. Direct Lake is not a generic mode for arbitrary cloud storage or a synonym for DirectQuery. Confirm supported table formats, capacity and model feature constraints, and understand when a query can require fallback behavior in the chosen configuration.

Direct Lake is compelling when data already resides in suitable Fabric lakehouse or warehouse structures and the operating model is designed around OneLake. It does not remove the need to curate data, model relationships, govern access or monitor capacity. Changes to Delta files, schema evolution and security must be tested end-to-end.

## Freshness and security constraints

A decision also needs a freshness contract. “Current data” can mean current to the last completed refresh, current to a source commit, or current within a measured number of minutes. Write down a freshness objective and how it is observed. For Import, calculate refresh duration and the time between source change and model availability. For DirectQuery, test cache behavior, source commit visibility and any refresh schedule for metadata or supporting imported tables. For Direct Lake, validate how OneLake updates become visible to queries in the target configuration. If the business cannot define freshness, a platform debate is premature.

Security and source ownership can change the choice. Imported data is copied into the model, so access to the model and its export paths must be governed. DirectQuery may use configured credentials or identity behaviors that affect what the source authorizes; verify the connector's supported identity options. Composite models can create several trust boundaries. Confirm that row security filters remain correct as data moves across relationships and sources. A performance win that unintentionally broadens access is not a successful architecture.

## Choosing with a workload test

| Need | Candidate to evaluate | Questions to test |
|---|---|---|
| Fast interactive analytics on a bounded, refreshed dataset | Import | Model memory, refresh window, source load, required freshness |
| Large or rapidly changing source data, with source query capability | DirectQuery | Source concurrency, latency, query folding and connector limits |
| Shared dimensions plus mixed imported and source-resident facts | Dual/composite model | Routing, relationship behavior, aggregations and security |
| Curated Delta data in Fabric OneLake | Direct Lake | Fabric capacity, feature support, freshness and fallback behavior |

Prototype a representative report, including high-cardinality slicers, detail drill-through, concurrent users, refresh and a busy source period. Measure p95 interaction time, source query duration, resource consumption and freshness lag. If a storage mode is selected only after a trade-off is explicit, future teams can maintain it.

### Common mistakes

Think through failure and change scenarios as well as a normal report session. If the source becomes unavailable, should users see the last imported snapshot or an error? Is stale data clearly labeled? How does a semantic-model schema change affect a Direct Lake table, and who communicates that contract? What happens when a source column is dropped? Import may preserve previously loaded values until the next successful refresh, while a source-routed model may fail immediately on an incompatible query. These behaviors influence user expectations and incident response. Build a service-level objective for freshness and availability that names the measured event, such as source commit to visible semantic query, rather than using vague claims like “live.” Test the objective after refresh, source outages and capacity contention. Include alert ownership so users do not discover a stale model only after a business decision has been made.

- Equating DirectQuery with zero latency or guaranteed real-time data.
- Assuming Dual is a no-cost combination of Import and DirectQuery.
- Choosing Direct Lake without Fabric and Delta-table prerequisites.
- Comparing a single Desktop visual rather than the complete source and refresh workload.

### Production notes

Storage mode is a property of table design and system behavior, not just an authoring preference. Document why the mode was chosen and which behaviors were tested. Reassess if source concurrency, data volume, freshness requirements or Fabric architecture changes. For a critical model, retain a rollback or alternative design and monitor both the semantic model and underlying capacity.
