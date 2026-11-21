# Cost, Capacity Sizing and Performance Tuning

Fabric billing is deceptively simple: you pay for capacity, not per query, and storage is
metered separately. That simplicity hides the operational reality — a capacity that is 30% idle
and a capacity that is 95% utilised cost the same money and feel completely different. Sizing
and tuning are therefore the same exercise: reduce the work, then buy the compute that work
actually needs.

## What you are paying for

| Cost | Driven by | Lever |
|---|---|---|
| Capacity compute | CU-seconds consumed by every workload | Right-size SKU, remove waste, pause when idle |
| OneLake storage | Bytes stored, including every copy and every retained Delta version | Retention, compaction, fewer copies, `VACUUM` |
| Cross-region / cross-cloud reads | Shortcut traffic and egress | Co-locate data, cache, or copy deliberately |
| Power BI per-user licences | Named users, Pro/PPU requirements | F64 threshold for free viewers |

Capacity is billed continuously while it exists, which is why a development capacity left
running all weekend is the most common avoidable cost in a Fabric estate. F SKUs can be paused
and resumed, and can be purchased with an Azure reservation for a discount if the baseline is
predictable.

## Sizing without a spreadsheet fantasy

The wrong method is to add up peak concurrency and multiply. Fabric bursts and smooths, so a
five-minute spike that would double a naive estimate may cost almost nothing, while a sustained
80% load for six hours will throttle you no matter how good the peak looks.

A method that works:

1. **Run the real workload** for two weeks on a trial or a deliberately small SKU.
2. **Read the Capacity Metrics app**, not the average: look at P95 smoothed utilisation,
   throttling events, and carryforward.
3. **Attribute consumption to items.** Two or three items usually own most of it; optimise them
   before resizing.
4. **Size for headroom** — enough that month-end close and a concurrent Spark job do not push
   you into interactive delay.
5. **Re-test at the target SKU.** Some workloads scale sub-linearly with CU.

Add a second capacity when the workload mix is incompatible: interactive BI on one, batch Spark
on another. That costs more than one big capacity and buys isolation, which is often worth it.

## Where the money actually leaks

- **Idle Spark sessions.** Interactive notebooks hold a session until the timeout; a forgotten
  tab is not free.
- **Refreshing everything hourly** because one table needs it. Tier your refresh cadence.
- **Copying data that could be shortcut**, then copying it again into a warehouse.
- **Unbounded retention** on raw event tables and Delta version history.
- **Full refreshes** where an incremental merge would do, on both warehouse and Import models.
- **Small-file churn** that makes every downstream query read 10,000 files.
- **Over-modeling**: 40 Direct Lake models over the same gold tables, each holding its own
  in-memory columns.

For Spark specifically, **on-demand billing** exists as an option outside the shared capacity
pool. It changes the economics for spiky, heavy jobs (and disables bursting/smoothing for that
usage), but it also removes the natural ceiling — so it needs budget alerts, not just a switch.

## Tuning each engine

**Spark.** Fix skew before adding nodes: a single hot partition will use one core while the
rest idle. Enable adaptive query execution, broadcast small dimensions, avoid Python UDFs on
large row counts, compact small files, and partition only on columns you filter by. Check stage
metrics for shuffle spill — that is usually a join strategy or partitioning problem, not a
"needs a bigger cluster" problem.

**Warehouse.** Statistics drive the optimiser; Fabric creates them automatically for many
operations, but you can and should create them deliberately on join and filter columns:

```sql
CREATE STATISTICS st_orders_customer ON dbo.orders(customer_id) WITH FULLSCAN;
```

Prefer `CTAS` and `COPY INTO` over row-by-row inserts, avoid cursors, keep data types narrow,
and use result-set caching for repeated identical dashboard queries. Query insights shows the
plan and the time split, which is faster than guessing.

**Pipelines.** Parallelism is `ForEach` batch count and activity-level concurrency, but the
source is usually the bottleneck — 20 parallel copies into one Azure SQL database will throttle,
not accelerate. Set DIUs deliberately for large moves and use staging for warehouse loads.

**Eventstream and KQL.** Right-size throughput, avoid parsing JSON repeatedly (define the schema
at ingestion), set retention and hot-cache windows to match how far back people actually query,
and pre-aggregate with materialized views instead of scanning raw events per dashboard tile.

**Semantic models.** Fewer columns, lower cardinality, framing instead of full refresh, and one
model per subject area. For Import models, incremental refresh and hybrid tables exist; for
Direct Lake, the tuning happens in the Delta table.

## A diagnosis sequence that works

When someone says "Fabric is slow", resist the urge to resize:

1. **Is it throttling?** Check the metrics app for interactive delay/rejection and carryforward.
   If yes, the fix is consumption or SKU — tuning a query will not help a rejected request.
2. **Whose consumption is it?** Attribute to item and operation. A single bad notebook at 09:00
   can look like "the platform is slow".
3. **Is it this query or this engine?** Compare a cold and warm run; check whether a Direct Lake
   model is falling back to DirectQuery; check Spark stage metrics.
4. **Is it the data layout?** File count, partitioning, statistics, and table width explain most
   remaining cases.
5. **Only then** consider scaling, and scale one step at a time.

## Common mistakes

- Sizing on averages, then being surprised by month-end.
- Buying one huge capacity for everything and calling it simplicity.
- Optimising a query that is actually being throttled.
- Forgetting that every file-rewriting Delta operation leaves old files behind until `VACUUM` runs.
- Leaving a trial or dev capacity running indefinitely.
- Assuming a bigger SKU fixes small files. It does not; it just reads them faster.

## Production notes

Set budget alerts on the Azure subscription and capacity-threshold alerts in Fabric, and review
the top ten consuming items monthly. Keep a cost tag per domain so chargeback is possible
without a spreadsheet archaeology project. Treat performance work as a loop — measure, change
one thing, measure again — because Fabric's smoothing means a single fast run proves very
little about the steady state your users experience.
