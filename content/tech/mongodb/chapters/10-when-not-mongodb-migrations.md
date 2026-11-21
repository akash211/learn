# When Not to Use MongoDB and Migration Stories

MongoDB is a strong fit when the application naturally works with bounded documents, needs flexible nested records, and benefits from atomic updates within those documents. It is not a universal replacement for relational databases. Choosing it well includes recognizing when relational constraints, joins, and reporting are the simpler and safer design.

## When a relational database is the better default

Prefer a relational system when the core model has many entities connected by complex relationships, when joins are central to ordinary requests, or when correctness depends on foreign keys, unique constraints across related tables, and multi-row transactions. SQL lets analysts combine data in ways the original application did not anticipate; a document shape often optimizes known access patterns instead. If the product needs ad hoc reporting across many dimensions, complex aggregation across separately managed entities, or widespread BI tooling, relational storage may reduce duplicated data and application-side join logic.

MongoDB transactions exist, including across documents and shards, but their availability does not erase the document model's trade-offs. If nearly every write transaction updates many separately stored entities, the data model may be fighting the engine. Likewise, schema flexibility can become an uncontrolled collection of incompatible records if validation and migration practices are missing. A relational database also supports JSON columns and flexible extensions, so “we have JSON payloads” alone is not a reason to leave SQL.

Other workloads may point elsewhere: graph databases for deep traversals and relationship-centric queries; key-value stores for extremely high-throughput simple lookups with a narrow access pattern; columnar warehouses for broad analytical scans; search engines for advanced relevance, fuzzy matching, and text analytics; time-series or event platforms for specialized high-volume retention and streaming semantics. Some systems complement MongoDB rather than replace it.

## Migration from SQL to MongoDB

A migration should begin with evidence, not a JSON conversion script. Inventory tables, constraints, query patterns, transaction boundaries, data volume, and the reporting ecosystem. Identify aggregates that are commonly fetched and changed together, and determine where embedding is bounded. Keep high-cardinality relationships and independent lifecycles as references or separate collections. Decide which SQL constraints move into MongoDB validators, unique indexes, and application checks, and what consistency is lost or must be rebuilt.

A staged migration often uses dual-read or dual-write only temporarily, with a clear source of truth and reconciliation process. Bulk backfill in restartable batches, make writes idempotent, capture changes during the backfill, compare row/document counts and business invariants, then shift reads gradually. Do not claim success because documents parse: compare representative query results, aggregates, null/missing semantics, numeric precision, timestamp/time-zone handling, and referential integrity. Keep rollback possible until the new system has carried representative production load.

## Migration from MongoDB to SQL

The reverse migration often follows accumulated product requirements: more cross-entity reporting, stronger constraints, a richer join model, or analytics tools built for SQL. Begin by mapping nested arrays and repeated values into child tables, deciding whether each duplicate is a historical snapshot or a normalized entity, and identifying fields that vary in type or are absent. Define deterministic keys and foreign-key repair rules before loading.

A robust process exports a stable snapshot, replays changes after the snapshot, normalizes and validates types, and reconciles counts and invariants. Build indexes and constraints in stages where the target engine allows it. Query behavior must be ported, not translated mechanically: MongoDB's array operators, missing-field rules, and aggregation expressions do not map one-to-one to SQL. Keep an explicit mapping for decimals, dates, ObjectIds, binary values, and schema versions.

## Common mistakes

- Treating MongoDB as “SQL but without schemas” and expecting foreign keys or joins to behave the same.
- Migrating based on document-shaped API payloads instead of workload and invariants.
- Building giant documents to avoid joins, then discovering size, update contention, and unbounded growth.
- Backfilling without change capture, reconciliation, or a rollback window.
- Ignoring analytics and operational skills as part of total cost of ownership.

## Production notes

The right choice is the database whose consistency model, query language, operations, and ecosystem fit the product's actual workload. Compare whole-system costs: schema design, application logic, reporting, backups, failure recovery, scaling, and team expertise. A polyglot architecture can be justified, but every additional datastore creates synchronization and operational responsibilities. Prefer the simplest system that satisfies the requirements and revisit the choice when those requirements change.
## Make the decision with a workload matrix

Compare candidate databases against concrete operations rather than slogans such as “document flexibility” or “ACID.” For each important request, record its filters, joins, sort, transaction boundary, expected cardinality, freshness requirement, and growth. A catalog page that loads one product with bounded variants may be document-shaped; a finance report joining invoices, accounts, and audited adjustments across arbitrary periods may be simpler in SQL. Also include writes, retention, index costs, and who will operate and debug the system. A workload matrix makes it visible when one storage model serves a small number of known access patterns versus when users need new combinations of data at query time.

A relational database can store JSON columns for sparse attributes while keeping identities, constraints, and joins relational. MongoDB can use validators, unique indexes, transactions, and aggregation. Compare the actual complexity of enforcing invariants in each system, including how a developer discovers and handles invalid references. “It can be done” is not the same as “it is the least risky design.” If a service already runs both databases, account for duplicated data, reconciliation, access control, backups, and on-call expertise before adding another one.

## A staged migration with explicit gates

A safe migration has measurable gates: source snapshot consistency, completed backfill, replay lag at zero or an agreed threshold, invariant reconciliation, shadow-read agreement, canary traffic, and a rollback window. Define how writes are captured during backfill, where the source of truth resides at each stage, and how duplicate or out-of-order changes are resolved. Backfill in bounded, restartable ranges with checkpoints and idempotent writes; throttle it when it harms production. Compare more than row counts: check monetary totals, null versus missing semantics, time-zone interpretation, decimal precision, uniqueness, and representative user-visible queries.

Cutover should be reversible for a defined period. If dual writes are used, make partial failures detectable and reconcile both directions; otherwise prefer one authoritative writer and a controlled replication path. Keep old data until the target has served real traffic and recovery has been rehearsed. Set an explicit abort threshold for latency, error rate, reconciliation drift, or backlog rather than deciding under pressure.

The reverse migration needs the same rigor. Normalize nested arrays only where their lifecycle and query behavior justify child tables, preserve historical snapshots intentionally, and clean inconsistent types before enforcing constraints. The best outcome is not always a wholesale rewrite: a relational source of truth plus a document-oriented read projection may serve both integrity and a high-volume page, provided synchronization delay and failure recovery are explicit.
