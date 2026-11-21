# FTS5, JSON1 and Generated Columns

Three features turn SQLite from a row store into something that can back a search box and a
document store without another service: FTS5 for full-text search, the JSON functions for
semi-structured payloads, and generated columns for indexing a value derived from either. They
combine well — a `documents` table with a JSON payload can expose a searchable title, an indexed
status, and an FTS5 index over the body, all in one file.

## FTS5: an inverted index you can query with SQL

An FTS5 table is a virtual table. Behind the scenes it maintains a segment-based inverted index
mapping tokens to rowids, plus a shadow table holding the original text unless you tell it not to.

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  body,
  tokenize = 'porter unicode61',
  prefix = '2 3'
);
```

- `unicode61` is the default tokenizer: Unicode-aware word splitting, case folding, and
  diacritic removal. `porter` adds English stemming (so `running` matches `run`); the combination
  above is the usual choice for English prose. `trigram` (3.34+) indexes three-character
  sequences and makes `LIKE '%substring%'` fast, which is what you want for identifiers, SKUs and
  names rather than prose. `ascii` is a lighter, ASCII-only tokenizer.
- `prefix = '2 3'` adds prefix indexes for 2- and 3-character prefixes, making `wal*` fast at the
  cost of index size.
- `detail = none` drops phrase-query support and `columnsize = 0` drops per-column token counts;
  both shrink the index substantially if you do not need them.

Querying uses `MATCH`, not `LIKE`:

```sql
SELECT rowid, title FROM documents_fts WHERE documents_fts MATCH 'checkpoint';
SELECT rowid FROM documents_fts WHERE documents_fts MATCH '"write ahead" NEAR(wal, 5)';
SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'title:sqlite AND body:wal*';
```

Ranking is where FTS5 earns its place. `bm25()` returns a **negative** score — more negative is a
better match — and the special `rank` column is defined as that score, so `ORDER BY rank` ascending
is best-first. Column weights are positional:

```sql
SELECT title, bm25(documents_fts, 10.0, 1.0) AS score
FROM documents_fts
WHERE documents_fts MATCH 'checkpoint'
ORDER BY rank
LIMIT 20;
```

`highlight(fts, column, '<b>', '</b>')` and `snippet(fts, column, '[', ']', '…', 8)` mark up the
matched text; both work only inside a `MATCH` query.

### External content: do not store the text twice

By default FTS5 stores a copy of every column, which doubles the size of your text. The external
content pattern stores only the index:

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, body,
  content = 'documents', content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
```

The `'delete'` command must be given the **old** values, which is why the trigger passes them
explicitly. Bulk-load with the triggers dropped or the table empty, then rebuild:

```sql
INSERT INTO documents_fts(documents_fts) VALUES('rebuild');
INSERT INTO documents_fts(documents_fts) VALUES('integrity-check');
INSERT INTO documents_fts(documents_fts) VALUES('optimize');
```

`rebuild` re-reads the content table, `integrity-check` compares index and content and raises if
they disagree, `optimize` merges segments (worth running after large deletions). A `content=''`
table stores no content at all and cannot return column values; since 3.43,
`contentless_delete=1` allows `DELETE` on such a table, which makes it viable for append-and-purge
logs.

## JSON1: documents in a TEXT column

JSON support is compiled in by default since 3.38. A JSON document is stored as TEXT (or as the
internal JSONB blob since 3.45), and the functions parse it on access.

```sql
SELECT json_extract('{"a":{"b":[1,2,3]}}', '$.a.b[2]');   -- 3
SELECT '{"a":1}' ->> '$.a';    -- 1, as a SQL value
SELECT '{"a":1}' -> '$.a';     -- '1', as JSON text
SELECT json_type('{"a":1}', '$.a');                        -- integer
SELECT key, value, type FROM json_each('{"a":1,"b":2}');
SELECT json_group_array(id) FROM documents;
SELECT json_patch('{"a":1,"b":2}', '{"b":null,"c":3}');    -- {"a":1,"c":3}
```

