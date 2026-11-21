# MERGE, Upserts and CDC Patterns

`MERGE` applies inserts, updates and deletes from a source relation to a target Delta table in one table transaction. It is the standard lakehouse primitive for upserts and many change-data-capture (CDC) pipelines. It does not solve source ordering, duplicate delivery or business-key design by itself. A correct merge depends on a deterministic source, a valid match key, an ordering rule and a well-bounded target search.

## How a merge works

Conceptually, Delta evaluates the merge condition to classify target/source row pairs and then applies the selected clauses. In Spark SQL:

```sql
MERGE INTO target AS t
USING staged_changes AS s
ON t.customer_id = s.customer_id
WHEN MATCHED AND s.op = 'DELETE' THEN DELETE
WHEN MATCHED AND s.sequence > t.last_sequence THEN UPDATE SET *
WHEN NOT MATCHED AND s.op <> 'DELETE' THEN INSERT *;
```

The actual syntax and wildcard rules vary with schema evolution settings and runtime. Spark's DeltaTable API also exposes merge builder methods. During execution, the engine identifies relevant target files, evaluates matching rows, writes replacement or newly added data files (or uses row-level mechanisms where supported), and commits file actions atomically. The target has a new version if and only if the transaction commits successfully.

A merge condition should express the logical key, not just a convenient partition column. If the same business key can appear multiple times in the source, merge may be ambiguous or nondeterministic. Deduplicate the source first using a stable ordering, such as source sequence number plus a deterministic tie-breaker. Normalize keys and resolve null semantics deliberately.

## CDC ingestion and idempotence

A robust CDC flow separates capture from application:

1. Land immutable source events with source system, primary key, operation, event/commit sequence, and ingestion batch identity.
2. Validate schema, deduplicate repeated deliveries, and select a deterministic latest change per key for the batch where appropriate.
3. Apply changes to the target, rejecting stale sequence values and handling deletes as tombstones or delete clauses.
4. Record processed source progress only when the target commit outcome is known.
5. Reconcile source offset/checkpoint and target state after retries or failures.

Delta's atomic table commit does not atomically commit an external Kafka offset or change the state of an orchestration system. If a batch is replayed, the merge must be idempotent: for instance, store the last applied source sequence and update only when the incoming sequence is greater. A repeated event then becomes a no-op rather than a second mutation. Include a deterministic event id to detect duplicate deliveries.

For streaming CDC, `foreachBatch` can execute a merge for each micro-batch. The callback can be invoked again after failure, so batch-level idempotence is essential. The target may commit successfully while the streaming checkpoint has not advanced; replay is expected behavior, not necessarily a Delta defect.

## SCD Type 1 and Type 2

**SCD Type 1** overwrites the current attribute values. It preserves only the latest state and is appropriate when corrections supersede history. The source should be reduced to one latest row per key, and stale events should not overwrite newer target state.

**SCD Type 2** preserves history by closing the active record and inserting a new version. Typical columns include `valid_from`, `valid_to`, `is_current`, and a source sequence. A change to an existing key needs an update to the current target row and an insert for the new values. Some teams use a staged “expire then insert” pattern or split a merge into carefully designed actions. The pipeline must guarantee one current record per key and handle late-arriving changes; a late event may require recomputing effective intervals, not simply inserting it as the newest version.

Type 2 is more than an upsert: it encodes temporal business semantics. A single source event may need to create a new version, close an old validity interval, and retain the raw CDC event for audit. Test duplicate, out-of-order, same-timestamp, delete/reinsert and key-change cases.

## Performance and correctness boundaries

Merge cost is often dominated by target files scanned, not by the number of source rows. Restrict the target using a safe partition predicate when possible, maintain useful file statistics, and stage a compact source. A predicate is only safe if it cannot exclude an existing target match. Partitioning by a date can accelerate a date-bounded merge but makes a global customer-key merge difficult when customers have rows across dates.

Deletion vectors or row-level concurrency can reduce rewriting or conflicts in supported environments, but change protocol compatibility and do not eliminate merge planning cost. OSS delta-spark supports core merge behavior, while optimizations and extensions may be specific to Databricks Runtime or vary by release. Read the exact API documentation for the running combination.

## Common mistakes

- **Merging raw CDC without deduplication.** Several changes to one key in one source batch create ambiguous matches or arbitrary state.
- **Using ingestion timestamp as source order.** Arrival order may differ from commit sequence, especially after retries.
- **Omitting a stale-event guard.** A delayed old update can overwrite a newer target row.
- **Assuming a successful job means one execution.** Streaming and orchestrators retry; idempotence must be designed.
- **Using Type 1 logic for Type 2 history.** Closing a prior row and inserting a new version are both required.
- **Adding broad partition filters blindly.** A filter that misses a valid target row can turn an update into an insert and create duplicates.

## Production notes

Capture `numSourceRows`, inserted/updated/deleted metrics when available, the target version, source offsets and batch id. Reconcile counts and key uniqueness after deployment. Make retries bounded and safe; alert when merge time or files touched grows sharply. Keep raw CDC long enough to rebuild the target, and regularly test a full replay or incremental recovery in a separate table.

## Build a merge test matrix

Before release, construct small fixtures that expose ambiguity: a new key, a matched update, a delete, two changes to one key in one batch, a duplicate event, an old event arriving after a new one, a null key, and a replay of the same batch. Assert both final values and invariants such as one row per business key. For Type 2, also assert interval boundaries and that only one row is current.

Use production-like target volume for performance tests. A tiny unit test can verify merge logic but cannot reveal a full-table scan, skewed hot key or a transaction conflict. Inspect the physical plan or operation metrics for target files touched and source shuffles. A safe optimization can then be separated from a semantic change. Keep raw changes immutable so that a bug in deduplication or ordering can be corrected by rebuilding, rather than trying to infer discarded history from the final dimension table.