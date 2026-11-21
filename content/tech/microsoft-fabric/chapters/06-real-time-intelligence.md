# Real-Time Intelligence

Batch pipelines answer yesterday's question. Real-Time Intelligence exists for the questions
that expire in seconds: a truck is speeding, a payment gateway error rate just doubled, a
production line's vibration signature changed. Fabric implements this with four items —
**Eventstream** for ingestion and lightweight processing, **Eventhouse/KQL database** for
storage and query, **Real-Time Dashboards** for visualisation, and **Activator** for action.
The glue is the **Real-Time hub**, a tenant-wide catalogue of streams you can subscribe to
instead of re-plumbing each one.

## Eventstream: the no-code pipe

An Eventstream is a canvas: sources on the left, operators in the middle, destinations on the
right. Sources include Event Hubs, Kafka, IoT Hub, change data capture from operational
databases, storage events and sample data. Destinations include Eventhouse, a lakehouse (as
Delta), Activator, a derived stream, and a custom endpoint.

Operators are deliberately limited — this is a router, not a compute engine:

- **Filter** rows, **Manage fields** to rename/drop/change types.
- **Aggregate** over tumbling, hopping or session windows.
- **Group by**, **Union**, **Expand** (flatten arrays/JSON), **Join** between streams.

That limitation is a feature. If you find yourself chaining six operators to implement business
logic, move the logic into KQL with an update policy or into Spark structured streaming, and
let the Eventstream do what it is good at: buffering, routing, and fan-out to several
destinations at once.

Two design details cause most of the pain:

- **Partitioning and throughput.** Eventstream throughput is bounded by the capacity and by
  per-stream limits, not infinite. A burst of events that exceeds what the capacity can absorb
  backs up at the source, and the symptom looks like "Kafka is slow".
- **Serialisation.** JSON is convenient and expensive at high volume. Where the producer allows
  it, use a compact binary format such as Avro and define the schema, so downstream does not
  parse strings on every query.

## Eventhouse and KQL

An **Eventhouse** is a container for one or more **KQL databases**, built on the Azure Data
Explorer engine. It is optimised for append-heavy, time-series, semi-structured and free-text
data, and it will happily hold billions of rows while answering queries in seconds — provided
you use its physical design features rather than treating it as a table with indexes.

The three levers:

| Policy | What it controls | Why you care |
|---|---|---|
| Retention | How long data remains queryable | Primary cost control; expired extents are dropped |
| Caching (hot) | How much recent data stays on SSD | Query speed vs storage cost; older data is still queryable, just slower |
| Ingestion batching | How long the engine waits before sealing a batch | Latency vs efficiency; streaming ingestion trades both for freshness |

```kql
.create table VehicleEvents (EventTime:datetime, VehicleId:string, Speed:double, Region:string)

.alter-merge table VehicleEvents policy retention softdelete = 30d
.alter-merge table VehicleEvents policy caching hot = 7d
```

Queries are pipelines, and the shape of the query determines the cost:

```kql
VehicleEvents
| where EventTime > ago(1h)
| summarize avg_speed = avg(Speed), events = count()
          by VehicleId, bin(EventTime, 1m)
| where avg_speed > 90
| order by avg_speed desc
```

Filter on the time column first — that is what prunes extents. Pre-aggregate with
**materialized views** when the same rollup is queried repeatedly, and use **update policies**
to transform at ingestion time so consumers do not repeat the work:

```kql
.create materialized-view with (backfill = true) SpeedPerMinute on table VehicleEvents
{
    VehicleEvents
    | summarize avg_speed = avg(Speed) by VehicleId, bin(EventTime, 1m)
}
```

## Bridging real time and batch

By default, KQL data lives in the Eventhouse's own storage and is invisible to Spark, SQL and
Direct Lake. **OneLake availability** fixes that: it continuously mirrors KQL tables into Delta
tables in OneLake, making them readable through the SQL analytics endpoint, notebooks and
semantic models. Enabling it per database or per table is the single most important integration
decision in a Real-Time Intelligence design, because it determines whether your "real-time"
data can join the warehouse without a second pipeline.

The trade-off is latency and duplication: the mirror is near-real-time, not instant, and you
now store the data twice (KQL extents plus Delta files). Enable it for tables that BI and batch
actually need, not for every raw event table with a seven-day retention.

## When KQL is the wrong answer

KQL is not a general-purpose warehouse. It has no multi-table transactions, limited
`UPDATE`/`DELETE` semantics (it is append-first, with limited data-modification support), and
joins at very high cardinality are expensive. Do not put your customer dimension in it and do
not model your enterprise star schema there.

Use it for: telemetry, logs, clickstreams, IoT, security events, and any workload where the
query always has a time predicate. Use the lakehouse or warehouse for the conformed dimensions
you join against, and consider a shortcut from the KQL database to that Delta table.

## Common mistakes

- Using Eventstream as an ETL tool, then debugging business logic inside a no-code canvas.
- No retention policy on a raw event table, so storage grows forever while 95% of it is never queried.
- Forgetting OneLake availability, then building a second pipeline to copy KQL data into the lake.
- Querying without a time filter, which scans every extent and makes KQL look slow.
- Assuming exactly-once delivery. Design for at-least-once: deduplicate on an event ID at the
  silver layer, and handle late-arriving events explicitly.
- Dashboards built directly on raw streams instead of materialised rollups, so every refresh
  re-scans the same hour of events.

## Production notes

Budget latency end to end and write it down: producer → Eventstream → ingestion → query →
dashboard. Most "real-time" systems are 5–60 seconds, not milliseconds, and stakeholders should
know which. Alert on ingestion lag and on Eventstream backlog, not just on query failures.
Finally, keep the raw layer short-lived and the aggregated layer long-lived — it is both
cheaper and faster, and it matches how people actually ask questions about events.
