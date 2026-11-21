# Indexing Policies and Query Optimisation

Cosmos DB indexing is tightly connected to request charge: indexes can make reads efficient, but every indexed write has maintenance work and storage overhead. The native NoSQL API automatically indexes many item properties by default, which is convenient for evolving JSON shapes. That default is not a substitute for an explicit indexing policy. A write-heavy container can waste capacity indexing fields nobody queries, while a query's shape and partition scope determine whether the available indexes help.

## Index policy as a workload contract

A container's indexing policy controls included and excluded JSON paths and index kinds. The default policy generally indexes item paths broadly, excluding large or unsuitable values as configured by the service. You can narrow indexing to known paths for write-heavy workloads, or explicitly exclude large fields such as unqueried payload blobs. Excluding a path reduces index maintenance but makes queries that filter or order by that path less efficient or unsupported, depending on the operation. Changing a policy can trigger index transformation; plan for the time and service work required rather than expecting an instantaneous flip.

Define a query inventory first: predicates, sort order, projections, partition-key filters, frequency, result volume, and latency objective. For each query, measure actual request charge and latency with representative data. Then choose a policy that supports those paths. Composite indexes may be needed for combinations of filters and ordering that simple range indexes do not fully support. Spatial, vector, or full-text indexing has distinct configuration and feature requirements; treat those as specialized capability, and verify service status and API support before depending on a preview or newly released feature.

A point read by `id` and partition key is a different workload from a query filtering arbitrary JSON paths. Do not add indexes to optimize point reads. Conversely, a cross-partition query may be expensive despite a suitable index because it must contact several partitions. Partition targeting and indexing solve different parts of the problem.

## Read query plans through measurement

The NoSQL SDK exposes request charge and diagnostics for each query. Inspect query metrics where available to understand index utilization, retrieved and output document counts, and execution time by partition. Compare bytes and results returned, not just a single RU number. A filter that returns ten items after examining a large candidate set can consume significant work. Projection can reduce response transfer, while selective predicates and a partition-key equality filter reduce work at its source.

Use parameters and query shapes that match production, including common and skewed tenants. A query may be efficient for a small partition and costly for a global scan. Paginate large result sets with continuation tokens, and avoid loading all results into memory or restarting from the first page on each retry. Avoid client-side N+1 patterns that issue one point operation per result when a single well-scoped query or transactional batch fits better.

The query language may resemble SQL but has Cosmos-specific semantics. Joins in NoSQL queries operate over nested arrays within an item; they are not general relational joins across containers. `GROUP BY`, ordering, aggregates, and cross-partition behavior should be tested against actual API support and limits. Parameterize values to improve safety and avoid generating brittle dynamic query strings. Select only required fields when response payload size matters.

## Balance read efficiency with write and storage cost

Each write can update multiple index structures, so broad indexing has a write cost. A field that changes frequently and is never filtered, sorted, or otherwise indexed may be a candidate for exclusion. Large embedded objects may create many index entries even if the parent item itself is small enough. Indexing policy should reflect actual access patterns, not a theoretical wish to query any field in the future.

Conversely, removing indexes blindly can shift cost to full scans, increase latency, and make a path unsuitable. Maintain a test set of representative queries and compare before/after request charges, latency, and result correctness. Use a staged policy update and observe transformation progress, write behavior, and queries in flight. Keep a rollback policy or a safe migration plan when the change affects production-critical paths.

## Example investigation

Suppose an API filters by `tenantId`, `status`, and descending `createdAt`. First ensure the query passes the tenant partition key where possible. Capture diagnostics and RU charge for realistic volumes, and test whether the required composite index supports the filter and sort. Compare projected fields and page size. Then inspect whether the high cost comes from cross-partition fan-out, broad candidate selection, response size, or index transformation. Avoid concluding "index problem" solely because the request is slow; network round trips, retries, client-side buffering, or a hot physical range can dominate.

## Common mistakes

- Assuming automatic indexing makes every possible query cheap.
- Treating indexing and partition targeting as interchangeable optimization techniques.
- Keeping every path indexed in a high-write container without measuring the RU and storage impact.
- Removing an index because a query works on a tiny development dataset.
- Treating the SQL-like syntax as proof of relational join or optimizer behavior.
- Depending on preview index types without a fallback and verified availability.

## Production notes

Track RU charge, query latency, returned item count, diagnostics, 429s, and per-partition utilization together. Maintain an index-policy-as-code artifact and review it with query changes. Re-run workload tests when item shape, query patterns, SDK version, or index policy changes. Record which queries justify each non-default index path so future cleanup has evidence rather than guesswork.

## A repeatable query-tuning loop

Tune one query shape at a time. Save the query text, parameters, partition-key value, result size, SDK version, item distribution, request charge, and latency percentiles. Averages from a development container with a handful of items do not predict behavior when one tenant has hundreds of times more data. Use query diagnostics to compare retrieved, output, and index-hit information where available, and verify that the returned results remain correct after changing a policy.

When query charge is high, classify the cause before acting: broad partition routing, low-selectivity predicates, missing or unsuitable index paths, expensive sorting or aggregation, large response payload, or contention and retries. A narrower projection helps transfer and client memory, but does not necessarily eliminate the server-side search cost. A composite index may support a filter-plus-order shape but can add write overhead. If a query must aggregate across all tenants at high frequency, consider a maintained summary or analytical store rather than repeatedly running a broad operational query.

Roll out policy changes with a canary or controlled window. Observe index transformation progress, write charge, query charge, and throttling before expanding the change. Keep old policy and deployment steps available for rollback, while recognizing that policy reversal may itself require transformation. Include query review in schema and API code review: every new filter, sort, and projection should identify its partition scope and expected index behavior. This keeps index policy connected to actual application use rather than an unused catalog of possible paths.
