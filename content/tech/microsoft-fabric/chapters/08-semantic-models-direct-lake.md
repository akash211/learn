# Power BI Semantic Models and Direct Lake

A semantic model is where Fabric stops being a data platform and becomes a product. It holds
the measures, relationships, hierarchies and security rules that reports actually query. In
Fabric the interesting question is not how to build one — it is which **storage mode** the
tables use, because that choice determines freshness, cost and the failure modes you will be
debugging at month end.

## Three storage modes, one engine (mostly)

| Mode | Where data lives | Refresh means | Query performance |
|---|---|---|---|
| Import | Compressed copy inside the model | Full or incremental reload of data | Fast; VertiPaq in-memory |
| DirectQuery | Source system | Nothing — queries go to the source | Depends entirely on source |
| Direct Lake | Delta/Parquet files in OneLake | Metadata only ("framing") | Near-Import, with guardrails |

Import is still the right answer for small, slow-changing, self-service models where the
analyst controls the whole pipeline. DirectQuery remains useful when the source must enforce
its own security or the data cannot leave the system of record. Direct Lake is the Fabric-native
option for large Delta tables, and it is the one interviewers ask about.

## How Direct Lake actually works

Direct Lake is not "DirectQuery against Parquet". The VertiPaq engine reads Parquet directly
from OneLake and transcodes columns into memory on demand:

1. A DAX query arrives. The engine works out which columns are needed — those referenced by
   measures, relationships and the visual.
2. Columns not already in memory are loaded from the Delta table's Parquet files and become
   **resident**.
3. A **refresh** does not copy data. It performs **framing**: it reads the Delta log, validates
   the files, and updates the model's references. That takes seconds, not hours.
4. Columns are evicted under memory pressure, after long inactivity, or when a new frame
   invalidates them.

Two consequences follow. First, first-query latency is real: a cold model pays to transcode
columns, so benchmarking on a warm cache flatters it. Second, **memory is the constraint**, not
storage. The SKU determines the per-model memory limit, and the number of row groups and files
per table is capped by guardrails that vary by capacity size — which is why a table with
50,000 tiny files can fail to frame even though the row count is modest.

## Direct Lake on OneLake vs Direct Lake on SQL

There are two flavours, and they behave differently enough to change a design:

- **Direct Lake on OneLake** reads Delta tables from one or more Fabric items, resolving
  shortcuts natively. It does not use the SQL analytics endpoint, has no DirectQuery fallback,
  and can be combined with Import tables in a composite model. This is the mode to prefer for
  new work.
- **Direct Lake on SQL** uses a single item's SQL analytics endpoint for table discovery and
  permission checks. It supports SQL views, but falls back to DirectQuery when it cannot read
  the Delta files directly — for example, when a view or SQL-based row-level security is
  involved. Fallback is slower and can surprise you in production.

If your model points at views for convenience, you are implicitly choosing the slower path.
Materialise the view into a Delta table instead.

## Getting the tables right

Direct Lake performance is mostly decided upstream:

- **One Delta table per model table.** Not a view, not a folder of files.
- **Reasonable file sizes.** Compact with `OPTIMIZE`; avoid micro-batch output with thousands of
  tiny files.
- **V-Order or equivalent write optimisation** improves read throughput, but note that the
  default changed: workspaces created before April 2025 had V-Order and Optimize Write on by
  default, newer ones do not. Set it explicitly in your write path.
- **Narrow tables.** Every column transcoded costs memory and time; a 400-column table with 12
  used columns is a design smell.
- **Low-cardinality strings** where possible; high-cardinality text is the classic memory hog.

## Security and the model boundary

Model-level RLS and OLS work in Direct Lake, and for Direct Lake you should use a **fixed
identity** connection rather than relying on the querying user's identity for data access —
otherwise a user who cannot read the lake can still read the model's cached columns. If you
also enable OneLake security (row/column/file-level enforcement at the storage layer), the
model and the lake can share one definition of access instead of two that drift.

Be precise about what each layer protects. A SQL analytics endpoint's permissions apply only
through that endpoint. Workspace roles apply to items. OneLake security applies to the files.
A semantic model's RLS applies to DAX queries. Four layers, four different bypasses — a
security review that only checks one of them is theatre.

## Model design that survives

- One semantic model per subject area, many reports. Report-level datasets are how
  organisations end up with nine versions of "revenue".
- Measures in the model, not in every report; calculation groups for time intelligence.
- Explicit date table, marked as a date table, with relationships that filter correctly.
- Incremental refresh is an Import concept; with Direct Lake you get freshness from framing, so
  do not rebuild an Import-style incremental scheme on top of it.
- Since September 2025 lakehouses no longer auto-create a default semantic model, and the
  previously auto-created ones were decoupled by late November 2025. Treat the model as a
  first-class item with its own owner, deployment and permissions.

## Common mistakes

- Pointing Direct Lake at a SQL view and assuming it behaves like a table.
- Benchmarking on a warm cache and concluding the model is fast for users who arrive cold.
- Leaving thousands of small files because "Spark wrote them, not me".
- Assuming Direct Lake removes the need to model: it removes the load, not the star schema.
- Using Import for a 500 GB fact table "because Direct Lake is new", then fighting refresh windows.
- Forgetting that Direct Lake requires a Fabric capacity — it is not available on Pro/PPU-only
  licensing, unlike Import and DirectQuery.

## Production notes

Monitor framing failures and query fallbacks, not just refresh success. Keep a warm-up query or
two for the most-used reports if cold-start latency matters. Size the capacity for concurrent
model memory, since several Direct Lake models share the same pool and eviction under pressure
shows up as unpredictable slowness. And validate every Direct Lake model against the real table
layout — the guardrails fail loudly at scale, and quietly at 10% of scale.
