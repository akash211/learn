# File Anatomy: Footer, Row Groups, Chunks and Pages

A Parquet file is self-describing enough for a reader to discover its schema and locate column data without an external index. Its on-disk structure is layered: file metadata points to row groups; each row group contains column chunks; each chunk contains pages. Knowing these boundaries is useful when diagnosing scan planning, parallelism, corruption and data skipping.

## The outer envelope and footer

A standard Parquet file begins and ends with the four-byte magic value `PAR1`. The data and metadata lie between them. The footer is serialized using Thrift compact protocol: it contains a `FileMetaData` structure, followed at the end by a four-byte little-endian footer length and the trailing magic bytes. A reader can therefore fetch the final bytes, learn the metadata length, then fetch and decode the footer without scanning from the beginning.

`FileMetaData` includes the format version, a schema element tree, row-group metadata, optional key-value metadata and writer information. The `SchemaElement` records include names, physical types, repetition types and logical type annotations where applicable. Each `RowGroup` describes its columns, total sizes and row count. A `ColumnChunk` locates its data and may include a dictionary page offset, encodings, codec, compressed and uncompressed sizes, and `ColumnMetaData`. Statistics may include minimum, maximum, null count and distinct count, subject to writer behavior, type semantics and compatibility limits.

The metadata may also include column and offset indexes. These structures can locate pages and help readers perform finer-grained filtering, but support varies across writers and readers. The presence of a metadata structure does not guarantee an engine consults it for a particular query.

Because the footer is at the end, a truncated file may have data bytes yet still be unreadable: the reader cannot discover required metadata. Similarly, concatenating files byte-for-byte is not a valid way to merge Parquet datasets. Each file has its own footer and metadata; use a Parquet-aware rewrite or table operation.

## Row groups: parallel scan units

A row group is a horizontal slice of rows across the file. If a file contains rows 0–N, each row group covers a consecutive range in the writer's input sequence. Within each row group, there is a separate column chunk for each stored leaf column. The chunks collectively represent the row group's rows.

A row group is important for scheduling and skipping. Engines commonly assign row groups or groups of row groups to scan tasks, though exact task construction is engine-specific. Very large row groups can reduce task-level parallelism and increase memory demands for decoding. Very small row groups add metadata overhead and can weaken sequential I/O. Writer defaults are not universal: Spark, Arrow and other implementations expose different controls and may have different defaults.

Do not confuse a row group with a directory partition. A directory partition is a higher-level dataset layout, often expressed as `event_date=2026-01-01/`. It separates files and can support partition pruning. A row group is a structure inside a file. Partitioning and row-group organization solve different problems.

## Column chunks and pages

A column chunk is the data for one column within one row group. It is the main unit that allows projection: when a query does not need `debug_payload`, a reader need not fetch that column's chunk. The chunk's metadata identifies its physical type, encodings and compression codec, and provides offsets and sizes needed to read it.

Chunks are divided into pages. A data page contains encoded values and, depending on the data-page version and encoding, repetition and definition levels for nested structures. A dictionary page, when used, stores dictionary entries for that chunk and is referenced by dictionary-encoded data pages. A column chunk can also have index structures, but those are metadata rather than ordinary value pages.

A page is a decoding and I/O unit, not a row. The number of values in a page can differ by column because nulls and nested repetitions affect the encoded streams. Writers typically build pages in memory and flush them according to size and buffering policy. Readers decompress and decode pages as required. Page boundaries can influence buffering and fine-grained skipping, but it is not safe to assume each page is independently scheduled as a distributed task.

## Metadata is useful but has limits

The footer can save enormous work, but it must be fetched. A reader that lists ten thousand files and opens every footer pays remote request and planning cost before scanning selected columns. Some engines cache file metadata or use catalog metadata; that behavior depends on engine and storage. One footer per file is a reason small-file proliferation hurts even when each file is only lightly scanned.

Statistics are not a semantic guarantee that every filter can be skipped. Min/max values can be absent, truncated for certain byte-array values, or unsuitable for a particular logical comparison. Null statistics and distinct counts may be omitted. Writers can omit statistics for privacy or correctness reasons; readers may treat ambiguous values conservatively. When a reader cannot prove a row group is irrelevant, it must read it rather than risk dropping valid results.

Parquet metadata includes key-value pairs, often used for writer-specific information or schema conventions. Applications should not treat arbitrary key-value metadata as a universally interpreted table contract. Likewise, the `created_by` string helps identify writer provenance but does not prove that every file from that writer has identical options or semantics.

## A useful mental diagram

```text
PAR1 | column data (row groups -> column chunks -> pages) | FileMetaData | length | PAR1
```

The exact offsets and serialization are specified by the format; the diagram is conceptual, not a promise that all chunks appear in a particular global order. The metadata provides offsets so readers can locate data. When inspecting a file with parquet-tools or library metadata APIs, look for schema, row-group count, per-column compressed sizes, codec, encodings, statistics and writer identification. Also record whether column indexes or offset indexes exist, but verify the engine actually uses them before attributing an observed skip to an index. Compare total compressed size with uncompressed size only as a descriptive file property; it is not a prediction of decoded memory for every query.

## Common mistakes

- Treating a file as a single opaque compressed blob; Parquet has independently described chunks and pages.
- Assuming every row group contains exactly the same row count or size.
- Assuming row groups, pages and directory partitions are interchangeable units.
- Copying only the data region and omitting the footer, or byte-concatenating files.
- Trusting missing or ambiguous statistics as if they proved no rows matched.

## Production notes

A metadata inspection can distinguish several failure classes. A valid footer with the wrong schema points toward a writer/schema issue; a file with no footer is likely incomplete; unexpected row-group counts or chunk sizes suggest writer layout; missing statistics explain absent pruning. Compare metadata from multiple output files, not only the first one, because a dataset may contain mixed writers, schemas, codecs or row-group layouts.
