# Encodings and Statistics

Parquet uses encodings to represent values compactly and statistics to describe groups of values. These are different mechanisms with complementary jobs. An encoding transforms typed values into a stream that is cheaper to store or decode; statistics summarize a region so a reader may decide not to read it. Both are scoped by column chunk or page, not magically applied to an entire dataset.

## Encodings transform value streams

Each data page declares an encoding for its values. The schema and page metadata tell a reader how to interpret the encoded bytes. Writers can choose different encodings for different columns or pages, and may switch away from an encoding when it stops being effective.

### Plain encoding

`PLAIN` stores values in a straightforward physical representation: fixed-width values in the type's specified form, byte arrays with length prefixes and their bytes, and so on. It is a baseline, not a failure. When values are high-cardinality or irregular, a more elaborate encoding may cost more than it saves. Compression can still reduce a plain stream.

### Dictionary encoding

Dictionary encoding builds a dictionary of distinct values for a column chunk, typically in a dictionary page. Data pages then store indices rather than repeating the full values. This works well for low-cardinality columns such as a status or region, and for repeated strings. If the dictionary grows too large, a writer may abandon dictionary encoding and use another encoding such as `PLAIN` for subsequent data pages. Dictionary is not guaranteed, and its effect depends on cardinality and writer policy.

The file metadata can list `PLAIN_DICTIONARY` or `RLE_DICTIONARY` as encodings; the latter is used in the current dictionary encoding scheme. Readers should use the declared page encodings rather than infer them from observed values. A common mistake is to assume a dictionary spans the entire file: it is associated with a column chunk, generally within a row group.

### Run-length encoding and bit-packing

`RLE` represents consecutive repeated values as runs. Repetition and definition levels used for nested data have their own hybrid representation that combines run-length encoding and bit-packing. Small integer values may be represented using fewer bits than the full machine type requires. Bit-packing fills groups of values into compact bit streams; RLE handles long runs of the same value. A hybrid can adapt to both repeated and varied sequences.

This is useful for boolean-like values, level streams, dictionary indices and other small integers. It does not mean every integer in every Parquet file is run-length encoded. The writer selects encodings according to column type and data patterns.

### Delta encodings

Delta encodings store differences between values or between byte-array prefixes rather than repeating full values. `DELTA_BINARY_PACKED` is designed for integer sequences with useful differences; `DELTA_LENGTH_BYTE_ARRAY` and `DELTA_BYTE_ARRAY` address byte-array lengths and common prefixes. Monotonic or locally correlated values such as sorted timestamps or increasing identifiers can benefit, but results depend on the sequence and implementation. These encodings are not a substitute for sorting: they compact a stream but do not by themselves guarantee useful min/max ranges for row-group pruning.

## Statistics summarize regions

Column chunk metadata may include statistics such as minimum, maximum, null count and distinct count. Page-level statistics may also be represented through page indexes when written. Statistics are hints for skipping, not indexes that return matching rows. For a predicate like `event_time >= t`, a row group whose reliable maximum is less than `t` cannot match. A row group whose minimum is earlier and maximum later may match, so it must be examined.

Their utility depends on physical layout. If rows are ordered by time, each row group's range may cover a narrow interval. If time is randomly distributed, every group can have nearly the full range and a filter skips little. Statistics are also data-type-sensitive: logical annotations and sort order matter, and legacy min/max representations for byte arrays have compatibility caveats. Writers may omit stats; values can be truncated; readers must handle unknowns conservatively.

Statistics also affect table metadata and optimizers outside the file reader. A catalogue's row-count or column statistics are not the same thing as per-file Parquet statistics. A query engine may use both, but refresh and reliability are separate concerns.

## Putting encoding and statistics together

Imagine a row group where `status` has three repeated strings and `event_date` is sorted. The status chunk may use a dictionary and compact indices; the date chunk may use an integer or delta-oriented encoding; min/max metadata on dates can exclude row groups outside a requested interval. The query still needs to decode matching rows and evaluate its condition. Encoding reduces representation cost; statistics reduce how much must be read.

| Feature | Main purpose | Typical scope |
|---|---|---|
| Dictionary encoding | Avoid repeated value bytes | Column chunk/page stream |
| RLE/bit-packing | Compact runs and small integers | Encoded value or level stream |
| Delta encoding | Store differences or shared prefixes | Encoded value stream |
| Min/max/null statistics | Prove some regions cannot match | Column chunk and optionally page index |

## Common mistakes

- Assuming dictionary encoding is always enabled or always wins. High-cardinality chunks may trigger fallback.
- Calling statistics a secondary index. They provide coarse bounds; they do not identify individual matching rows.
- Confusing compression codecs with encodings. Both may be applied, at different conceptual layers.
- Assuming min/max pruning works on a column merely because the column is present. Ordering, stats availability and reader support matter.
- Assuming `distinct_count` is always present or cheap to calculate.

## Production notes

Use metadata inspection to learn actual encodings and statistics rather than relying on configuration intent. Compare row groups from representative files and check whether selected predicates have useful min/max bounds. If pruning is poor, investigate sort order and writer stats before changing compression. If files have different writers, inspect each generation: schema-compatible files can still differ in encodings and available indexes.

## Reading statistics conservatively

Statistics are useful only when their comparisons match the logical type and the file's ordering rules. Numeric minima and maxima are intuitive, but byte-array values, legacy annotations, signedness and timestamp interpretation can make a naive comparison unsafe. A writer may omit a statistic, truncate a long string bound, or use a representation that older readers interpret differently. A correct reader must treat uncertainty as “may match,” not as permission to drop data. This is why a false negative in pruning is a correctness bug, while reading an extra row group is only extra work.

Statistics also summarize a scope, not a distribution. A group with `min=10` and `max=1000` says nothing about whether values are uniform, concentrated at endpoints, or mostly null. Null counts are separate from min/max, and SQL three-valued logic means null does not behave like an ordinary value in comparisons. Distinct counts, when present, are optional hints rather than a promise of exact cardinality.

When evaluating a writer change, inspect several groups across several files, including sparse partitions and outlier values. A single well-ordered sample can conceal random ordering in other partitions. Compare metadata before and after sorting, then run real predicates through the intended engine and check skipped-group and byte metrics. That ties the claimed benefit to evidence rather than a configuration flag.
