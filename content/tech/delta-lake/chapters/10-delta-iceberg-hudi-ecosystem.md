# Delta, Iceberg, Hudi and Delta Outside Databricks

Delta Lake, Apache Iceberg and Apache Hudi are open table formats: they add table metadata and transaction semantics above data files, commonly Parquet. They overlap but are not interchangeable APIs. A format choice shapes commit protocols, metadata scaling, catalog integration, streaming and merge support, engine coverage, operational tooling and migration cost. Pick based on the engines and operations you actually need, then test the exact feature intersection rather than comparing a marketing checklist.

## Three formats, different design emphases

| Area | Delta Lake | Apache Iceberg | Apache Hudi |
|---|---|---|---|
| Table state | Transaction log with versioned snapshots; `_delta_log` actions and checkpoints. | Snapshot metadata, manifests and manifest lists; catalog and metadata design are central. | Timeline of table actions with indexing and write modes; supports incremental table processing. |
| Common strengths | Mature Spark integration, straightforward version history, strong merge/CDC workflows in Delta clients. | Broad multi-engine adoption, snapshot/metadata abstractions and catalog-oriented interoperability. | Record-level ingestion patterns, indexing and incremental consumption options for update-heavy data. |
| Trade-offs | Protocol feature compatibility matters; some optimizations are platform-specific. | Engine/catalog capabilities and feature support differ; table maintenance and catalog choice matter. | More write-mode and indexing choices increase tuning complexity; engine feature parity must be checked. |

This is a guide to design tendencies, not a universal ranking. All three formats have evolved, and implementations add features at different speeds. A format can be open while particular capabilities—concurrency control, automatic maintenance, governance, catalog service or row-level optimization—are offered only by one managed platform.

## Delta outside Databricks

Delta is not synonymous with Databricks. The open-source `delta-spark` package integrates Delta Lake with Apache Spark and supports core table operations such as reads, writes, schema checks, `MERGE`, time travel and maintenance subject to Delta/Spark version compatibility. Use the Delta project's compatibility matrix rather than installing the latest Spark and latest Delta independently. Spark SQL extensions and catalog configuration are part of setting up the client correctly.

Delta Kernel provides a lower-level library for building connectors without reimplementing the transaction log. It aims to let engines read and write Delta while respecting protocol and feature rules. A connector's feature coverage depends on the kernel and connector version; “built on Kernel” does not mean every Delta feature is implemented.

`delta-rs` is a Rust implementation with Python bindings exposed through the `deltalake` package. It can read and write tables from Rust/Python ecosystems and offers integrations with Arrow, DataFusion and other tools. It is not a Spark wrapper. APIs and operations differ from `delta-spark`, and support for table features or transaction concurrency must be checked for the exact release. A table created with a newer protocol may not be writable by an older delta-rs client, even if it can read ordinary Parquet files.

Databricks Runtime includes Spark and Delta integrations plus managed features. Unity Catalog, predictive optimization, Photon acceleration, managed sharing/governance and some concurrency or automatic layout features belong to Databricks services/runtime rather than the open-source Delta protocol as a whole. Conversely, OSS Delta Lake evolves independently and may include features not enabled in every managed runtime version. Verify scope and release status feature by feature.

## Interoperability is protocol- and catalog-dependent

A table can be readable by several engines only when those clients understand its protocol version, table features, checkpoint format and catalog/storage conventions. A feature may require upgrading only writers or both readers and writers; a client that cannot construct a valid snapshot cannot safely write. Test the slowest-upgrading client before enabling deletion vectors, column mapping, liquid clustering, row tracking or any other protocol feature.

Catalog configuration also matters. A filesystem-managed table identifies its log at a path; catalog-managed tables may rely on catalog operations beyond simple path access. Delta Lake 4.0 introduced catalog-managed tables as a preview in the release announcement; preview scope and subsequent support must be verified against the actual release and catalog. Do not assume a catalog-managed feature is production-ready merely because it appears in a preview release.

Cross-format compatibility layers can expose one table through another format or catalog, but they do not make format differences disappear. For example, UniForm is a Delta capability that supports Iceberg-compatible reads in specified configurations. Readers, table features and write restrictions vary by release; treat it as an interoperability mechanism with a supported feature matrix, not a free dual-writer guarantee.

## Choosing a format in practice

Ask these questions in order:

1. Which engines must read and write—Spark, Flink, Trino, Snowflake, Python/Arrow or proprietary warehouses—and what versions are deployed?
2. Do you need frequent row-level updates, CDC, append-only analytics, streaming ingestion or large snapshot reads?
3. Which catalog controls names, authorization, locking/coordination and table discovery?
4. Which feature set is mandatory now, and which is a preview or future requirement?
5. How will you migrate, rollback, validate row parity and maintain historical data?
6. Who operates compaction, vacuum, catalog health, protocol upgrades and recovery?

For a Spark-first lakehouse already invested in Delta operations, Delta can be the simplest fit. For a heterogeneous engine estate, test Iceberg's support in the specific engines and catalog rather than assuming ecosystem breadth solves every operation. For ingestion patterns centered on incremental record changes, assess Hudi's indexing and table services. Benchmark representative workloads and concurrency scenarios, not only a single scan.

## Common mistakes

- **Choosing by file format alone.** Parquet rows do not define the transaction model, catalog semantics or change feed.
- **Equating open source with universal interoperability.** Protocol and feature support still differ by version.
- **Calling Databricks-managed automation “Delta.”** Distinguish protocol, OSS library and managed service.
- **Assuming all Delta clients support `MERGE` equally.** APIs, concurrency and feature support differ across Spark, delta-rs and other connectors.
- **Treating preview as general availability.** Preview flags, catalog-managed tables, variants and coordinators require explicit status checks.

## Production notes

Maintain a compatibility matrix that lists the table protocol and enabled features alongside each reader/writer and version. Test upgrades against representative tables with production-like feature combinations. For each critical table, document a canonical writer and disallow undocumented alternate writers until their concurrency and protocol support are validated. Cross-engine support is an operational contract, not an assumption.

A useful proof of interoperability is a conformance test, not a successful `SELECT *` on one sample. Create a disposable table with the intended schema and feature set, write with the canonical engine, then read it from each consumer and compare row counts, null behavior, deletes and time-travel expectations. If multiple writers are proposed, test concurrent commits, retries and catalog consistency as well as ordinary appends. Include upgrades: the oldest supported version is often the one that constrains protocol choices. Keep results with the deployment manifest so a connector update triggers a re-check.

For migration between formats, retain the source table until the destination has been reconciled. Compare key-level results, schema and null semantics, change history expectations, retention and downstream table identifiers. A one-time copy proves only that a snapshot could be transferred; it does not prove ongoing CDC, rollback or coexistence behavior. Explicitly assign the writer during cutover to avoid two formats accepting divergent changes.