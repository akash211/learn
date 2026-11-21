# Parquet, ORC, Avro, Delta and the Boundaries of a File Format

Parquet solves a specific problem: representing typed data in a portable columnar file. It is not automatically the right representation for every stage of a data system. Comparing it with ORC, Avro and Delta becomes clearer when separating the physical file format from message formats and table protocols.

## Parquet and ORC

Both Parquet and ORC are columnar formats intended for analytical scans. Both support typed schemas, compression, encodings and metadata that can help skip data. Parquet has broad support across the modern data ecosystem and uses row groups, column chunks and pages. ORC organizes data into stripes and includes its own indexes and metadata model. The internal structures and features are not identical, so operational behavior depends on the engine and version.

Choose based on the consuming engines and capabilities that matter: nested type interoperability, filter/index behavior, codecs, writer libraries, schema conventions and warehouse support. A Hive-centered environment may have mature ORC tooling; a cross-engine lake may have wider Parquet interoperability. Do not assume a format wins solely because it is columnar or because one benchmark favored it on unrelated data.

## Parquet and Avro

Avro is row-oriented, schema-based serialization frequently used for event streams, Kafka payloads, data exchange and evolving records. It can encode a writer schema and support reader/writer schema resolution. Its row layout is natural for writing and consuming complete events. Parquet is generally a better fit for repeated analytical reads that select subsets of columns. A pipeline can sensibly use Avro at ingestion and convert to Parquet for a curated analytical layer.

That conversion is not merely a file extension change: it maps types, nullability, timestamps, nested values and schema evolution. Keep a schema registry or governance process for event contracts, and test the resulting Parquet schema with analytical readers.

## Parquet and Delta Lake

Delta Lake is a table format that uses Parquet data files plus a transaction log and protocol. The log records table snapshots and file actions, enabling atomic commits and features such as deletes, updates, merges, time travel and schema controls within supported implementations. Parquet alone has no transaction log and does not know which files form the current committed version of a table.

Delta table data files remain Parquet, but readers should read the table through a Delta-aware engine rather than globbing the directory as if all files were current. Old files may remain for retention or time travel; deletion vectors and protocol features can also affect how the logical snapshot is interpreted. A plain Parquet reader can see physical files without applying the table's log semantics.

| Need | Parquet alone | Delta Lake over Parquet |
|---|---|---|
| Columnar files readable by compatible engines | Yes | Yes, data layer |
| Atomic concurrent table commits | No | Yes, under protocol and storage assumptions |
| Merge/update/delete semantics | No | Table operations in supported engines |
| Snapshot/time-travel semantics | No | Recorded by transaction log |
| Read arbitrary raw path | File-based semantics | Must respect transaction log for table correctness |

Iceberg and Hudi are other table-format choices with their own metadata and interoperability model. Choosing among table formats is a separate decision from choosing Parquet versus ORC as a physical file format.

## When Parquet alone is wrong

Use a table format when multiple writers or readers need consistent snapshots, when jobs update or delete existing records, when schema changes need governance, or when compaction and retention must be coordinated safely. Use a row/message format such as Avro when records are independently produced and consumed as events. Use a database when the workload needs indexed point lookups, constraints and low-latency updates. Use a warehouse's native managed tables when operational simplicity and its execution model outweigh file-level control.

Raw Parquet is entirely reasonable for immutable, append-only datasets written to unique paths and published as complete batches, especially when a simple catalogue or manifest identifies the valid files. It is not deficient if those semantics meet the need. The mistake is assuming it provides capabilities beyond its specification.

## Portability has boundaries

An open format does not mean every feature is universally supported. Codec availability, timestamp interpretations, decimal precision, nested schema conventions, field IDs, encryption, statistics and page indexes vary by library and engine. Managed services can impose their own supported subset. The safest interoperability test uses files from the actual writer and reads them through every required consumer, including older versions.

Similarly, a Parquet directory is not necessarily a standards-defined table. Hive-style partition paths are conventions that many engines recognize, but discovery rules and schema inference can differ. Metadata stored in `_metadata`, `_common_metadata` or engine-specific files may accelerate discovery but is not a replacement for transaction semantics unless a table protocol defines it.

## Common mistakes

- Treating Delta as a compression codec or claiming that Delta replaces the Parquet data format.
- Reading every physical Parquet file under a Delta table path and including obsolete versions.
- Choosing between ORC and Parquet from a benchmark that does not represent the real readers and schema.
- Using Parquet as an event-message format simply because it is a familiar file type.
- Assuming “open” means identical behavior across all versions and codecs.

## Production notes

Choose each layer independently: event contract, file format, table protocol, catalogue and query engine. Document which reader is authoritative for mutable tables. Keep interoperability fixtures and test schema/codec compatibility at deployment time. If you need atomicity, deletions or concurrent commits, write through a table-aware engine and protocol; do not emulate transaction logs with ad hoc object renames or directory listings.

## A practical decision sequence

Start with the access pattern. If producers emit independent events and consumers process whole records, choose a message representation and schema contract suited to that exchange; Avro is a common example. If the main workload is repeated analytical scans over columns and time ranges, choose a columnar file format and organize it around those reads. Next ask whether the dataset is immutable or whether multiple writers must update a logical table. Mutable snapshots, deletes and merges call for a table protocol, not merely a different compression option.

Then evaluate the ecosystem. List every writer, reader, catalogue, warehouse and operational tool that must interoperate. Test real logical types, nested structures, statistics and codecs with the oldest supported reader. Compare ORC and Parquet on representative data only after the correctness and compatibility gates are clear. A small benchmark on one engine cannot establish that a format is suitable for every workload or deployment.

Finally, make ownership explicit. State which API is authoritative for reads, how files are published, who compacts, how old snapshots are retained, and what happens during a failed write. A raw Parquet path can be a clean, reliable interface when immutability and publication are controlled. A table format adds needed semantics when those conditions do not hold. The right answer is the simplest layer that meets correctness and operational requirements, not the most feature-rich stack by default.
