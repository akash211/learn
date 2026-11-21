# Deletion Vectors and Liquid Clustering

Deletion vectors and liquid clustering address different but related problems: row-level change cost and data layout. Both are table features that affect protocol compatibility. They are useful only when the readers and writers across the table's ecosystem understand the feature; a Parquet-only reader cannot assume the table's current rows from data files alone.

## Deletion vectors: logical row changes without immediate rewrite

Without deletion vectors, updating or deleting a few rows in a Parquet file generally means writing replacement file(s) and removing the originals from the current snapshot. A deletion vector (DV) records that specific row positions in a data file are logically deleted or superseded. A supported reader applies that metadata while scanning, so the table can commit a small row-level change without immediately rewriting the entire file.

This can accelerate `DELETE`, `UPDATE` and `MERGE` workloads that touch a small fraction of large files. It is a **soft delete** at first: changed values and deleted rows can remain physically present in old or current Parquet data until a rewrite applies the vector and vacuum removes obsolete files. If physical erasure is required, plan a purge/rewrite and retention process, then verify storage lifecycle and backup behavior.

Support has arrived incrementally. OSS Delta Lake documentation describes DV support beginning with Delta 2.3 for scans, later releases for DML, and broader `MERGE` support in 3.1; exact behavior depends on Delta version and client. Enabling DVs upgrades a table protocol, potentially excluding clients that cannot read them. Databricks Runtime may enable and optimize DVs differently, with capabilities such as row-level concurrency or Photon predictive I/O that are not generic OSS guarantees. Check both read and write matrices, not just whether an engine advertises Delta.

Compaction can physically apply some DV changes, but it is not necessarily a complete purge of every affected file. OSS documentation distinguishes `OPTIMIZE` from a targeted purge operation such as `REORG TABLE ... APPLY (PURGE)` in supported environments. Availability of `REORG` and its exact semantics are client/runtime-specific. Follow the implementation's documented path and vacuum only after the rewrite and retention window are correct.

## Liquid clustering: layout that can evolve

Traditional partitioning fixes directory boundaries; Z-order rewrites data around chosen columns. Liquid clustering stores clustering intent in table metadata and incrementally organizes files around clustering keys during supported writes or `OPTIMIZE`. The keys can be changed without an immediate full rewrite, allowing future data layout to follow new query patterns. Existing data does not magically move when keys change; a full reclustering operation is required where supported.

Clustering can help tables filtered by high-cardinality fields, with skew, rapidly growing data or changing access patterns. It is not a B-tree index and does not promise every query will scan fewer files. Readers use file statistics/data skipping, so benefit depends on clustering execution, statistics collection and filters matching the clustering columns.

OSS Delta Lake supports liquid clustering in recent releases (introduced in Delta 3.1, with APIs and behavior evolving through subsequent versions). The feature requires protocol support, and OSS documentation states it is incompatible with Hive-style partitioning and Z-order on the same table. Databricks provides a managed implementation with additional runtime support; `CLUSTER BY AUTO`, predictive key selection, managed scheduling and automatic optimization should be labeled Databricks platform capabilities where applicable, not assumed as open-source Delta behavior.

## Choosing and enabling safely

Choose keys from observed predicates and joins, typically a small number of frequently filtered columns. Avoid guessing from table names or adding every candidate key. In OSS support, limits and operations vary by release; recent docs describe up to four clustering columns and require statistics on those columns. For an existing table, enabling clustering may change table protocol even if it does not rewrite old data immediately. Inventory all clients first.

A measured migration process is:

1. Capture baseline bytes scanned, files pruned, read latency, write latency and maintenance cost.
2. Verify every reader and writer supports the exact protocol features enabled, including DVs and clustering if both are used.
3. Enable on a representative table or isolated copy, then trigger the supported optimization operation.
4. Verify row counts and key-level results, and compare real filter workloads over both old and new data.
5. Set a rewrite/purge and vacuum plan if deletion vectors are part of sensitive-data removal.
6. Document rollback limitations. Protocol upgrades may not be reversible simply by setting a property to false.

## Compatibility is a correctness issue

A reader without deletion-vector support might expose rows marked as deleted if it bypasses or misunderstands the protocol. An unsupported writer might fail when it encounters a required feature or, worse, write without preserving expected semantics. Liquid clustering also relies on metadata and data-skipping conventions; a client must obey the relevant protocol. Never treat interoperability as “the file is Parquet, so all engines work.”

Some features that appear in release announcements are preview or experimental, and their support scope may differ between OSS and managed runtimes. Confirm generally available status, supported operation list, and minimum client versions against the exact release before production rollout.

## Common mistakes

- **Calling a DV a physical erase.** It marks row positions logically; data can remain in storage.
- **Assuming `OPTIMIZE` purges all DVs.** Purge guarantees are operation- and client-dependent.
- **Mixing liquid clustering with partitioning or Z-order.** The OSS feature is documented as incompatible with these layout strategies.
- **Assuming changed clustering keys reorganize old files.** Key metadata changes do not itself rewrite existing data.
- **Treating Databricks automation as an OSS feature.** Predictive optimization and automatic key selection are managed-platform features.

## Production notes

Track feature enablement as a compatibility migration. Test old readers, catalog tools, backup/restore paths, sharing clients and any delta-rs or Spark jobs before upgrading protocol. For sensitive deletes, record the physical rewrite version and vacuum completion, and verify whether copies, exports or backups fall under the same erasure requirement.

## Safe rollout checklist

A feature migration needs both a data test and an ecosystem test. For deletion vectors, compare current row results across every reader before and after enabling the feature, then verify that deletes remain correct after compaction, restart and time travel. For liquid clustering, compare query plans and file-skipping metrics for the actual filter distribution, including new rows and historical files. A metadata setting alone is not evidence that older data has been reorganized.

Separate feature enablement from unrelated schema changes where possible. If a reader fails, that isolation narrows the cause to protocol, catalog, credentials or the new table layout. Keep a copy of representative data and snapshots so the tests exercise realistic history. Ask storage and governance teams whether soft-deleted bytes in old versions, snapshots or backups are subject to erasure requirements. Finally, record the minimum client version in the table's ownership documentation and block deploys from unlisted writers until they pass conformance tests.