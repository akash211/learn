# JSONB and Semi-Structured Data

PostgreSQL has two JSON types and they are not interchangeable. `json` stores the exact text,
including whitespace, key order and duplicate keys; it is validated on input and parsed on every
access. `jsonb` parses on input into a binary tree, discards whitespace and duplicate keys, sorts
keys, and can be indexed. For anything you query, `jsonb` is the type you want. `json` is for
round-tripping a document byte-for-byte, which is rare.

## Storage and what it costs

`jsonb` is a varlena type stored inline in the tuple until it exceeds roughly 2 kB, at which point
TOAST compresses it and, if still large, moves it to a side table. Every access to an out-of-line
value detoasts and decompresses it, so a 50 kB document costs that work on every read — even if
you only touch one field. Numbers inside `jsonb` are stored as `numeric`, which is exact and
noticeably bulkier than a `float8` column.

Two consequences follow:

- A `jsonb` column is a poor home for values you filter, join or sort on. Those belong in real
  columns with real types and indexes.
- Updating one key rewrites the entire document, producing a new tuple and new TOAST chunks. A row
  that is updated every second should not carry a large document that is mostly static.

## Operators

| Operator | Returns | Example |
| --- | --- | --- |
| `->` | `jsonb` element | `payload -> 'items'` |
| `->>` | `text` element | `payload ->> 'status'` |
| `#>` | `jsonb` at path array | `payload #> '{a,b}'` |
| `#>>` | `text` at path | `payload #>> '{a,b}'` |
| `@>` / `<@` | containment | `payload @> '{"status":"open"}'` |
| `?` / `?|` / `?&` | key existence | `payload ? 'refund_id'` |
| `||` | shallow merge | `payload || '{"v":2}'` |
| `-` / `#-` | delete key / path | `payload - 'temp'` |

The `->` versus `->>` distinction is the most common source of wrong answers: `payload -> 'x'` is a
`jsonb` value, so comparing it to a string compares types, while `payload ->> 'x'` is `text` and
compares as you meant. `WHERE payload -> 'x' = '"yes"'` works but nobody should write it.

## SQL/JSON: jsonpath, and 17's standard functions

Since 12, `jsonpath` gives you predicates and navigation:

```sql
SELECT jsonb_path_query(payload, '$.items[*] ? (@.qty > 2)')
FROM orders WHERE payload @? '$.items[*] ? (@.qty > 2)';
```

`@?` and `@@` are the indexable forms; the `?` operator tests keys, not values.

PostgreSQL 17 added the SQL/JSON constructors and query functions from the standard, which replace
a lot of hand-rolled lateral joins:

```sql
SELECT o.order_id, j.sku, j.qty
FROM orders o,
     JSON_TABLE (o.payload, '$.items[*]'
       COLUMNS (sku text PATH '$.sku',
                qty int  PATH '$.qty')) AS j
WHERE o.created_at >= '2026-01-01';
```

`JSON_VALUE` extracts a scalar with type conversion, `JSON_QUERY` extracts a JSON fragment,
`JSON_EXISTS` is a boolean predicate, and `JSON_TABLE` shreds an array into rows in one node. They
are more portable than the `->>` chain and, more importantly, they express intent — but they are
not automatically faster than `jsonb_array_elements`.

## Shredding arrays into rows

The pre-17 idiom is still everywhere, and it is a lateral join in disguise:

```sql
SELECT o.order_id, item ->> 'sku' AS sku, (item ->> 'qty')::int AS qty
FROM orders o, jsonb_array_elements(o.payload -> 'items') AS item;
```

`jsonb_to_recordset` gives typed columns and is often faster than repeated `->>`:

```sql
SELECT o.order_id, x.*
FROM orders o,
     jsonb_to_recordset(o.payload -> 'items') AS x(sku text, qty int, price numeric);
```

Both multiply rows. A document with 40 items turns one order into 40 rows *before* any aggregation,
so a `SUM` over a 10-million-row table with array documents may aggregate 400 million rows. Check
the estimated row count on the function scan, and consider a child table instead.

## Indexing

**GIN with `jsonb_path_ops`** for containment — the usual choice:

```sql
CREATE INDEX idx_orders_payload ON orders USING gin (payload jsonb_path_ops);
SELECT * FROM orders WHERE payload @> '{"status": "refunded", "region": "eu"}';
```

It is about half the size of the default `jsonb_ops` and faster for `@>`, but it does **not**
support `?`, `?|` or `?&`, so key-existence queries need `jsonb_ops`.

**B-tree expression indexes** when you query one field by equality or range:

```sql
CREATE INDEX idx_orders_channel ON orders ((payload ->> 'channel'));
CREATE INDEX idx_orders_total   ON orders (((payload ->> 'total')::numeric));
```

The expression must be immutable, must be written *identically* in the query, and the cast is part
of the expression — `((payload->>'total')::numeric)` and `payload->>'total'` are different indexes.

**Generated columns** (12+) are the cleaner answer when a field is genuinely first-class:

```sql
ALTER TABLE orders
  ADD COLUMN channel text GENERATED ALWAYS AS (payload ->> 'channel') STORED;
CREATE INDEX ON orders (channel);
```

The value is computed on write, is queryable with plain SQL, can be `NOT NULL`-enforced on the
expression via a `CHECK`, and costs storage. This is usually the right end state: promote the
fields that are queried to columns, keep the document for the long tail.

## Updating documents

```sql
-- whole-document replace
UPDATE orders SET payload = payload || '{"priority": "high"}' WHERE order_id = 42;

-- one nested key, 14+ subscripting
UPDATE orders SET payload['meta']['source'] = '"import"'::jsonb WHERE order_id = 42;

-- function form, with a guard for a missing path
UPDATE orders SET payload = jsonb_set(payload, '{meta,tags}', '["vip"]'::jsonb, true)
WHERE order_id = 42;
```

`||` is a **shallow** merge: nested objects are replaced, not merged. `jsonb_set` with
`create_missing = false` silently does nothing if the parent path is absent; `jsonb_set_lax` lets
you choose what happens on a `NULL` value instead of erroring.

## When not to use jsonb

- Attributes with foreign keys, uniqueness or range queries on a hot path.
- Anything where the schema is known and stable — you are paying parse cost and losing planner
  statistics for flexibility you are not using.
- Large documents updated frequently: every update rewrites the tuple and its TOAST chunks.
- Wide "one big table with a payload column" designs. The result is a schema nobody can query
  without reading application code.

A useful rule: if a field appears in a `WHERE` clause of a query that runs more than a few times a
minute, it should be a column. `jsonb` is for the attributes that differ per row type.

## Production notes

- `pg_column_size(payload)` shows the stored size after compression; it is often far smaller than
  the JSON text, which is why TOAST thresholds surprise people.
- 17's `JSON_TABLE` is the cleanest way to expose semi-structured data to BI tools, because it
  returns ordinary typed columns.
- Validate at the boundary. A `CHECK (jsonb_typeof(payload) = 'object')` catches the class of bug
  where a list is inserted where a document was expected.

## Common mistakes

- Using `json` because it "preserves formatting", then discovering nothing can be indexed.
- Forgetting the `::int` cast on `->>` and comparing text lexicographically (`'9' > '10'` is true).
- Expecting `@>` to match an array element against a scalar; containment is structural.
- Building a GIN index with `jsonb_path_ops` and then querying with `?`.
- Treating a 1 MB document as a row — it is a row plus a TOAST table read.
