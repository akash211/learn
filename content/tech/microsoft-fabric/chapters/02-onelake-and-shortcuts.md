# OneLake and Shortcuts

OneLake is the part of Fabric that everything else assumes. It is a single logical data lake
for the whole tenant, built on Azure Data Lake Storage Gen2 semantics: hierarchical namespace,
POSIX-style ACLs, and an ABFS driver that Spark already understands. There is one OneLake per
tenant, one container per workspace, and one folder per item. You rarely think about it until
you need to share data without copying it — and then it is the only thing that matters.

## The layout you should memorise

```
https://onelake.dfs.fabric.microsoft.com/<workspace>/<item>.lakehouse/Tables/fact_sales
abfss://<workspace>@onelake.dfs.fabric.microsoft.com/<item>.lakehouse/Files/raw/2026/01/
```

Both forms address the same bytes; workspace and item IDs work in place of names and survive
renames. Inside a lakehouse there are exactly two top-level folders:

- **Tables/** — managed Delta tables, discovered automatically and exposed to the SQL analytics
  endpoint and to Direct Lake.
- **Files/** — everything else. No table discovery, any format, any folder depth.

A warehouse looks similar on disk (its tables are Delta too), but you do not manage it through
the filesystem; the T-SQL engine owns writes. That distinction drives most of the lakehouse vs
warehouse decision in the next chapter.

## Everything is Delta, whether you asked or not

Loading a DataFrame into a lakehouse table produces Parquet files plus a `_delta_log`
directory. The same is true for warehouse tables, mirrored databases, and KQL databases with
OneLake availability enabled. This is why the ecosystem is unusually coherent: Power BI's
Direct Lake, Spark, PyArrow, DuckDB or an external Databricks cluster can all read the same
folder, because it is an open format with a transaction log.

It also means file hygiene is your problem. Thousands of tiny Parquet files slow every engine
that touches them, and no amount of semantic-model tuning fixes a table written by a job that
committed one file per row group per micro-batch.

## Shortcuts: a pointer, not a copy

A **shortcut** is an object in OneLake that points at a target path elsewhere. It appears as a
folder, behaves like a symbolic link, and is independent of its target: deleting the shortcut
leaves the target intact, but moving or deleting the target breaks the shortcut.

| Shortcut target | Typical use |
|---|---|
| Another lakehouse's `Tables/` (table or whole schema) | Share curated data across workspaces without duplicating |
| A warehouse table | Expose SQL-built marts to Spark and Direct Lake |
| A KQL database | Join real-time data with batch data in Spark or SQL |
| ADLS Gen2 / Azure Blob | Read the raw zone you already land into |
| Amazon S3, S3-compatible, Google Cloud Storage | Cross-cloud reads without an egress-heavy copy pipeline |
| Dataverse | Operational data next to analytics data |

Rules that trip people up:

- In **Tables/**, shortcuts can only be created at the top level, and the target must be Delta
  for the lakehouse to recognise it as a table. A Delta table whose name contains a space is
  not recognised at all.
- In **Files/**, shortcuts can live at any depth and point at any format.
- In a **KQL database**, shortcuts behave like external tables and are queried through
  `external_table()`.
- Shortcut tables synchronise schema automatically, including new columns at the source.

## The security model is where shortcuts bite

For an **internal** shortcut (OneLake to OneLake), reads are authorised against the calling
user's permissions on the target item. Analysts see only what they could see by opening the
target directly.

For an **external** shortcut (S3, ADLS Gen2, Blob, GCS), OneLake stores a connection —
credentials or a managed identity — and every reader of the shortcut inherits the access that
connection has. A workspace Viewer can therefore read an S3 bucket they have no IAM rights to.
That is convenient and occasionally a compliance incident. If the source supports pass-through
authentication, use it; otherwise treat the shortcut as a data-exposure decision, not just a
convenience, and put OneLake security roles or a mediated gold layer in front of it.

There is a second subtlety: source ACLs, labels and lineage do not travel with an external
shortcut. A sensitivity label on a file in S3 does not label the shortcut. You are re-governing
the data at the Fabric boundary.

## Shortcut or copy?

| Question | Shortcut | Copy |
|---|---|---|
| Data must stay in the source system of record | Yes | No |
| Source is in another region or cloud | Possible, but latency and egress apply | Usually better |
| You need to transform, compact or apply retention | No — write to a managed table | Yes |
| You need per-user source permissions enforced | Only with pass-through/OneLake security | Yes, by re-implementing them |
| Source format is CSV/JSON and you want SQL access | Not for Tables/; land and convert to Delta | Yes |

Cross-region shortcuts are the most common performance surprise. A shortcut to an S3 bucket in
another continent is metadata-cheap but byte-expensive: every query pays WAN latency and egress,
and Direct Lake models built on it frame more slowly. Shortcut caching, where available, helps
for repeated reads but does not turn a distant bucket into local storage.

## Common mistakes

- Creating a shortcut to a CSV folder inside `Tables/` and wondering why no table appears.
- Assuming a shortcut copies data and then double-charging storage by also landing a copy.
- Pointing a Direct Lake model at a shortcut to a non-Delta folder, or at a table outside `Tables/`.
- Using shortcuts to "solve" governance when the real requirement is per-user row-level access.
- Forgetting that deleting the target silently breaks every downstream shortcut.

## Production notes

A workable pattern is shortcuts at the edges and managed Delta in the middle: bronze shortcuts
point at landed raw data you do not own, silver and gold are managed tables you compact and
version, and cross-workspace sharing uses internal shortcuts on gold rather than exporting
files. Name tables without spaces, keep shortcut depth shallow, and document which shortcuts
carry stored credentials — that list is effectively a list of places where Fabric can read more
than the user can.
