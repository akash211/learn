# Schema Evolution and Nested Types

Parquet files carry a schema in the footer, but a directory of files can contain different schema versions. Reading that directory requires a policy for reconciling the per-file schemas. The format describes fields and physical representations; applications and table formats determine which changes are acceptable, how names map, and whether old data should appear as null or be rejected.

## Physical types, logical types and annotations

Parquet's physical types include `BOOLEAN`, `INT32`, `INT64`, `INT96` (legacy timestamp representation), `FLOAT`, `DOUBLE`, `BYTE_ARRAY` and `FIXED_LEN_BYTE_ARRAY`. Logical types annotate how a physical value should be interpreted: for example, UTF-8 strings are byte arrays with a string annotation; dates and decimals have defined logical semantics; timestamps include unit and UTC-adjustment semantics. A physical type alone is not enough to understand meaning. `INT64` might be a count, an integer identifier or a timestamp depending on annotation and convention.

Older files may use legacy converted type annotations, and `INT96` timestamps are common in legacy Spark data despite being deprecated in the format's preferred model. Readers must be tested with actual historical files. Changing timestamp settings or decimal precision can alter semantics even if a scan still succeeds.

## Optional, required and repeated

In the schema tree, fields have repetition types: `REQUIRED`, `OPTIONAL` or `REPEATED`. Optional values can be null; required values cannot. Repeated values express repetition. Modern tooling exposes nested structs, lists and maps in language-native schemas, while the Parquet representation uses schema elements and levels to encode nested structure.

Nested encoding uses definition levels to express how much of a path is defined and repetition levels to indicate repeated boundaries. Consider an optional struct `user` with an optional `address` and a repeated `phones` list. A reader needs to distinguish a missing user, a present user with a null address, an empty phones list and a list containing a null-like element if the schema permits it. Definition and repetition levels retain those distinctions without writing a complete parent object for every leaf value.

This is the core idea associated with Dremel, the nested-column representation that inspired Parquet's approach: represent nested records as columnar leaf streams plus level information that preserves record structure. Projection can then read a leaf such as `user.address.city` without reading every sibling leaf, where the engine and writer support nested pruning.

## Evolution across files

A common compatible change is adding an optional field. Old files do not contain that field; a reader merging schemas may expose it as null for old rows. This requires schema merging or a table/catalogue schema that describes the field. It is not automatic in every engine and may add metadata-reading work.

Renaming a field is not universally equivalent to adding a new field. Parquet fields have names and optional field IDs; readers that do not use field IDs may treat a rename as removal plus addition. Changing a physical type, logical annotation, nullability or nested structure can break reads or silently alter interpretation. Dropping a field from new files leaves it in older files, so a dataset may still expose it when schemas are merged.

| Change | Typical risk |
|---|---|
| Add optional field | Often compatible if reader merges or uses a registered schema |
| Add required field | Old records lack a value; defaults or backfill are needed |
| Rename without stable field identity | May appear as a dropped and a new field |
| Widen/change type | Reader-specific conversion and possible precision loss |
| Change timestamp/decimal annotation | Semantic mismatch even where physical bytes remain readable |
| Reshape nested struct/list | May change levels and field paths; test old and new files |

A table format can provide a governed schema and evolution rules, but its guarantees are specific to that format and its enabled features. A collection of raw Parquet files has no global schema registry. A robust pipeline records schema versions and tests old and new files together.

## Lists and maps need careful interpretation

The Parquet specification's nested schema uses a three-level representation for standard lists: a group annotated as a list, a repeated wrapper group and an element field. Legacy two-level list encodings exist, and readers have historically made compatibility decisions for them. Maps are also nested groups with key/value structure and a repeated entry. Do not hand-author these schema trees casually; use mature libraries and inspect the resulting schema. The element name and wrapper conventions can affect how older readers interpret a file.

Language-level `None`, empty list and null list are not interchangeable. For a nullable list field, null means the list itself is absent; empty means present with no elements. Nested optional elements create further distinctions. Verify round-trips with the exact combinations relevant to the application.

## Common mistakes

- Treating physical type as full semantic type and ignoring logical annotations.
- Assuming schema evolution is globally automatic because Parquet files are self-describing.
- Adding a required field without supplying values for existing records.
- Assuming a field rename is handled by name matching across all readers.
- Collapsing null list, empty list and null element during a serialization round-trip.
- Assuming every query engine prunes nested leaf columns equally.

## Production notes

Maintain a schema compatibility test corpus: representative old files, new files, null-heavy nested values, timestamps, decimals and each consuming engine. Inspect both the logical schema shown by the library and the underlying Parquet schema elements, including repetition and logical types. If using a field-ID-aware table format, test its mapping behavior rather than assuming plain Parquet readers preserve it. For a high-risk type change, rewrite old data under controlled validation or expose a versioned field instead of relying on implicit coercion.

## Stable identity and multi-writer governance

Field names are convenient identifiers but are not always stable identities. Some table formats and schema systems can use field IDs to distinguish a renamed column from a dropped field plus a new one. Plain Parquet readers may ignore those IDs and resolve only by name. Therefore a file that appears correct in one engine can be misread or expose duplicate-looking fields in another. Decide which schema layer is authoritative and document what each consumer honors.

Multiple writers make this harder. If one job writes the new schema while another still emits the old schema, the dataset becomes mixed immediately. This can be safe for an optional addition when readers are prepared, but unsafe for incompatible type or nesting changes. A rollout sequence may first teach readers to accept both forms, then upgrade writers, then backfill, and only later remove legacy handling. A transactional table can coordinate schema changes at the table level, but does not automatically update every external consumer.

A useful test fixture records both the logical application schema and the Parquet schema metadata. Include field names, IDs if used, physical types, logical annotations, repetition types and nullability. Test a mixed directory, not only one file, and assert the resolved schema explicitly. If values are converted, test boundary values such as decimal precision, negative timestamps, empty collections and null parents. These details expose semantic drift that a simple “read succeeded” test misses.
