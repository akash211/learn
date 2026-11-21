# Delta Lake in Practice

Delta gives you a transactional table; it does not give you a well-laid-out one. The physical
arrangement of files is still your responsibility, and on Databricks that responsibility is
expressed through three operations: `OPTIMIZE`, `VACUUM` and the choice of clustering keys. Get
them right and queries read a fraction of the data. Get them wrong and every dashboard scans
terabytes to return forty rows.

Managed tables on Databricks get some of this automatically — `optimizeWrite` coalesces small
writes, `autoCompact` tidies after them, and predictive optimization can schedule maintenance on
Unity Catalog managed tables. Knowing what is automatic, and what merely could be, is most of the
practical skill.

## Why file layout decides query cost

A Delta table is a directory of Parquet files plus a log. Every file carries a fixed overhead: an
open, a footer read, a task, a row group. A table with 200,000 files of 2 MB each is slower to
scan than the same bytes in 800 files of 500 MB, even though the data is identical, because the
engine spends its time on metadata and task scheduling rather than on decoding columns.

Small files accumulate from three sources: streaming micro-batches that commit every few seconds,
`MERGE` statements that rewrite a handful of rows into new files, and partitioned writes with a
high-cardinality key. Compaction is the countermeasure, and it is a rewrite — you pay once in
compute to read fewer bytes many times afterwards.

```sql
-- compact, then check what you got
OPTIMIZE prod.silver.orders;
DESCRIBE DETAIL prod.silver.orders;   -- numFiles, sizeInBytes, partitioning
```

`OPTIMIZE` bin-packs active files into larger ones, targeting roughly 128–256 MB. It is
incremental in the sense that it only rewrites files below the target size, but it rewrites whole
files: compacting a 1 TB table costs a 1 TB read and write. `OPTIMIZE ... WHERE` limits the scope
to recent partitions, which is what you want for a table that only accumulates small files at the
head.

## Z-ORDER versus liquid clustering

Data skipping works from per-file statistics: min/max values, null counts, and optionally bloom
filters. If a predicate's value range falls entirely outside a file's range, the file is skipped.
Clustering makes those ranges tight and non-overlapping for the columns you filter on.

```sql
-- classic: multi-dimensional clustering, rewritten by each OPTIMIZE
OPTIMIZE prod.silver.orders ZORDER BY (customer_id, order_date);

-- current default for new tables: keys declared once, applied incrementally
CREATE TABLE prod.silver.orders (...)
CLUSTER BY (customer_id, order_date);
```

| | Z-ORDER | Liquid clustering |
|---|---|---|
| Declared | Per `OPTIMIZE` statement | On the table, `CLUSTER BY` |
| Changing keys | Rewrite the table | `ALTER TABLE ... CLUSTER BY`, no rewrite |
| Applied by | Each `OPTIMIZE` | `OPTIMIZE`, incrementally |
| Partitioning | Separate mechanism | Replaces it |
| Recommended for | Existing partitioned tables | New tables |

Liquid clustering is the better default for new work because the keys are metadata, not a
physical partitioning decision you have to get right on day one. You can add a column to the
clustering key when query patterns change without rewriting history, and `OPTIMIZE` only
reorganises the data that is not already clustered.

Two constraints are worth remembering. Clustering works on columns used in selective filters —
clustering by a low-cardinality status column buys nothing. And a table cannot be both
partitioned and liquid-clustered; converting means rewriting the table.

Partitioning is still correct in specific cases: very large tables where a single low-cardinality
column (usually a date) is always filtered, and where you want partition-level operations such as
`replaceWhere` or dropping old data by partition. The failure mode is partitioning by a
high-cardinality column such as `customer_id` or a timestamp with seconds — thousands of
directories, tiny files, and a metadata bill that dwarfs the data.

## VACUUM and retention

`VACUUM` deletes data files that are no longer referenced by any retained table version and are
older than the retention threshold. It does not compact, and it does not shrink the current
snapshot; it removes history.

