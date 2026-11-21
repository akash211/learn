# Schema Management: Avro, Protobuf and Registry

Kafka stores bytes. A producer and consumer can both connect successfully while disagreeing about what those bytes mean. Schema management turns an informal convention into a versioned contract: fields, types, defaults, compatibility rules, and ownership are made reviewable. The goal is not to prevent change; it is to let producers and consumers evolve independently without silently corrupting meaning.

## Why schemas matter

Without a schema, a JSON record may omit a field, change a number into a string, or reuse a name with a new meaning. A consumer written months earlier may still parse the payload but calculate the wrong result. A schema provides a structural description and often a stable identifier embedded in or associated with each message. The consumer retrieves the matching schema and decodes the bytes according to the contract.

Avro, Protocol Buffers, and JSON Schema are common formats in Kafka ecosystems. Avro uses a compact binary encoding and supports reader/writer schema resolution, making it common with Kafka Connect and the Confluent ecosystem. Protobuf has generated language APIs and explicit field numbers; field-number reuse is dangerous because old data may be misinterpreted. JSON Schema can be easier to inspect but payloads are often larger. Kafka itself does not require a particular schema format or registry product.

Schema Registry is a service that stores schemas and subjects, assigns identifiers, and can enforce compatibility rules. Registries may be vendor implementations or open-source compatible services; APIs and features are not necessarily interchangeable in every detail. A Kafka broker does not automatically validate application payloads against a Registry unless an integration is configured. Producers and consumers typically use serializers/deserializers (SerDes) that communicate with the registry.

## Subjects and evolution

A **subject** is the registry's scope for versions and compatibility. Subject naming strategy affects whether schemas are tracked per topic, per record name, or another identity. The default topic-based strategy often creates separate key and value subjects for a topic. Record-name strategies can encourage reuse of a record contract across topics, but they also change the compatibility scope. Teams should decide this before a large dataset of subjects accumulates; changing the strategy later can make existing schema references difficult to manage.

Compatibility is directional. **Backward compatibility** means a new reader can read data written with an older schema. **Forward compatibility** means an old reader can read data written with a newer schema. **Full compatibility** combines both directions for adjacent versions, while transitive modes check against more than the immediately preceding schema. The names and exact rules depend on the registry and format, so inspect the actual registry configuration rather than relying on an assumption.

For Avro, adding a field with a default is commonly backward-compatible because a new reader can supply the default when old data lacks the field. Removing a field may be forward-compatible if old readers can ignore the extra field in new data, but compatibility depends on the mode and schema features. Changing a field type or changing a default can be unsafe even if the schema appears superficially similar. For Protobuf, adding a field with a fresh number is generally a safer evolution; never reuse a removed field number or name in a way that can confuse old binaries. Compatibility is not identical to business semantics: changing a currency unit from dollars to cents without changing the type may pass structural checks and still break consumers.

## Deployment order and consumers

A safe rollout normally considers both old and new application versions. For a new optional field, deploy consumers that can handle the field (and old messages), then deploy producers that populate it, and only later remove legacy handling if the whole ecosystem has migrated. For a breaking contract, create a new event version or topic and run an explicit migration rather than relying on a compatibility override. A registry's “compatible” response is useful but not a substitute for contract tests and consumer inventory.

Wire format details matter. Some SerDes prepend a magic byte and schema ID before the encoded payload; others use a different framing. A consumer without the matching SerDe may see binary bytes and conclude that Kafka corrupted the message. Do not write ad hoc decoders based on one sample. Test actual payloads across languages and client versions, including nulls, defaults, enum evolution, unions/oneofs, decimal precision, timestamps, and unknown fields.

Schemas for keys deserve special attention. Keys determine partitioning and compaction identity. Changing a key's encoding can route the same logical entity to a different partition or create a different byte-level key on a compacted topic. Preserve a stable canonical key representation, and treat any key change as a data-migration design rather than a harmless refactor.

## Registry operation and governance

Registry availability is often required during serialization or deserialization, although clients cache schema IDs and definitions. Decide what happens when the Registry is unreachable: can a producer continue using a cached schema, or must it fail closed? A producer that silently falls back to raw JSON defeats enforcement. Configure authentication, TLS, quotas, backups, and disaster recovery. Registry deletion and subject cleanup can break historical consumers if the schema definition is needed to decode retained data.

A schema review should ask: who owns this event, what does each field mean, which fields are optional, what are units and time zones, what is the key, which PII is present, and which compatibility mode is set? Include examples and semantic constraints in documentation. A schema is a technical contract, but the crucial questions are often semantic. Field names like `status` and `amount` are not definitions.

## Common mistakes

- Assuming Kafka brokers validate all records because a Schema Registry exists somewhere in the architecture.
- Treating backward compatibility as a guarantee that every deployed old and new consumer will behave correctly.
- Removing a schema version while retained records still refer to it.
- Reusing Protobuf field numbers or changing a key's wire representation casually.
- Treating a successful compatibility check as proof that units, meanings, and privacy obligations remain stable.
- Hard-coding registry URLs, credentials, or schema IDs in application logic without lifecycle management.

## Production notes

Keep compatibility checks in CI and require consumer-owner review for semantic changes. Maintain an inventory of topics, key/value subjects, owner, retention, sensitive fields, and registered schema versions. Test replay from old data with the current consumer, not just current producer to current consumer. During deployment, monitor serialization failures, unknown schema IDs, registry latency, and deserialization error rates by subject. Schema evolution is most reliable when old records remain readable and consumers can be upgraded independently; that is a system-level rollout property, not a property of one schema file.