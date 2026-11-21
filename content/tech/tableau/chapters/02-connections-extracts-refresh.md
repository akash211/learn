# Connections, Extracts, and Refresh Strategy

## A connection is an architectural choice

Tableau connects to databases, cloud warehouses, files, and published data sources through connectors. A connection defines how Tableau reaches the data, what authentication path it uses, and which capabilities are available. The source can be modeled as logical tables, physical joins, unions, or custom SQL, depending on connector and product. A successful connection proves only that Tableau can communicate; it does not prove that the schema, permissions, grain, or query performance are suitable for a workbook.

A live connection sends queries to the underlying system as the user interacts with the view. The database or warehouse is responsible for executing those queries, and the user experience depends on network latency, source workload, generated SQL, caching, and concurrency. Live is not automatically fresher in every circumstance: upstream ingestion may lag, and source-side materializations can update on their own schedule. Nor is live automatically slower; a well-modeled warehouse may efficiently answer Tableau queries.

An extract is a Tableau-managed snapshot of selected source data, typically stored in Tableau's extract format. It can reduce repeated source queries and support analysis when the source is unavailable, subject to configuration and platform behavior. Extracts can include all or a filtered subset of data and can be full or incremental refreshes when a suitable key and refresh design exist. An extract is not simply a screenshot or a guaranteed copy of everything in the source. Fields, filters, aggregation, and extraction options affect the resulting dataset.

## Choosing live or extract

Choose live when users require source-level freshness, the source can handle interactive query demand, and connectivity and permissions are appropriate. It may be a natural fit for a governed warehouse with controlled compute and an established query workload. Confirm that the connection is truly live in the published environment and that the platform can reach the database using the configured authentication method.

Choose an extract when interactive response should be insulated from repeated source access, when offline or portable analysis matters, or when a curated snapshot is the intended product. Extracts can help when a source has costly per-query access, but they move work to extract creation and refresh. Capacity, storage, refresh duration, concurrency, and freshness requirements remain operational concerns. There is no universal row-count cutoff or performance multiplier; measure with representative data and queries.

Some workbooks combine multiple connections or published data sources. Understand which data is live, which is extracted, and whether secondary sources use blending or another relationship. A published data source can centralize connection and calculation logic; it does not automatically guarantee that all workbooks follow the same metric definitions if authors make local copies or duplicate calculations.

## Full and incremental refresh

A full refresh rebuilds an extract from the source selection. It is straightforward and can reflect source updates, deletes, and changes to older rows, but its cost depends on source query and data volume. An incremental refresh appends or updates data according to a configured field and refresh behavior. Commonly, a monotonically increasing timestamp or identifier marks new records. Incremental refresh is appropriate only when the source's change pattern matches the configuration. Late-arriving records, corrections to historical rows, deletes, and non-unique or unreliable keys can make a simple append strategy incomplete.

A robust refresh plan starts with freshness semantics. Ask what event makes a record available, whether records can be changed later, how deletions are represented, and what delay the business accepts. Then pick refresh cadence and method. If historical corrections occur, schedule periodic full rebuilds or design a source-side change capture process that accounts for updates and deletes. Validate record counts, date coverage, and important totals after refresh; successful job status alone is not a data-quality check.

Tableau Server and Cloud use background processing for extract refreshes, with capabilities and scheduling details that differ by platform, edition, and configuration. Credentials must be stored or delegated through supported secure mechanisms. Embedded credentials can simplify scheduled refresh but need careful ownership and rotation. OAuth, key-pair, and other connector authentication features vary. Do not assume Desktop's interactive credentials will transfer to a published workbook.

## Query and refresh design

Use the warehouse as the place for reusable joins, cleansing, and business rules when that improves consistency and performance. Tableau custom SQL can be useful, but it may constrain query optimization or platform behavior; test its actual plan and consider a database view or modeled table when logic is shared. Select only necessary columns and rows where that is safe and maintains correctness. Extract filters can reduce stored data, but they also restrict what users can explore. State those restrictions clearly.

Incremental keys deserve data engineering attention. A timestamp with ties and time-zone conversion can skip or duplicate records if the extraction boundary is unclear. A numeric surrogate key may not capture late updates. Define the watermark, uniqueness, and replay behavior. If the platform does not support the desired change semantics through a simple incremental extract, avoid pretending that it does. Build a periodic reconciliation and refresh recovery procedure.

Refresh scheduling should coordinate with source ingestion. A refresh at 06:00 that runs before a 06:00 load completes can publish yesterday's data under today's timestamp. Use dependency-aware scheduling where available, monitor duration and failures, and communicate the dashboard's last successful data time. Refresh bursts can compete with warehouse workloads; stagger them and size capacity based on observed contention, not a guessed benchmark.

## Publishing a source

Publishing a data source lets teams reuse its connection, extract, calculations, and permissions. A certified or otherwise governed source helps users find a trusted starting point. Give it a clear owner, description, field definitions, lineage, and refresh schedule. Separate development and production workbooks or use controlled promotion. When changing a shared source, identify dependent workbooks and test compatibility; renaming or removing a field can break downstream assets.

Packaged workbooks can include data for portability, while published workbooks can connect to shared server-side sources. Both have implications for data exposure and duplication. Choose the packaging and publishing mode deliberately, especially for regulated or confidential data. Verify what is embedded, what credentials are present, and who has download permissions.

## Common mistakes

- Saying extracts are always faster or live connections are always current.
- Using incremental refresh without modeling updates, deletes, and late-arriving facts.
- Publishing successfully from Desktop but failing to provide server-side credentials.
- Refreshing before upstream ingestion is complete.
- Hiding extract-filter limits from dashboard consumers.
- Treating job completion as evidence that the data is complete and correct.

## Production notes

Document the connection type, source owner, refresh mode, last refresh time, and expected freshness. Test refresh failures and recovery, not only the happy path. Use least-privilege database access and supported credential storage. Reconcile extracts against source totals after schema or pipeline changes. The correct choice is the one whose freshness, user experience, operational cost, and governance can be reliably maintained.
