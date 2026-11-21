# Medallion Architecture and Table Design

Medallion is a naming convention for a data flow, not a law of physics: **bronze** holds data as
it arrived, **silver** holds it cleaned and conformed, **gold** holds it shaped for consumption.
The value is not the three folders. It is that each layer has a different contract, so a broken
source does not corrupt a dashboard, and a bad transformation can be replayed from raw data
without asking the source system for another extract.

The architecture fails when teams implement the names and skip the contracts — bronze with a strict
schema that rejects the file it was meant to preserve, silver that is a `SELECT *` with renamed
columns, gold that is a third copy of silver with no grain.

## What each layer promises

| Layer | Grain | Contract | Typical storage |
|---|---|---|---|
| Bronze | One row per source record, as received | Append-only, schema-tolerant, replayable | Streaming table or Delta table |
| Silver | One row per entity per event, deduplicated and typed | Validated, conformed, current truth | Streaming table, materialized view, Delta table |
| Gold | One row per business question | Stable, documented, serving-ready | Materialized view or table |

Bronze should be boring and forgiving. Keep the payload, add ingestion metadata (`_ingest_time`,
`_source_file`, `_batch_id`), capture unparseable fields in `_rescued_data` rather than failing
the load, and avoid business validation. If bronze rejects rows, the raw evidence is gone and a
schema change upstream becomes an outage.

Silver is where the work happens: cast types, standardise codes, deduplicate by a natural key and
a source sequence, resolve late-arriving records, quarantine what fails validation, and expose one
row per entity that downstream layers can trust. Silver is also where PII policy is applied —
masks and filters on gold are a second line of defence, not the first.

Gold is a product. Declare the grain in the table comment, name the dimensions consistently, and
aggregate to the level the consumer asks for. A gold table that requires the BI developer to join
four tables and filter `__is_current` is not gold.

## Choosing the object type

Databricks gives you several ways to publish a table, and the choice has cost and freshness
consequences:

- **Streaming table** — incrementally processes new data, appends or merges, tracks checkpoints.
  Right for ingestion and incremental transformation.
- **Materialized view** — a query whose result is stored and refreshed, fully or incrementally.
  Right for aggregations and joins that are expensive to recompute per query.
- **View** — a saved query, no storage, recomputed on every read. Right for thin projections,
  renames and row-level security wrappers.
- **Plain Delta table written by a job** — maximum control, you own the merge logic and the
  schedule.

Declarative pipelines (Lakeflow, formerly Delta Live Tables) manage streaming tables and
materialized views together: you declare the query, the platform works out the DAG, the
checkpoints and the refresh, and expectations record data-quality rules with drop, warn or fail
behaviour. That is a good default for a new medallion build, and a poor fit when the logic depends
on imperative side effects.

A useful heuristic: append-and-transform → streaming table; aggregate-and-serve → materialized
view; rename-and-restrict → view; complex merge with external coordination → a table written by
a job.

## Keys, constraints and grain

Delta supports `NOT NULL` and `CHECK` constraints that are enforced on write, and primary and
foreign key constraints that are **informational** — they are not enforced, but declaring them
with `RELY` lets the optimizer use them for join elimination and reordering.

```sql
CREATE TABLE prod.silver.customers (
  customer_id   STRING NOT NULL,
  email         STRING,
  region        STRING,
  updated_at    TIMESTAMP NOT NULL,
  CONSTRAINT pk_customers PRIMARY KEY (customer_id) RELY
)
CLUSTER BY (customer_id)
COMMENT 'One current row per customer; SCD1. Owner: customer-domain.';
```

Declaring the grain in a comment sounds like documentation theatre until two analysts aggregate
the same table at different grains and produce two different revenue numbers. Write it down, and
put the deduplication key in the table comment too.

## Layout decisions per layer

- **Bronze**: usually unpartitioned or partitioned by ingestion date. It is written once and read
  for replay; clustering by source entity helps selective backfills.
- **Silver**: cluster by the entity key (and a date where queries filter on it). This is where
  liquid clustering earns its keep, because query patterns change as the domain matures.
- **Gold**: cluster by the dimension most dashboards filter on, or partition by date when retention
  is enforced by dropping partitions.

Do not partition every layer by date out of habit. A bronze table with 2,000 daily partitions of a
few megabytes each is worse than one unpartitioned table, and the small-file problem compounds
through every downstream layer.

## SCD1, SCD2 and history

Type 1 overwrites: one row per entity, `MERGE` on the key, no history. Type 2 keeps validity
intervals (`__valid_from`, `__valid_to`, `__is_current`) and a new row per change, so facts can be
joined to the dimension as it was at event time.

Choose deliberately. Type 2 doubles storage and complicates every join (`AND __is_current`), and
it is only worth it when reports must reflect historical attribution — a customer who moved
regions, a product that was repriced. Declarative pipelines can maintain SCD2 from a change feed
with `APPLY CHANGES ... STORED AS SCD TYPE 2`; hand-rolled SCD2 needs a sequence column and a test
for overlapping intervals.

## Backfills are the test of the design

If a transformation is wrong, you should be able to fix it and reprocess from bronze without
touching the source. That requires bronze retention longer than your worst-case discovery time —
thirty to ninety days is common — and transformations that are deterministic functions of their
input plus a run date.

If bronze was overwritten nightly, or the pipeline reads directly from an API, the backfill turns
into a negotiation with an external team. Design the retention and the replay path before the
first incident, not during it.

## Common mistakes

- **Strict schemas on bronze.** A new upstream column fails the load and the raw file is lost.
- **Silver as renamed `SELECT *`.** No dedupe, no typing, no quarantine; the bugs move downstream.
- **Gold as a copy of silver.** Storage cost with none of the modelling benefit.
- **Partitioning all three layers by date.** Small files everywhere and slow scans.
- **No deduplication key in silver.** Retries and replays quietly multiply rows.
- **SCD2 without a sequence column.** Late events create overlapping validity intervals.
- **Views for expensive aggregates.** Every dashboard refresh recomputes the join.
- **Medallion for 50 MB of data.** Three layers of ceremony around a table a single query could serve.

## Production notes

Assign an owner per layer or per domain, and make the silver contract explicit: column meanings,
accepted values, freshness, and what happens to bad rows. Data-quality expectations should write
their results somewhere queryable — a quarantine table with a reason column beats a log line.

Keep retention aligned with replay: bronze longest, silver medium, gold as long as consumers need
history. Drop partitions rather than deleting rows where retention is time-based, and vacuum on a
schedule that leaves room for time travel.

Finally, review the layers as a cost chain. Bronze is cheap to store and expensive to reprocess;
gold is expensive to store and cheap to query. If gold is rebuilt from silver every hour for a
dashboard that changes daily, the refresh frequency — not the cluster size — is the thing to fix.
