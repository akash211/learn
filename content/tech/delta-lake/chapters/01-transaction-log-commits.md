# The Transaction Log and Commits

Delta Lake's essential unit is a **table version**, not a directory listing. A table is a storage location containing Parquet data files and `_delta_log`, a directory of transaction records and checkpoints. The log tells a reader which files comprise each committed version and which metadata and protocol rules apply. Without consulting it, a consumer that globs every Parquet file can read data that has been removed from the current table, duplicate rows, or miss the meaning of deletion vectors and other features.

## What is in `_delta_log`?

A new table typically begins with a JSON commit file named `00000000000000000000.json`. Each subsequent successful commit writes a new monotonically numbered JSON file, such as `00000000000000000001.json`. A commit is a sequence of actions, commonly including:

| Action | Purpose |
|---|---|
| `protocol` | Minimum reader/writer versions and required table features. |
| `metaData` | Schema, partition columns, table configuration and identity. |
| `add` | A data file becomes active, with partition values and optional statistics. |
| `remove` | A previously active file is logically removed from the current snapshot. |
| `commitInfo` | Operation name, timestamp, parameters and available metrics. |

The precise action set depends on the operation and protocol. The log describes logical state transitions; it does not contain the table's actual rows. Parquet holds those rows. A `remove` action does not necessarily delete its file immediately: old files are retained for time travel and safe cleanup until retention permits `VACUUM`.

As the log grows, readers should not have to replay every JSON file from version zero. Delta writes checkpoint files containing a compact representation of table state, so a reader loads a checkpoint and applies later commits. Checkpoint representation and optional log-compaction/checksum features evolve by implementation and protocol; clients must support features declared by the table. A checkpoint is an acceleration structure, not an independent authority that replaces the transaction history.

## Reconstructing a snapshot

To read version *v*, the client finds the most recent usable checkpoint at or before *v*, applies later log actions in version order, and derives the active file set, schema, partitioning and protocol. It then reads the Parquet files in that snapshot. A snapshot is internally consistent: a query does not see half of a transaction merely because the writer has already uploaded some new data files.

This explains why `spark.read.format("delta").load(path)` is not equivalent to `spark.read.parquet(path)`. The latter reads files as files. It does not interpret `add`/`remove` actions, table schema history or protocol features. Direct Parquet access can be useful for forensic recovery, but it is not a correct substitute for the Delta reader on a mutable table.

## A write and its commit

A typical write has a data phase and a commit phase:

1. The writer reads a table snapshot and plans the operation against that version.
2. It writes new Parquet files to storage. These files are not visible as table contents just because they exist in the directory.
3. It attempts to publish the next log version, containing `add` actions for new files and (for replacement operations) `remove` actions for old files.
4. Once that commit is accepted, readers reconstruct a new snapshot containing the change. If the commit cannot safely be published, the new data files are unreferenced and can eventually be cleaned up.

The exact publication mechanism depends on the storage system and commit coordination setup. Classic Delta implementations commonly use atomic creation of the next version's log file, relying on storage guarantees or a configured LogStore implementation to prevent two writers from claiming the same version. Coordinated commits provide a different coordination path in supported configurations. Do not assume that arbitrary object stores have POSIX rename semantics, or that two engines can safely write simply because both can upload files. Consult the client and storage integration's compatibility requirements.

## Why numbered files matter

The monotonically increasing commit version gives readers a clear ordering. Suppose two writers both start from version 40. Both may upload data, but both cannot simply publish independent version 41 as if one followed the other. One writer wins the version slot or the coordinator serializes publication. The other must validate against the intervening change; it may retry from a newer snapshot or report a conflict. The transaction log is therefore both a snapshot description and the serialization boundary for table state.

The log is append-oriented: committed versions are not edited in place during ordinary writes. This makes history inspectable and supports version-based reads. It does not mean files live forever. Log retention and data-file retention are separate concerns; `VACUUM` removes obsolete data files, while log cleanup/checkpoint policies govern how much history remains available for reconstruction and inspection.

## Inspecting a table safely

On Spark, useful starting points include `DESCRIBE HISTORY table_name`, `DESCRIBE DETAIL table_name`, and a versioned read with `versionAsOf`. These surface the table's operation history, location, schema, file count or protocol-adjacent details, subject to runtime. A raw `_delta_log` inspection can help explain a commit or troubleshoot a client, but should not be used to hand-edit the log. Editing or deleting JSON/checkpoint files behind a live table can make the snapshot unrecoverable.

A robust reader checks the protocol before interpreting the snapshot. The log may declare reader features such as deletion vectors or column mapping; an old client that ignores those semantics could return incorrect rows, not merely fail to optimize. Compatibility is therefore a correctness requirement.

## Common mistakes

- **Listing Parquet files to get the current table.** Some are obsolete; some current rows may depend on table features outside bare Parquet semantics.
- **Treating uploaded files as committed.** Visibility comes from an accepted log commit, not from file presence.
- **Deleting `_delta_log` to save space.** This destroys the state machine that defines the table.
- **Assuming JSON commits are the only log artifacts.** Checkpoints and protocol features are part of normal operation.
- **Assuming a commit is atomic across multiple Delta tables.** Ordinary table transactions are scoped to one table. A workflow updating several tables needs application-level orchestration or an explicitly supported transaction service.

## Production notes

Monitor commit latency and conflicts as well as data-file count. Excessive tiny commits can increase metadata work even if each data write is small. Conversely, one huge transaction may take longer to plan and conflict with more writers. Choose write batch sizes based on reader freshness, retry behavior, and the workload's concurrency. Keep the transaction log under the control of Delta clients and validate every engine against the table's actual protocol and feature set before granting it write access. Treat manual log edits as unsupported surgery: even a syntactically valid action can violate invariants that are not obvious from one JSON line. For an unexplained state, preserve evidence, record the table version, and use supported inspection or recovery tools.