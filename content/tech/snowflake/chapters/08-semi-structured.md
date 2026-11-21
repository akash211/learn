# Semi-Structured Data: VARIANT, FLATTEN and Schema Evolution

Most Snowflake tables in the wild hold at least one `VARIANT` column. Application events, webhooks, vendor payloads and change streams all arrive as JSON, and the tempting move is to dump the whole document into a column and query it with dot notation. That works, until the table is a terabyte and every query scans all of it.

## VARIANT is a typed container, not a string

```sql
CREATE TABLE raw.events (
  event_id    STRING,
  received_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  payload     VARIANT
);

COPY INTO raw.events (event_id, payload)
FROM (
  SELECT $1:id::string, $1
  FROM @raw.events_stage
)
FILE_FORMAT = (TYPE = JSON);
```

`VARIANT` stores a parsed value — object, array, string, number, boolean or null — in an internal binary representation, up to 16 MB per value. `OBJECT` and `ARRAY` are the typed variants of the same idea, and the newer structured types (`ARRAY(STRING)`, `OBJECT(customer_id STRING, total NUMBER)`) let you declare a schema over semi-structured data and get real type checking.

Access is by path:

```sql
SELECT
  payload:event_type::string            AS event_type,
  payload:customer.id::number           AS customer_id,
  payload:items[0].sku::string          AS first_sku,
  payload:"Weird Key"::string           AS weird
FROM raw.events;
```

Paths are case-sensitive: `payload:EventType` and `payload:event_type` are different keys, and an unquoted path is matched exactly rather than folded to upper case. A missing key returns SQL `NULL` — which is convenient and hides typos, because `payload:cutomer_id` is also `NULL` rather than an error.

Casting is where the errors live. `payload:total::number` raises an error if the field holds `"n/a"`, aborting the query. `TRY_CAST(payload:total AS number)` returns `NULL` instead. Use `TRY_CAST` for anything arriving from outside your control, and let `NULL`-handling downstream be explicit.

## FLATTEN turns arrays into rows

A path can reach into an array element, but it cannot turn a list into rows. `FLATTEN` does that, as a lateral table function:

```sql
SELECT
  e.event_id,
  f.index            AS item_index,
  f.value:sku::string AS sku,
  f.value:qty::number AS qty
FROM raw.events e,
LATERAL FLATTEN(input => e.payload:items) f
WHERE e.payload:event_type::string = 'order_placed';
```

`FLATTEN` emits one row per element with `SEQ` (input row sequence), `KEY` (object key, null for arrays), `PATH`, `INDEX` (array position), `VALUE` (the element as `VARIANT`) and `THIS` (the input to the function). For objects, iterate with `f.key` to turn a map into rows.

Two rules keep this from exploding. Filter before you flatten, not after: the join multiplies rows, so a predicate on `event_type` applied outside the flatten still forces the multiplication to happen first. And be careful with nested arrays — one flatten per level, or `RECURSIVE => TRUE` with `MODE => 'BOTH'` when the depth is unknown, which is powerful and easy to make quadratic.

## Why VARIANT queries get slow

Snowflake stores a `VARIANT` column in a columnar layout and automatically extracts frequently occurring keys into their own internal columns, so `payload:event_type` is not as expensive as parsing JSON per row. But the optimiser cannot prune on a path the way it prunes on a typed column: micro-partition metadata is kept per column, and `payload` is one column. A filter on `payload:tenant_id` reads every partition unless something else narrows it first.

Three fixes, in order of preference:

1. **Materialise the hot paths.** Extract the fields that appear in filters and joins into real typed columns at load time, or in a view over the raw table. `tenant_id STRING AS payload:tenant_id::string` in a view gives the optimiser a column with metadata, and clustering on it becomes possible.
2. **Cluster on the expression.** A clustering key can use an expression, including a cast from a path, when the access pattern is stable and the table is large.
3. **Use the search optimisation service** for equality and substring predicates on `VARIANT` paths. It is a separate Enterprise service with its own credits, and it is the right tool for "find documents containing this value" rather than for range scans.

The anti-pattern is a reporting layer that does `SELECT payload:...` across forty paths for every chart. Each path is cheap; forty of them across a billion rows is a full scan with a lot of extraction work, and it will never prune.

## Schema evolution

The whole point of landing JSON is that the shape changes without warning. Snowflake has three mechanisms for coping:

**Infer and declare.** `INFER_SCHEMA` reads a set of staged files and returns a column list with types, which you can feed into a `CREATE TABLE` or a `COPY` with `MATCH_BY_COLUMN_NAME`:

```sql
SELECT * FROM TABLE(INFER_SCHEMA(
  LOCATION => '@raw.events_stage',
  FILE_FORMAT => 'raw.parquet_fmt'
));
```

**Match by name on load.** `COPY ... MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE` loads columns by name, so a new field is ignored rather than shifting every value. Combined with schema detection for Snowpipe, this is how a Parquet feed can add columns without breaking the load.

**Evolve the target.** For Iceberg tables, `ALTER ICEBERG TABLE ... SET ENABLE_SCHEMA_EVOLUTION = TRUE` lets new source columns appear in the table automatically. For native tables there is no automatic column addition — the table's schema is fixed, and new keys simply live inside `VARIANT` until you promote them.

That last point is the design decision. A `VARIANT` column is schema-on-read: flexible, cheap to land, expensive to query precisely. A typed table is schema-on-write: a load fails when the shape is wrong, and every query prunes. Most mature pipelines use both — a raw `VARIANT` landing table that is immutable and replayable, and a modelled typed table built from it, where the hot paths live as columns.

## Common mistakes

- Comparing `payload:total` to a number without casting. The `VARIANT` comparison has different semantics than a numeric one, and the result can surprise you on mixed types.
- Building a `FLATTEN` over an array and then `DISTINCT`-ing the result to remove duplicates caused by the flatten itself. Deduplicate by key before flattening.
- Relying on `SELECT *` from a table with `VARIANT` — it returns the document as JSON text and defeats column pruning.
- Assuming a missing path is an error. It is `NULL`, and a typo in a filter silently returns zero rows rather than failing.
- Loading JSON with `STRIP_OUTER_ARRAY = FALSE` when the file is a top-level array, then wondering why each row is the whole array.

## Production notes

Keep the raw layer as `VARIANT` with an ingestion timestamp and the source file name; never overwrite it. Build typed models from it with `TRY_CAST`, and log rows that fail the cast into a quarantine table with the original payload. Monitor the size of `VARIANT` columns — a document that grows unboundedly (an audit log appended to every event) eventually approaches the 16 MB limit and makes every scan expensive. And promote a path to a real column the second time someone writes a filter on it.
