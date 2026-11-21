# JSON Support and Generated Columns

MySQL's `JSON` type stores a validated JSON document in a binary representation that supports path-based access and modification. It is useful when a record has a flexible or evolving set of attributes, but JSON should not become an excuse to hide every relational field inside one opaque blob. Fields used for joins, constraints, frequent filters, or reporting often belong in typed columns.

## Store and query documents

A JSON column accepts valid JSON values, including objects, arrays, strings, numbers, booleans, and `null`. MySQL validates documents on write. Use functions such as `JSON_EXTRACT`, `JSON_VALUE` where supported by the server release, `JSON_SET`, and the `->` shorthand to access paths. `->` returns a JSON value; `->>` extracts a scalar as unquoted text.

```sql
CREATE TABLE products (
  product_id BIGINT PRIMARY KEY,
  attributes JSON NOT NULL
);

SELECT product_id, attributes->>'$.brand' AS brand
FROM products
WHERE JSON_EXTRACT(attributes, '$.active') = true;
```

JSON path syntax is not identical to every other database's JSON dialect. Validate path behaviour, scalar typing, missing-property behaviour, and comparisons against MySQL documentation for the exact version. A missing member and a JSON `null` value are distinct concepts. String extraction and comparison may also bring character-set and collation rules into play.

MySQL offers mutation functions including `JSON_SET` (add or replace), `JSON_INSERT` (add only when absent), and `JSON_REPLACE` (replace only when present). They return updated document values; use them in an `UPDATE` with predicates that protect the intended row set. Large-document updates still have storage and logging consequences and can cause row-level contention. A JSON column is not a patch-oriented document store with independent per-property locks.

## Indexing JSON values

JSON itself is not indexed like an ordinary scalar B-tree column. A common approach is a generated column that extracts a stable scalar, then indexes that column. Generated columns may be `VIRTUAL`, computed when read, or `STORED`, materialized in the row and maintained on writes. Both can support indexes in appropriate configurations; verify restrictions, expression matching, and cost for your MySQL version.

```sql
ALTER TABLE products
  ADD COLUMN brand VARCHAR(80)
    GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(attributes, '$.brand'))) STORED,
  ADD INDEX idx_products_brand (brand);

SELECT product_id FROM products WHERE brand = 'Acme';
```

The expression's result type, length, nullability, and collation matter. Cast values explicitly when appropriate, especially for numbers, so values are compared numerically rather than as text. Generated-column expressions have determinism and allowed-function restrictions. If the JSON path or schema changes, changing the generated expression can require a table operation and should be treated as a migration.

MySQL 8.0 also supports functional key parts, introduced in 8.0.13, for indexing expressions directly, subject to restrictions. A generated column can nevertheless be clearer, reusable in queries, and easier to inspect. Functional key parts are implemented using hidden virtual generated columns, so they do not erase the underlying expression or type design concerns.

## Multi-valued indexes

MySQL 8.0.17 added multi-valued indexes for certain JSON arrays, allowing multiple index entries to be created for elements of a single row. They support particular predicates and data types rather than arbitrary JSON search. This is a specialized tool, not a general JSON inverted index like every document database may provide. Check eligible functions and operators for the exact release, and compare a normalized child table if array membership is central to the application or needs foreign keys and rich joins.

## Design trade-offs

JSON is useful for optional metadata, source payloads, and attributes whose shape varies but is still associated with a relational entity. It is less attractive for core facts whose type and validity need database enforcement. A JSON document can duplicate a value stored in a normal column; establish which representation is authoritative and keep them synchronized deliberately. Constraints on JSON content are more limited and less transparent than ordinary column constraints.

Keep frequently read documents reasonably sized, project only needed fields, and measure write amplification and row storage. Application validation complements—not replaces—server validation. If producers evolve property names or data types, provide compatibility and backfill plans before changing queries or generated expressions.

## Evolving JSON-backed schemas

Document the shape of JSON properties at the application boundary and version it when producers or consumers change. A field that changes from integer to string may still be syntactically valid JSON, yet break a generated-column cast, comparison, or downstream consumer. Before changing a path, measure its presence and type distribution, deploy code tolerant of both shapes when feasible, and backfill in batches. For large tables, estimate the DDL effect of adding a stored generated column; it can require materializing values across existing rows. A virtual generated expression may avoid storing another copy, but indexed values still require index maintenance and expression evaluation.

Use SQL NULL, missing paths, and JSON null intentionally. `JSON_EXTRACT` can return SQL `NULL` when a path is absent, while an explicit JSON null is a JSON value; predicates and generated columns can distinguish or collapse these states depending on the expression. Test them in fixtures, as well as empty arrays, malformed values, Unicode, and boundary numbers. Specify collation when strings are compared so case and accent behaviour is predictable.

Normalization remains valuable when a document contains a collection of independently meaningful entities. A child table with a foreign key can enforce membership, support joins and uniqueness, and update one item without rewriting a large parent document. Conversely, highly variable optional metadata may be simpler in JSON than a sparse table full of rarely populated columns. Choose per access pattern and invariant, and document the source of truth if both relational and JSON representations contain the same fact.

Schema validation should happen before write paths depend on the new expression. During rollout, count rows with absent or unexpected property types, exercise inserts and updates that produce every supported shape, and compare indexed lookup results with direct JSON evaluation on a sample. A backfill can change row locks, redo volume, and replica apply rate, so throttle it and make it restartable. If the business later stops using the property, remove the generated index and column in a separately planned change rather than leaving permanent write cost behind.

## Production notes

- Use explicit paths, types, and casts; test missing keys, JSON null, malformed inputs, and boundary values.
- Index only JSON paths that appear in measured filters or ordering requirements.
- Consider a normal child table when array members have identity, constraints, or join behaviour.
- Confirm the exact minimum server version for functional indexes and multi-valued indexes; MySQL 8.0 is a feature series, not a single capability set.

## Common mistakes

- Assuming a JSON column automatically indexes keys or behaves identically to PostgreSQL `jsonb`.
- Comparing a number extracted as text and obtaining lexical rather than numeric ordering.
- Using JSON for properties that need referential integrity or frequent relational joins.
- Forgetting generated-column type and collation when building an index.
- Treating JSON mutation as an isolated property update with no row-level write cost.
