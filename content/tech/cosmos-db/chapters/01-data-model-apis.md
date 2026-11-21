# Data Model and APIs

Azure Cosmos DB is best understood as a family of APIs backed by managed distributed infrastructure, not as a single database that accepts every query language. The API chosen at account creation determines the client protocol, item model, query surface, and available features. That choice is an architectural commitment: migrating between APIs is usually a data-model and application migration, not a setting change.

## The native NoSQL model

The native Azure Cosmos DB for NoSQL API stores JSON items in containers. A database groups containers; a container is the unit for partitioning and usually throughput configuration. Each item has an `id` and a partition-key value, which together identify it within the container. Item operations include create, read, replace, upsert, patch, and delete. The SQL-like query language reads JSON paths and supports filtering, projection, joins over nested arrays, and aggregation, but it is not relational SQL: query scope, joins, transaction boundaries, and indexing differ.

A typical item models an application aggregate whose fields are commonly fetched together:

```json
{
  "id": "order-1042",
  "tenantId": "contoso",
  "status": "paid",
  "createdAt": "2026-05-16T10:30:00Z",
  "lines": [{ "sku": "p-7", "quantity": 2 }]
}
```

In the native API, the partition key is configured at the container level; each item carries the corresponding property value. A point read supplies both `id` and partition-key value and is generally the most direct access path. Queries can span partitions, but fan-out has additional work and latency. An item is not a row in a relational schema, and a cross-container query does not act like an ordinary SQL join across normalized tables.

Use embedded objects and arrays for bounded data that shares the parent's lifecycle and query pattern. Reference separate items for independently updated, shared, or unbounded children. This familiar modeling choice affects not only query count but also partition locality and transaction scope. Native NoSQL transactions, including transactional batch and stored procedures, are limited to one logical partition. If a workflow needs atomic updates across arbitrary entities, either redesign the aggregate boundary or use a relational system built for that invariant.

## The API family

| API | Main model and protocol | Design implication |
| --- | --- | --- |
| NoSQL | JSON items; native Cosmos SDK and SQL-like query syntax | Broadest native feature surface and strongest starting point for new Cosmos applications. |
| MongoDB | MongoDB wire-protocol compatibility; BSON/MQL-like client ecosystem | Compatibility is version- and feature-dependent; test operators, aggregation stages, indexes, and tooling. |
| Gremlin | Graph vertices and edges; Apache TinkerPop Gremlin traversal language | Model relationships as graph traversals and validate partitioning against traversal patterns. |
| Table | Key-value entities with `PartitionKey` and `RowKey`; Table SDK model | Often supports existing Azure Table Storage applications, but check query and entity semantics. |
| Cassandra | Cassandra-compatible protocol and CQL | Partition-oriented data modeling remains essential; verify the subset of Cassandra features required. |
| PostgreSQL | Separate distributed PostgreSQL service (Citus-based) | Azure Cosmos DB for PostgreSQL is on a retirement path; do not select it for new projects without current migration/status guidance. |

The NoSQL API was historically called the SQL API, and older material may use that name. It accepts a SQL-like language, but this naming should not lead to assumptions about relational guarantees, arbitrary joins, foreign keys, or transaction scope. Similarly, a MongoDB-compatible API implements a protocol surface; compatibility should be demonstrated against the exact driver and features your application needs. A successful connection string change proves connectivity, not semantic equivalence.

The Gremlin API suits graph-shaped data when relationships and traversals are first-class. A graph's partitioning still influences cross-partition traversal cost, and a graph query does not make every edge lookup local. The Table API retains a key-value access style. It can be useful for an existing Table workload that needs Cosmos capabilities, but a migration should test entity property typing, queries, continuation behavior, and limits rather than rely on source compatibility alone.

PostgreSQL requires an especially precise statement. Azure Cosmos DB for PostgreSQL is a distributed relational offering based on PostgreSQL and Citus, distinct from the native NoSQL service; Microsoft has announced its retirement path and directs PostgreSQL workloads toward Azure Database for PostgreSQL Elastic Clusters. The term "PostgreSQL API" in high-level API listings must not be interpreted as a generally available alternative interface on every NoSQL account. Check current service lifecycle guidance before migration planning.

## Choose an API by behavior, not familiarity

For a new workload, list required data semantics before selecting a familiar protocol: atomicity boundaries, query operators, consistency, secondary indexes, backup/restore, change capture, and regional write behavior. Prototype the most demanding queries and failure cases with the chosen API. Maintain a compatibility matrix for required SDK versions, service features, and deployment regions. If a feature is preview, make the dependency explicit and define a fallback.

An API migration also changes operational assumptions. MongoDB tools might connect yet differ in command support. A NoSQL query might incur cross-partition work even when its syntax looks like a database query. A Gremlin traversal could be expensive if it crosses partition boundaries repeatedly. Table-style code can depend on key ordering and property types. Keep API-specific repositories or adapters behind an application boundary where portability matters; do not hide meaningful consistency or transaction differences behind a false abstraction.

## Common mistakes

- Treating all APIs as alternate query languages over one interchangeable account and schema.
- Choosing a compatibility API solely because an existing driver connects.
- Designing a normalized relational model first and discovering that required cross-partition transactions are unavailable.
- Calling NoSQL's SQL-like syntax equivalent to SQL in join, constraint, and transaction behavior.
- Treating Azure Cosmos DB for PostgreSQL as the same product or lifecycle as the native NoSQL API.

## Production notes

Before committing, verify the exact API, account kind, region availability, SDK support, throughput model, backup capability, and feature status in current service documentation. Keep a small end-to-end test that exercises production-critical queries and write semantics. API-specific limits and compatibility evolve; a successful prototype on one version does not certify every operation in the application.

## API-specific design review

A practical API selection exercise starts with a short list of must-pass behaviors rather than a vendor feature matrix. For each required operation, record the request shape, expected response, transaction boundary, index requirements, and whether it needs a region-local result. Then create a representative dataset and exercise the operation through the production SDK. Include empty and missing fields, large arrays, unusual Unicode, duplicate identifiers, and realistic concurrency. These cases often reveal differences that a basic create/read test misses.

For a MongoDB migration, validate not only syntax but also command compatibility, retryable writes, transaction behavior, index creation, change streams, and operations tooling. For Gremlin, test traversal depth and graph locality against the chosen partition strategy. For Table, verify property types, key ordering, and continuation behavior. For Cassandra, check CQL restrictions and prepared statement assumptions. Keep compatibility tests in CI and rerun them on SDK or service changes.

PostgreSQL evaluations need a separate lifecycle gate: confirm the target service is actively supported for new workloads, check extension compatibility, and read the current migration and retirement notices. A page that lists an API does not by itself imply that it is recommended or available for every new deployment. A written decision should name the service, account kind, SDK, region, and verified feature set. This prevents the umbrella phrase “Cosmos DB” from hiding a material difference in protocol, lifecycle, and operating model.
