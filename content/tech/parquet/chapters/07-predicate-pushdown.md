# Predicate Pushdown and Row-Group Pruning

“Predicate pushdown” can refer to several related but distinct optimizations. A query engine may move a filter close to the scan, translate it into a Parquet predicate, use partition values to exclude paths, use statistics to omit row groups, consult page indexes, or evaluate the remaining predicate after decoding. Calling all of these “pushdown” obscures what actually happened.

## What a reader can skip

First, projection pruning: if a query selects `account_id` and `amount`, the reader can avoid chunks for unrelated columns, subject to fields needed by filters, joins or expressions. Second, directory partition pruning: paths such as `day=2026-11-21/` may be eliminated before opening files. Third, row-group pruning: footer min/max/null statistics can prove that a row group cannot satisfy a predicate. Page indexes, when present and supported, can narrow access further within a column chunk. Each mechanism needs compatible metadata and reader support.

Suppose a row group has `event_day` minimum November 1 and maximum November 7. A filter for November 20 rules it out. A group spanning November 1 through November 30 cannot be ruled out even if only a few rows match. Statistics are exclusion tests, not row-level indexes.

## Physical order matters

If data is sorted or clustered by a frequently filtered field, adjacent row groups may cover disjoint or narrow ranges. A date filter can then skip most groups. If rows are randomly mixed, every group may have low and high values spanning the full domain. The same Parquet statistics are present but provide little benefit. Partitioning by date can exclude whole files, while sorting within date by a secondary field may improve row-group pruning for that field.

Ordering has tradeoffs: sorting large datasets can require expensive shuffles and may delay writes. The right key is determined by real filters and workload, not by a general desire to sort every column. One sort order rarely optimizes all predicates.

## Predicate eligibility and semantics

Readers push down only predicates they can safely represent. Simple comparisons on supported types are common candidates; casts, UDFs, complex expressions, collation differences, timezone semantics and null behavior may block or constrain pushdown. Even if a predicate is pushed into the reader, the engine may still re-evaluate it after decoding to preserve SQL semantics. A scan plan saying “pushed filters” does not prove that many row groups were skipped.

Null handling needs care. `IS NULL` may use null counts if available; a min/max range says nothing about null rows by itself. SQL comparisons involving null yield unknown, not ordinary true or false. For strings, statistics may be missing or truncated, and lexicographic ordering must match the logical comparison. Timestamps and decimals similarly depend on annotations and reader interpretation.

## Practical verification

Use an explain plan to verify that selected columns and filters reach the scan. Then inspect runtime metrics: input bytes, files opened, row groups read/skipped if exposed, scan time and returned rows. Compare with the unfiltered baseline where meaningful. Metadata inspection can show whether relevant column statistics exist and whether their ranges align with the predicate. Query-plan evidence, file metadata and runtime measures together are stronger than any single indicator.

A conceptual workflow:

```sql
SELECT account_id, amount
FROM read_parquet('s3://bucket/events/**/*.parquet')
WHERE event_day >= DATE '2026-11-01'
  AND event_day <  DATE '2026-12-01';
```

The actual SQL and reader syntax vary. The important parts are projecting only necessary fields, filtering on a typed raw column and verifying the physical plan and scan behavior.

## Multiple layers can compound

A well-designed scan may first select only paths for a date partition, then inspect footers to discard files or row groups based on statistics, then fetch only the column chunks needed. A query that projects a nested leaf may prune sibling leaves too. Conversely, `SELECT *`, directory enumeration of many small files, missing statistics and unclustered rows may erase much of the theoretical advantage.

Predicate pushdown is also different from indexes in a database. Parquet statistics are coarse, immutable descriptions produced during writing. They generally cannot support arbitrary point lookups efficiently in a poorly clustered dataset. For highly selective key lookups, a key-value store, sorted index, bloom filter, clustering layout or table-format data-skipping feature may be more appropriate. Bloom filters, when written and supported, can help some equality predicates but are not universal, and the reader must consult them.

## Common mistakes

- Assuming “pushed filter” means rows were skipped; it may only mean filter evaluation was delegated.
- Applying a function to the partition column and accidentally preventing directory pruning.
- Expecting random data to have narrow min/max ranges.
- Treating null counts, min/max and page indexes as interchangeable metadata.
- Assuming every Parquet reader supports the same statistics, bloom filters or page indexes.

## Production notes

Use realistic predicates and inspect actual files created by the production writer. If statistics are absent, enable or correct writer configuration only after checking the data type and compatibility. If statistics exist but ranges overlap, improve sort/clustering or partition layout where write cost is warranted. Avoid making claims about scan elimination from logical plans alone; confirm with bytes and runtime counters from the actual engine.

## Predicate shape and SQL correctness

A filter that looks simple to a person can be difficult for a reader to translate safely. For example, `cast(event_time as date) = ...` changes the expression being compared and can block direct statistics or partition matching. A half-open range on the raw timestamp column is often easier to reason about, but timezone conversion and timestamp semantics still matter. The engine may simplify some expressions; never assume it does so identically across versions.

Null predicates deserve special attention. `x = NULL` is not equivalent to `x IS NULL` in SQL. Min/max generally describe non-null values, while null counts summarize a separate property. For `NOT`, `!=`, or compound conditions, a reader needs to account for nulls and three-valued logic before it can rule out a group. Conservative readers may retain a group even when a human expects it to be empty. That is correct behavior if metadata cannot prove exclusion.

Similarly, string ordering and decimal/timestamp annotations must match the predicate's comparison semantics. Case-insensitive collations, locale-specific order, and casts can make byte-level min/max unsuitable. Readers should decline pruning if the comparison cannot be proven safe. This can make performance look less aggressive than expected, but correctness comes first. Use a query plan to find predicate translation, then examine the data type and file metadata to understand why a particular row group remained eligible.

## Verify pruning with controlled comparisons

A useful experiment keeps the query, selected columns, engine version and file set fixed while changing one layout property. Compare the original scan with a version sorted or clustered on the predicate field, and inspect footer ranges before timing. If the new files have narrower ranges but runtime bytes do not change, the engine may not consult those statistics or another layer may dominate. If bytes fall but total latency does not, planning, request overhead or decode CPU may be the bottleneck. This avoids mistaking correlation for causation.

Take care with tests that read only a single file or a warm cache. A table-level query can pay for listing and metadata from thousands of files even when the chosen row groups are selective. Conversely, one representative file may not capture skewed partitions with different ordering. Use several representative partitions and report both cold and warm behavior where relevant. Track returned row counts and checksums as well as scan metrics so an aggressive pruning change is not accepted at the expense of correctness.
