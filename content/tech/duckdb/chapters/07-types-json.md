# Types and Semi-Structured JSON

Type choices shape correctness as much as performance. DuckDB provides familiar scalar types alongside nested `LIST`, `STRUCT`, `MAP`, and `JSON` values. A CSV or JSON source may be schemaless at the file level, but queries still need rules for conversion, missing fields, precision, and time.

## Numeric, string, and temporal values

Use integer types for counts and identifiers only when their meaning is numeric. A postal code or account number with leading zeros is usually `VARCHAR`. Use `DECIMAL(p,s)` for exact decimal quantities such as currency when the precision and scale are known; `DOUBLE` is approximate floating point and can accumulate rounding error. Avoid casual casts that narrow precision or overflow silently in downstream systems.

Dates represent calendar dates, while timestamps represent instants or local date-times depending on their type and the source convention. Be explicit about time zones: parse offset-aware input consistently, convert to a canonical zone for storage or comparison, and test daylight-saving boundaries. A string that looks like a timestamp is not inherently a timestamp, and lexical ordering may not match chronological ordering when formats vary.

DuckDB has a `BOOLEAN` type, integer widths, `DECIMAL`, `VARCHAR`, `DATE`, timestamp types, binary and nested types. Inspect inferred schemas with `DESCRIBE` or the relevant table-function schema functions, then cast explicitly in production transforms. Schema inference is a convenience, not a substitute for validating source contracts.

## NULL is not the same as missing or empty

SQL `NULL` means unknown or absent value and propagates through many expressions. An empty string, zero, empty list, and JSON `null` are distinct values. CSV parsing may interpret configured strings as NULL; JSON may have an absent key or a key whose value is JSON null. A robust data model keeps those states distinct until the business rule chooses how to combine them.

Use `IS NULL`, `coalesce`, `nullif`, and explicit `CASE` expressions deliberately. `count(*)` counts rows even when fields are NULL; `count(field)` excludes NULLs. These distinctions frequently cause unexpected metrics when semi-structured records are flattened.

## JSON as data and JSON as text

DuckDB's `JSON` logical type validates JSON text and provides JSON functions; it can retain a payload while queries extract individual fields. The JSON value may contain an object, array, scalar, or null. Use functions such as `json_extract`, `json_extract_string`, `json_value`, `json_exists`, `json_type`, and `json_transform`/`from_json` where appropriate for the installed version. `->` and `->>` operators are also supported in current releases, but parentheses may be needed because the arrow has low precedence in expressions.

```sql
SELECT json_extract_string(payload, '$.customer.name') AS customer_name,
       json_extract(payload, '$.items') AS items
FROM raw_events;
```

The JSONPath string addresses a path; it is not SQL column syntax. `json_extract` returns JSON, while `json_extract_string` returns a string representation for the selected scalar. Casting that result to a typed column is a separate step. Validate malformed input and missing keys instead of assuming every record conforms.

For repeated analysis, transform a stable schema into nested or relational columns. `json_transform` can map JSON into a `STRUCT`/`LIST` shape, with strict variants available to error on incompatible casts. This offers typed access while preserving nested structure. If an attribute is frequently filtered or joined, promoting it to a typed column can make the contract clearer and may help execution. Keep the raw JSON when audit or forward compatibility matters.

## Lists, structs, and maps

A `STRUCT` is a fixed set of named fields that can be accessed with dot notation. A `LIST` stores repeated values and supports list functions and unnesting. A `MAP` represents key-value pairs where the key/value types are defined. These are native data types, not opaque blobs; they can be nested and stored in DuckDB tables and Parquet with compatible logical types.

`UNNEST` expands list elements into rows, which changes cardinality. If a record has three items, unnesting creates three rows; aggregating a parent-level amount afterward may triple-count it. Preserve a parent key and aggregate at the intended grain. Null lists, empty lists, and lists containing NULL elements should be tested as separate cases.

## Schema evolution and interchange

When reading a directory whose files come from different producers or dates, a column may be absent, change from integer to string, or change meaning while retaining the same name. Normalize with explicit projections and casts. For Parquet, test the reader's schema-unification behavior and establish a policy for added columns. For JSON, define how unknown fields are handled and whether strict conversion is required.

Dataframe libraries and other databases may represent decimals, nested values, and time zones differently. Before exporting Arrow or pandas results, inspect dtypes and null counts. A Python `object` dtype can obscure a mix of values; a successful fetch does not prove that a round-trip preserves types.

## Common mistakes and production notes

- Treating identifiers as integers and losing leading zeros.
- Using floating point for financial values that need decimal arithmetic.
- Confusing a missing JSON field with JSON `null`, SQL `NULL`, or an empty string.
- Extracting JSON fields as strings and assuming they are automatically numeric or date typed.
- Unnesting a list and accidentally changing the unit of analysis.

Build a schema-validation query at the ingestion boundary. Track type changes, malformed records, and missing required fields; decide whether to quarantine, reject, or coerce them. Test temporal zones and decimal boundaries in the target client, not only in SQL. Flexible types are powerful, but production pipelines become reliable when they turn flexible input into an explicit, versioned schema.

## JSON indexing and repeated extraction

Extracting several fields independently can repeat parsing work. Where performance warrants it, extract paths together using the supported path-list forms or transform once into a typed `STRUCT`; then project the typed fields used by joins and filters. Benchmark rather than assume an expression is cached.

JSON indexing has dialect-specific conventions: DuckDB JSON arrays use zero-based indexing in JSONPath, while SQL list indexing follows its own documented conventions. Verify exact paths with a fixture containing first, last, empty, and missing elements. This prevents off-by-one errors when translating code from another engine.

Keep raw payloads only when retention is justified. JSON can contain personal or secret values and inflate storage; apply access and retention controls as for relational data. Raw retention and typed projections can coexist, but need intentional policies.

## Design for useful typed columns

A practical pattern is to retain a raw payload with limited access, then build a curated relation with typed `event_time`, `customer_id`, and numeric measures. This gives schema evolution a clear boundary: new optional fields can be preserved in raw form while downstream queries rely on a documented curated schema. Version that transformation and test old and new payloads together before deploying it.

When converting nested data to Parquet, verify the consuming engines' support for nested types and field naming. A DuckDB `STRUCT` that works in one query may map differently in another library. For broadly consumed datasets, flatten stable high-value fields and keep the remaining payload as JSON only when consumers need it.
