# Architecture: Storage, Compute and the Cloud Services Layer

Snowflake's defining decision is that it is not a database server. Nobody runs a process that owns both the data and the CPU that reads it. Storage is object storage, compute is a fleet of short-lived clusters, and the thing that ties them together is an always-on control plane. Almost every behaviour that surprises newcomers — why resizing is instant, why a second warehouse doesn't copy data, why a suspended warehouse still returns a cached result — follows from that split.

## The three layers

| Layer | What it does | Who operates it | Billed as |
| --- | --- | --- | --- |
| Database storage | Holds table data as micro-partitions in object storage | Snowflake | Storage volume, per TB per month |
| Compute | Virtual warehouses that scan, join, sort and aggregate | You | Credits per warehouse-second |
| Cloud services | Auth, RBAC, metadata, parsing, optimisation, transactions, result cache | Snowflake | Included; not warehouse credits |

The important asymmetry is that only one layer is yours to size. You cannot provision the cloud services layer, and you cannot make storage faster by paying more. What you control is how much compute exists, when it exists, and how much data each query is forced to read.

## Database storage

Table data is written into micro-partitions: immutable, columnar, compressed files in cloud object storage (S3, Azure Blob Storage or GCS depending on region and cloud). Each one holds roughly 50–500 MB of uncompressed data, and the rows inside are organised by ingestion order rather than by any key you choose. Snowflake maintains metadata per partition per column — the minimum and maximum value, the number of distinct values, null counts — and that metadata, not an index, is what makes queries fast.

Because partitions are immutable, an `UPDATE` or `DELETE` does not rewrite a file in place. It marks rows in the existing partitions and writes new partitions containing the new versions, with the old ones remaining until time travel expires. This is why heavy DML on a large table increases storage and degrades clustering at the same time: the table becomes a mixture of original and rewritten partitions.

There is no user-visible file layout, no tablespace, no index to rebuild. That is the trade: you give up control over physical design and get a system that reorganises itself — imperfectly, and only when you ask it to.

## Virtual warehouses

A virtual warehouse is an MPP cluster of compute nodes with local SSD and memory. Sizes run from `XSMALL` to `6XLARGE`, and each step doubles the number of nodes and therefore the credits consumed per hour. Sizes are not storage: a warehouse holds no durable data, and dropping one loses nothing.

```sql
CREATE WAREHOUSE wh_bi
  WAREHOUSE_SIZE = 'SMALL'
  AUTO_SUSPEND = 120
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

ALTER WAREHOUSE wh_bi SET WAREHOUSE_SIZE = 'LARGE';
```

That `ALTER` is a metadata operation. There is no data movement, no rebalancing, no waiting for a copy. New nodes join, the local cache starts cold, and the next query runs on the larger cluster. This is the sharpest difference from Redshift, where changing cluster size is a resize that moves data, and from a self-managed cluster where adding capacity is a project.

A warehouse caches table data on local SSD as it reads. That cache is per warehouse, invisible, and dropped when the warehouse suspends — which is the single most common explanation for "it was fast yesterday". A `RESUME` does not restore it.

Concurrency is handled by adding warehouses, not by tuning queues. Two teams reading the same tables get two warehouses and no contention; the data is shared, the compute is not. Multi-cluster warehouses go further and start additional clusters of the same warehouse automatically when queries begin to queue, which is an Enterprise feature.

## The cloud services layer

Everything a client touches before a warehouse does any work lives here: authentication and session management, role and privilege evaluation, metadata services, the parser and optimiser, transaction and lock management, and the result cache. It is a multi-tenant service that Snowflake runs; you cannot see or size it, and it does not consume your warehouse credits.

Two consequences follow. First, a query that is answered from the result cache never starts a warehouse at all — the work happens in this layer. Second, a warehouse sitting idle proves nothing about availability: if the services layer is degraded, connections fail, metadata lookups stall and queries error before reaching compute.

## The life of a query

1. The driver connects over HTTPS, authenticates, and sets a session context — role, warehouse, database, schema.
2. The statement is parsed and compiled. The optimiser asks the metadata service which micro-partitions could contain matching rows and eliminates the rest.
3. The compiled plan is dispatched to the warehouse. Nodes read the surviving partitions from object storage, exchange rows over the internal network for joins and shuffles, and aggregate.
4. Results stream back to the client and are also written to the result cache, keyed by the statement text and the data version.

Step 2 is where most performance is won or lost, and it happens before any compute is spent. A predicate the optimiser cannot map onto partition metadata forces a full scan no matter how large the warehouse is.

## What the separation buys, and what it costs

The benefits are real: independent scaling, workload isolation without copies, instant resize, storage that grows without a maintenance window, and point-in-time recovery built into the storage layer rather than bolted on with backups.

The costs are equally real. Every scan crosses a network from object storage into compute, so per-query latency is higher than a local disk for small reads; that is why Snowflake is bad at the single-row lookup an OLTP database does trivially. Warehouses take seconds to start, so a workload that suspends aggressively pays a resume penalty on the first query. And because there are no indexes, a query that cannot prune reads everything — the cluster size determines how fast it reads everything, not how much.

## Editions change the feature set, not the architecture

Standard, Enterprise and Business Critical run the same engine. What changes is which capabilities are unlocked: longer time travel, multi-cluster warehouses, masking and row access policies, materialized views, search optimisation, replication and private connectivity are Enterprise and above. Design decisions that depend on those features should be made with the edition in hand, because a pattern that relies on row access policies does not degrade gracefully on Standard.

## Common mistakes

- Treating warehouse size as a proxy for storage or for table size. A bigger warehouse reads the same partitions faster, not fewer.
- Assuming a suspended warehouse loses data. It loses only the local disk cache.
- Blaming "the cloud services layer" for queueing that is actually warehouse concurrency — check `QUERY_HISTORY` for `QUEUED_OVERLOAD` and `QUEUED_PROVISIONING`.
- Running several unrelated workloads on one large warehouse and calling it isolation because they are different schemas.

## Production notes

Name warehouses by workload, not by size, so that cost reports mean something: `WH_LOAD`, `WH_BI`, `WH_DS`. Set `AUTO_SUSPEND` explicitly — if you omit it in DDL, the warehouse does not suspend on its own. Keep `INITIALLY_SUSPENDED = TRUE` in deployment scripts so that a `CREATE OR REPLACE` does not silently start billing. And watch `WAREHOUSE_METERING_HISTORY` alongside `QUERY_HISTORY`: a warehouse that is running with no queries is the most common form of waste, and it is invisible in any query-level dashboard.