The `->` operator returns JSON text, `->>` returns a SQL value (numbers as numbers), and
`json_extract` returns SQL values. JSON paths are a small subset of JSONPath: `$`, `.key`, `[n]`,
`[#-1]` for the last element. There are no wildcards and no recursive descent, so "find this key
anywhere" is a full scan with `json_tree`.

Invalid JSON raises `malformed JSON` at query time; `json_valid(x)` is the guard, and
`json_error_position(x)` reports where the first syntax error sits. Nothing stops you from
storing invalid JSON in a TEXT column, so validate on write if the column matters.

### Indexing JSON

Two options, and they are not equivalent:

```sql
-- expression index: the query must use the same expression
CREATE INDEX documents_status ON documents(json_extract(payload, '$.status'));
SELECT * FROM documents WHERE json_extract(payload, '$.status') = 'open';  -- uses it

-- generated column: readable, reusable, and indexable
ALTER TABLE documents ADD COLUMN status TEXT
  GENERATED ALWAYS AS (json_extract(payload, '$.status')) VIRTUAL;
CREATE INDEX documents_status_v ON documents(status);
```

The generated column is almost always the better choice: the expression lives in the schema, every
query can use a plain `status = ?`, and the planner sees an ordinary column. The expression-index
route requires the query text to match exactly, and `->>` versus `json_extract` are different
expressions as far as the index is concerned.

JSONB (3.45+) stores the parsed representation as a blob: often smaller than the text, faster to
traverse repeatedly, and still queryable with `->`, `->>`, `json_extract` and `json_each`.
`json(x)` converts a JSONB value back to text for output.

## Generated columns: virtual or stored

```sql
CREATE TABLE lines (
  id        INTEGER PRIMARY KEY,
  qty       INTEGER NOT NULL,
  unit_cents INTEGER NOT NULL,
  total_cents INTEGER GENERATED ALWAYS AS (qty * unit_cents) VIRTUAL,
  total_str TEXT GENERATED ALWAYS AS (printf('%.2f', qty * unit_cents / 100.0)) STORED
) STRICT;
```

- **VIRTUAL** is the default: computed on read, no storage, cheap to add. **STORED** is computed on
  write and stored in the row — indexable and faster to read, but it must be present at
  `CREATE TABLE` time.
- `ALTER TABLE ... ADD COLUMN` can add a VIRTUAL generated column but **not** a STORED one.
  Verified: `cannot add a STORED column`.
- The expression must be deterministic and may not contain a subquery. It can reference other
  columns of the same row, including generated columns defined earlier in the table.
- Generated columns can be indexed, used in `CHECK` constraints, and selected normally. They
  cannot be written to directly — `INSERT INTO lines(total_cents) VALUES(1)` is an error — and they
  cannot be part of a `PRIMARY KEY`.
- Because they are deterministic expressions, they are the clean way to keep a derived field in
  sync without triggers.

## Putting it together

```sql
CREATE TABLE documents (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  payload   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  status    TEXT GENERATED ALWAYS AS (json_extract(payload, '$.status')) VIRTUAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX documents_status_created ON documents(status, created_at);
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, body, content='documents', content_rowid='id', tokenize='porter unicode61'
);
```

Now a search filters with `MATCH`, ranks with `bm25`, and joins back to `documents` by rowid, while
a status filter uses a normal b-tree index. One file, no extra services.

## Common mistakes

- Using `LIKE '%term%'` against an FTS5 table. `MATCH` is the only query interface.
- Forgetting the trigger for `UPDATE`, or passing `new` values to the `'delete'` command.
- Bulk-loading into an external-content FTS table and never running `'rebuild'`.
- Sorting by `bm25()` descending. More negative is better; use `ORDER BY rank`.
- Filtering JSON with `json_extract` and no index, on a table large enough that it matters.
- Adding a `STORED` generated column with `ALTER TABLE` and getting a parse error at deploy time.
- Assuming `contentless_delete` exists in older SQLite builds; check the version before designing
  around 3.43+.
