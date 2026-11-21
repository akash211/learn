# Data Factory Pipelines and Dataflows Gen2

Fabric's Data Factory workload is three products wearing one coat: **pipelines** for
orchestration, **Copy jobs** for bulk movement without transformation, and **Dataflows Gen2**
for Power Query-style transformation. Choosing wrongly is the most common cause of a pipeline
that costs too much and finishes too late. The engines are not interchangeable — a dataflow is
not "Spark with a nicer UI", and a Copy activity is not a scheduler.

## Pick the right tool before you build

| | Pipeline Copy activity | Copy job | Dataflow Gen2 | Spark notebook |
|---|---|---|---|---|
| Written code | None / low | None | None (M behind the UI) | Python, Scala, SQL, R |
| Strength | Orchestration + movement, 50+ connectors | Bulk and incremental replication, restartable | Transformation with 300+ Power Query functions, 150+ connectors | Arbitrary scale transformation |
| Weakness | Weak transformation; DIU-bound | No real transformation | Single-node mashup engine; poor at very large volumes | Requires engineering skill |
| Typical use | Land files, call notebooks, parameters | Lift-and-shift, incremental copies from databases | Cleansing small/medium sources, citizen integration | Silver and gold transformations |

The rule of thumb that survives contact with production: **move with Copy job or Copy activity,
transform with Spark unless the data is small or the logic is genuinely Power Query-shaped.**

## Pipelines: the orchestration layer

A pipeline is a DAG of activities. The ones you will actually use:

- **Copy data** — source to destination, with column mapping, compression and DIU settings.
- **Notebook** — runs a notebook with parameters and returns its exit value.
- **Dataflow** — refreshes a Dataflow Gen2.
- **Stored procedure** — calls warehouse T-SQL.
- **Lookup** — returns a small result set to drive `ForEach`, typically a watermark or a list of tables.
- **ForEach / If / Until / Wait** — control flow. `ForEach` has a configurable batch count; that
  is your parallelism dial, not the number of activities on the canvas.
- **Web / KQL / Spark job definition** — glue for everything else.

Parameters and dynamic content do the work that variables do in code:

```json
{
  "pipeline": "pl_ingest_orders",
  "parameters": { "entity": "orders", "loadDate": "2026-01-15" },
  "path": "@concat('bronze/', pipeline().parameters.entity, '/', pipeline().parameters.loadDate)"
}
```

Triggers are either schedule-based or event-based (for example, a file arriving in storage).
Event triggers plus a `ForEach` over the arrived files is the standard ingestion pattern; a
schedule is the fallback when the source cannot emit events.

## Incremental loads without a framework

Fabric has no built-in watermark engine, so the pattern is explicit:

1. **Lookup** the last successful watermark from a control table.
2. Pass it as a parameter into a Copy activity whose source query filters
   `WHERE ModifiedUtc > '@{activity('GetWatermark').output.firstRow.watermark}'`.
3. On success, **Stored procedure** (or another Copy) writes the new high-water mark.
4. Make the write idempotent — merge on the business key, or overwrite the affected partition —
   because retries and overlapping runs both happen.

Copy job covers the simplest version of this natively, including a one-time backfill plus
incremental follow-up. Reach for it before hand-rolling a watermark pipeline for a database
table that has no transformations.

## Dataflows Gen2: useful, with sharp edges

Dataflow Gen2 is Power Query Online with a destination. You get the connector library, query
folding against relational sources, and a visual editor that analysts can own. Two features
matter technically:

- **Staging** — for warehouse destinations, staging writes the mashup output to OneLake first,
  then loads it with `COPY INTO`-style bulk operations. Without staging, row-by-row inserts are
  slow enough to look broken on any real volume.
- **Fast copy** — for lakehouse destinations, a fast-copy path avoids the mashup engine for
  simple copies.

It is still a single-node engine. A dataflow that reads 200 GB and does a wide merge will be
slower and more memory-sensitive than the same logic in Spark, and it will consume capacity
while it runs. Dataflows are also a poor fit for large incremental loads: the destination write
is append-or-replace, not a merge, so you either duplicate rows on rerun or rebuild the whole
table — put the upsert downstream in Spark or T-SQL instead.

## Failure handling that holds up

- Set **retry** on Copy activities (transient throttling is normal at scale) and keep the retry
  count low enough that a real failure surfaces quickly.
- Use **failure dependencies** to route to a cleanup or notification activity rather than
  leaving orphaned staging files.
- Parameterise the environment (workspace, lakehouse, key vault-backed connection) so the same
  pipeline promotes through dev/test/prod via deployment rules.
- Monitor through the **Monitoring hub** and pipeline run history; assert on row counts, not just
  on "Succeeded". A pipeline that copied zero rows succeeded.

## Common mistakes

- Using a Copy activity for a 40-table incremental load when a Copy job or a metadata-driven
  `ForEach` would be a tenth of the work.
- Building transformation logic in a dataflow because it was faster to write, then discovering
  it cannot handle the volume.
- No idempotency: rerunning yesterday's pipeline duplicates rows, so nobody dares rerun anything.
- `ForEach` with default batching over 500 items, hammering a source database and getting throttled.
- Treating the pipeline canvas as documentation. It is code: put it in Git and deploy it through
  a pipeline, not by clicking in production.

## Production notes

Keep one ingestion framework per domain: a control table listing source, target, key, watermark
column and load type, plus a single parameterised pipeline that reads it. That is easier to
monitor, cheaper to run and far easier to hand over than 60 hand-drawn pipelines. Store
credentials in Key Vault-backed connections, not in pipeline parameters, and alert on duration
and row-count deviation — the failure you care about is usually silent.
