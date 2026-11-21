# Kafka Connect and CDC with Debezium

Kafka Connect is a framework for moving data between Kafka and external systems through reusable connectors. A **source connector** reads from an external system and publishes records to Kafka; a **sink connector** consumes Kafka records and writes them elsewhere. Connect owns task coordination, configuration, offset storage, error handling, and a REST management interface. It does not make every connector equally reliable: delivery and schema semantics depend on the source, sink, connector, and configuration.

## Workers, connectors and tasks

A Connect cluster runs one or more worker processes. In distributed mode, workers coordinate through Kafka topics: a config topic stores connector configuration, an offset topic stores source progress, and a status topic records connector/task state. Use appropriately replicated internal topics and protect them as production infrastructure. If workers fail, tasks can be reassigned; this improves availability but does not make external side effects exactly once.

A connector is a logical integration configured with properties such as connection endpoints, topic naming, converters, and task limits. A connector may divide work into **tasks**, which are the units Connect distributes across workers. More tasks can add parallelism only if the source/sink and connector support independent splits. A database connector may parallelize tables or partitions but still be constrained by a source snapshot, database connection limit, or schema lock. Increasing `tasks.max` without knowing the connector's division model may do nothing or overload the external system.

Connect's plugin path contains connector implementations and their dependencies. Install the same compatible plugin set on all workers, and restart or otherwise update workers consistently. A plugin class not found on one worker can create a connector that only fails when its task moves. Pin plugin and runtime versions, test upgrades, and keep credentials out of broadly readable configuration files. Connect's REST API is an administrative surface; restrict network access and authentication.

## Converters and data contracts

Converters translate between Connect's internal data model and bytes on Kafka. Common choices include JSON converters, Avro and Protobuf converters integrated with a registry, and byte-array converters. The converter is distinct from the connector: the connector fetches or writes records; the converter handles their representation. Schema-aware converters can preserve field types and schemas, while schemaless JSON can be easier to inspect but less explicit. Ensure all producers and consumers agree on the framing and schema strategy.

Single Message Transforms (SMTs) perform lightweight per-record changes such as renaming a field, adding metadata, routing a topic, or extracting a key. They are not a substitute for complex business transformations. A chain of opaque SMTs can make data hard to reason about, and a transformation that changes key semantics can alter compaction or partitioning behavior. Version and test transformations alongside connector configuration.

## Change data capture

CDC captures database changes from a transaction log or equivalent change stream rather than repeatedly querying a table for its current state. Debezium is a family of CDC connectors commonly run through Kafka Connect. A connector usually performs an initial snapshot, then streams ongoing changes from the database's log. The precise process is database-specific: permissions, log retention, replication slots, binlog settings, snapshot mode, and transaction metadata differ by engine.

A CDC event may include an envelope with operation type, before and after values, source metadata, and a log position such as an LSN or binlog coordinate. Consumers need to understand snapshots versus ongoing changes, deletes and tombstones, transaction boundaries, and schema changes. Debezium often emits a delete event and then a tombstone for compacted-topic behavior; the exact envelope and converter configuration must be verified for the deployed version. Never assume every CDC record is a simple row-shaped JSON object.

Initial snapshots and log streaming create operational concerns. A long snapshot can place load on the source database and may be interrupted. The connector must resume from a consistent position, while the source must retain enough log history for the connector's downtime. If a replication slot or binlog consumer falls behind and the database purges the required logs, the connector may not be able to continue without a new snapshot or recovery procedure. Monitor source log retention, connector lag, snapshot status, and database impact together.

## Delivery and errors

Connect source offsets represent progress in the source system, not offsets in the Kafka output topic. The connector periodically commits them according to its guarantees. If a task publishes records and fails before its source progress is committed, it may publish those records again after restart. Consumers must be able to handle duplicates or use a supported idempotence strategy. Sink connectors may write a batch and fail before committing Kafka offsets, so they can also repeat sink operations. “Exactly once” support is connector- and sink-specific; verify the documented semantics and the failure model rather than inferring it from Connect's framework.

Connect supports retries and dead-letter queues for certain errors. Configure retry limits, error tolerance, and DLQ behavior intentionally. Sending all conversion and data errors to a DLQ can keep the pipeline running while silently discarding important changes. DLQ records need topic, partition, offset, connector/task context and error metadata so operators can diagnose and replay them. For a stateful CDC stream, skipping one bad schema event may make later rows impossible to interpret; quarantine is not automatically safe.

## Connector lifecycle and schema changes

Connector configuration is production code, even when it is stored as JSON. Review changes to table include/exclude lists, topic naming, snapshot mode, converters, transforms, and error handling as carefully as application changes. A rename can silently move records to a new topic while consumers continue reading the old one. Keep connector configuration in version control with secrets injected at runtime, and compare the deployed configuration with the reviewed source after maintenance.

Database schema changes need a deployment order. A column addition, rename, type change, or table move may affect both the source connector's schema history and downstream deserializers. Coordinate database migrations with connector and consumer compatibility; test old and new schemas through the actual converter. For snapshot plus streaming, verify that downstream consumers can identify snapshot records and avoid applying them as if they were fresh updates when they rebuild state. Connector status alone is not proof of completeness: reconcile source row counts or transaction positions against emitted records.

## Common mistakes

- Treating `tasks.max` as a guaranteed worker or throughput multiplier.
- Assuming source offsets and Kafka consumer offsets are interchangeable.
- Ignoring database log-retention requirements for CDC continuity.
- Treating a DLQ as a substitute for data-quality alerts, ownership, and replay.
- Installing a plugin on only some workers or upgrading connectors without compatibility testing.
- Assuming a sink connector's “exactly once” claim includes the target's external transaction and all failure points.

## Production notes

Track connector and task state, source offset age, snapshot progress, Kafka publish rate, sink error rate, retry count, DLQ volume, worker rebalances, and database log-space pressure. Store connector configurations as reviewed deployment artifacts, but keep secrets in a secret provider. Before production CDC, test initial snapshot, restart during snapshot, broker outage, source log retention exhaustion, schema change, delete, and sink failure. Maintain a runbook that distinguishes safe restart from required re-snapshot; deleting connector offsets or replication slots without understanding their role can turn a recoverable lag incident into a full reload.