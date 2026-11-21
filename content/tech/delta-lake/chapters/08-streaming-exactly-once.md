# Streaming Integration and Exactly-Once Claims

Delta tables work with Apache Spark Structured Streaming as both sources and sinks. The combination is common: Kafka or another broker supplies events; Spark processes micro-batches; Delta commits each batch as a new table version. The transaction log gives readers a consistent committed table state, while the streaming checkpoint records query progress. These are separate pieces of state, and exactly-once behavior depends on how they interact.

## Delta as a streaming sink

A Structured Streaming query can write a DataFrame to Delta with `writeStream`. In Spark's supported integration, each micro-batch is committed to the table in a way designed to be idempotent under checkpoint-based recovery. If a query fails and restarts with its checkpoint, Spark can replay a batch; the sink's transaction identifiers help avoid applying the same micro-batch twice in the same query lineage.

That guarantee has boundaries. Deleting or changing the checkpoint directory creates a new query identity and can cause data to be replayed. Reusing a checkpoint for a different query is also unsafe. External side effects inside `foreachBatch`—HTTP calls, another database, a second Delta table or Kafka output—are not atomically committed with the Delta sink. Design those writes with idempotency keys, a transactional outbox, reconciliation or a platform-supported multi-table transaction mechanism.

A typical append sink is:

```python
(query.writeStream
 .format("delta")
 .outputMode("append")
 .option("checkpointLocation", checkpoint_path)
 .start(table_path))
```

For `foreachBatch`, the callback is invoked once per micro-batch attempt, not necessarily once forever. It may run again after failure. Use the batch id as an idempotency input where appropriate and make merge operations replay-safe.

## Delta as a streaming source

A Delta table can be read as a streaming source, allowing downstream queries to consume newly committed changes. The default source behavior and handling of initial snapshot, updates, deletes and schema changes depend on options and source mode. A plain append stream is straightforward when the upstream table is append-only. If upstream writers update or delete existing files, downstream readers may need Change Data Feed (CDF) or a specific policy for handling changes; a stream that assumes append-only input can stop or miss semantic updates.

CDF exposes row-level change records with metadata such as change type and commit version/timestamp in supported versions. It is useful for downstream incremental processing, but enabling it is a table feature and adds protocol compatibility requirements. It is not automatically a complete CDC archive: retention, starting version, schema changes and downstream checkpointing still matter. Databricks-specific options or optimizations should not be assumed to exist in OSS delta-spark or other clients.

## What “exactly once” actually means

Exactly-once claims are always scoped to a boundary. For a Spark query writing to Delta with a durable checkpoint, the sink can provide exactly-once effects for committed micro-batches under supported configuration and recovery assumptions. That does not guarantee a source itself never emits duplicates, that a user-defined function has no repeated side effect, or that several destinations commit atomically.

| Boundary | Typical guarantee or risk |
|---|---|
| Source to Spark | Depends on source connector, offsets and checkpoint recovery. |
| Spark micro-batch to Delta sink | Transactional/idempotent behavior is supported for the Delta sink when checkpoint and query identity are preserved. |
| `foreachBatch` external call | Callback can repeat; implement idempotency or deduplication. |
| Delta table A plus Delta table B | Two normal table commits can succeed/fail independently. |
| Delta plus Kafka offset / API | No implicit distributed transaction across systems. |

A good system is often “effectively once” through at-least-once delivery plus deduplication and idempotent application. Specify the invariant rather than relying on a slogan: for example, every source event id appears at most once in a curated table, and a source sequence can never regress the entity state.

## Operational requirements

Checkpoint storage must be durable, private to the query and protected from lifecycle deletion. Maintain a stable checkpoint path across restarts of the same query, and create a new one for a changed logical query. Monitor input rate, processing rate, micro-batch duration, commit latency, backlog, state-store size and small-file growth. A query can be logically correct while falling behind or producing files so small that downstream scans become expensive.

Micro-batch size affects file sizes and freshness. Trigger intervals that are too short may create a steady flood of small commits; overly long intervals increase latency and replay cost. Compaction or auto-compaction can help, but coordinate maintenance with active writers and confirm the feature exists in the chosen runtime. Streaming writes and clustering have version-specific limitations; do not assume every table layout is compatible with every streaming writer.

Schema changes need a rollout plan. A streaming query can fail when its source schema changes; restarting it without understanding the changed fields can corrupt a downstream contract. Keep checkpoints and schemas under version control where practical, and test restarts from the latest committed offset after upgrades.

## Common mistakes

- **Calling the whole architecture exactly-once.** The guarantee ends at the component that participates in the transaction.
- **Deleting a checkpoint to “unstick” a stream.** This can cause reprocessing, duplicate effects or skipped data depending on restart choices.
- **Putting non-idempotent work in `foreachBatch`.** A retried batch repeats the side effect.
- **Streaming from a mutable table as if it were append-only.** Updates and deletes need supported change semantics, often CDF.
- **Ignoring small files.** Correct micro-batches can still create costly table layout.

## Production notes

Write a recovery runbook that identifies source offsets, checkpoint location, Delta table version, and the safe replay procedure. Test failure after the Delta commit but before checkpoint progress is durable—the classic point where the batch may be retried. Verify row-level deduplication and external side effects after recovery, not only stream status. Document the exact Spark, Delta and connector versions because guarantees rely on their integration.

## Failure-injection tests

A healthy stream test should stop the process at several boundaries: after reading input but before a commit, after the Delta commit but before checkpoint progress is durable, and after an external side effect but before callback completion. Restart from the same checkpoint and verify that target rows are neither lost nor duplicated and that external effects are deduplicated. Also test checkpoint storage recovery and a deliberately new query identity to make replay behavior explicit.

Monitor progress per batch rather than only whether the query is marked active. A stream can be alive while processing more slowly than input arrives. Track input and processed rows, batch duration, commit latency, backlog, state-store growth and output file sizes. For a Delta source, decide how updates/deletes are represented; an append-only assumption must be explicit. When schema changes, coordinate source and sink rollouts so that the first batch with the new field has a compatible consumer. These tests turn “exactly once” from a slogan into an observable recovery contract.