```sql
VACUUM prod.silver.orders RETAIN 168 HOURS;
VACUUM prod.silver.orders DRY RUN;   -- list, don't delete
```

The default retention is seven days. Lowering it shortens the window in which time travel,
`RESTORE`, long-running queries and streaming readers can still reach old files — and a query that
started before the vacuum can fail mid-scan with a missing-file error. Databricks refuses
retention below the safety threshold unless the check is explicitly disabled; disabling it is
how teams discover, in production, that a reader was still using yesterday's files.

Log retention and file retention are separate clocks. The transaction log defaults to a longer
window than the data files, so `DESCRIBE HISTORY` can list a version whose files have already been
vacuumed. History is not a backup.

## Time travel and restore

```sql
SELECT * FROM prod.silver.orders VERSION AS OF 42;
SELECT * FROM prod.silver.orders TIMESTAMP AS OF '2026-03-01T00:00:00Z';

RESTORE TABLE prod.silver.orders TO VERSION AS OF 42;
```

Time travel reads an old snapshot without changing the table; `RESTORE` commits a new version
whose contents match the old one, so the fix is itself auditable and reversible. Both depend on
two things surviving: the log entry and the underlying files. Vacuum breaks the second, log
cleanup breaks the first.

Timestamp-based travel resolves to the latest version committed before that time, which is
usually what you want and occasionally one version off if a commit landed in the same second.

## Deletion vectors and row-level changes

A `DELETE` or `MERGE` that touches a few rows used to rewrite every affected file. With deletion
vectors enabled, Delta writes a small bitmap marking deleted rows and leaves the file in place,
which makes selective updates much cheaper. The cost moves to reads: a scan must apply the vector,
and the physical files still contain the deleted rows.

`REORG TABLE ... APPLY (PURGE)` materialises the deletions by rewriting files, and until it runs,
`VACUUM` cannot reclaim the space. For a table with heavy churn, schedule a periodic purge rather
than assuming the deletes freed anything.

## Predictive optimization

For Unity Catalog managed tables, predictive optimization can run `OPTIMIZE`, `VACUUM` and
`ANALYZE` on a schedule Databricks chooses from the table's workload. It is enabled at the
account, catalog or schema level, and it is the right default for tables nobody has time to
maintain.

It is not a substitute for design. Predictive optimization will happily compact a badly
partitioned table into slightly larger small files; it cannot know that your dashboard filters on
`customer_id` and your clustering key is `region`. Its operations are recorded in system tables,
so you can verify that it actually ran rather than assuming.

## Common mistakes

- **Z-ORDER on the partition column.** The partition already prunes files; you paid for a rewrite that adds nothing.
- **Z-ORDER on eight columns.** Each additional dimension dilutes the clustering; three or four is the practical limit.
- **Partitioning by a high-cardinality key.** Thousands of directories and files smaller than a row group.
- **`VACUUM RETAIN 0 HOURS` to save storage.** It breaks time travel, restores and in-flight readers.
- **Assuming `DELETE` freed space.** Deletion vectors are logical until purged and vacuumed.
- **Running `OPTIMIZE` on a table that is written once a day and read once a day.** The rewrite costs more than it saves.
- **Compacting without checking `DESCRIBE DETAIL`.** No baseline, no evidence the rewrite helped.

## Production notes

Measure before and after: `DESCRIBE DETAIL` gives file count, total size and partitioning; the
table's history shows operation metrics. A table with an average file size under 50 MB is a
compaction candidate; one with 100 MB+ average files and pruning predicates on the clustering key
is probably fine.

Prefer liquid clustering on new tables, keep partitioning only where partition-level operations
are genuinely needed, and review clustering keys when query patterns change — that is the whole
advantage of the metadata approach. Schedule `OPTIMIZE` after the bulk load, not during it, and
scope it with `WHERE` on the recent range for append-heavy tables.

Align `VACUUM` retention with your actual recovery objective and the longest query your readers
run, not with a storage-cost target. If storage cost is the problem, the fix is usually retention
of raw history or unpartitioned duplicates, not a vacuum window of zero.
