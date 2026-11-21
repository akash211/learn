# Schema Design, Constraints and Foreign Keys

SQLite has no schemas, no roles and no `ALTER TABLE ... ADD CONSTRAINT`. A database file contains
`main` plus whatever you `ATTACH`, and the schema is whatever the `sqlite_schema` table says it is.
That makes schema design mostly a matter of choosing the right table shape and being explicit
about the constraints you want, because the engine will not infer any for you.

## Migrations: user_version is the mechanism

There is no migration table in the engine, and most projects invent one. Before you do, note that
the file header has a 32-bit `user_version` field reserved for exactly this:

```sql
PRAGMA user_version;          -- read it on connect
BEGIN IMMEDIATE;
CREATE TABLE invoices (...);
PRAGMA user_version = 2;      -- integer literal; pragmas do not take parameters
COMMIT;
```

Wrap each step in its own transaction, check the current version, and refuse to open a file
written by a newer version of the app. `PRAGMA application_id` does the same for "is this even my
file", which matters when users can point the app at any path.

## Choosing the table shape

| Shape | Use when | Cost |
| --- | --- | --- |
| `INTEGER PRIMARY KEY` | Almost always; it is the rowid alias | None — no extra index |
| Any other primary key | Natural keys, UUIDs | A separate unique index |
| `WITHOUT ROWID` | Composite primary keys, small rows, key-order scans | Larger keys; no rowid; no `AUTOINCREMENT` |
| `AUTOINCREMENT` | IDs must never be reused (legal, audit) | `sqlite_sequence` table and a write per insert |

`INTEGER PRIMARY KEY` is not a column with an index: it *is* the rowid, stored in the b-tree key,
so lookups by id are a single descent. `AUTOINCREMENT` adds monotonicity guarantees and a
`sqlite_sequence` row updated on every insert; without it, SQLite reuses the largest rowid after
the highest row is deleted, which is fine for most applications and not fine for invoice numbers.

There is a trap in the declaration itself: `INTEGER PRIMARY KEY DESC` is **not** a rowid alias.
The `DESC` suffix disqualifies it, and you get a separate unique index and a hidden rowid:

```sql
CREATE TABLE d(a INTEGER PRIMARY KEY DESC, b TEXT);
INSERT INTO d(a,b) VALUES(10,'x');
SELECT rowid, a FROM d;   -- 1|10  — two different numbers
```

Use `PRIMARY KEY (a DESC)` as a table constraint if you actually want descending order.

## Constraints and what they cost

| Constraint | Enforced | Index created |
| --- | --- | --- |
| `NOT NULL` | Yes, on every write | No |
| `UNIQUE` | Yes; multiple NULLs allowed | Yes |
| `PRIMARY KEY` | Yes | Only if not an `INTEGER` rowid alias |
| `CHECK (expr)` | Yes, when `expr` is false — NULL passes | No |
| `FOREIGN KEY` | Only with `PRAGMA foreign_keys=ON` | **No** — index the child yourself |

Two behaviours surprise people. `CHECK` passes when the expression evaluates to NULL, so
`CHECK (length(code) = 3)` allows `NULL` codes unless you also write `NOT NULL`. And `UNIQUE`
follows the SQL standard in allowing any number of NULLs, so a "unique, optional" column is not
actually unique for the rows that are missing.

Constraint-violation handling needs care too. `INSERT OR IGNORE` ignores uniqueness, NOT NULL and
CHECK violations, but **not** foreign-key violations, which still abort the statement.
`INSERT OR REPLACE` is not an update: it deletes the conflicting row and inserts a new one, which
fires `ON DELETE CASCADE`, changes the rowid, and can silently remove child rows. Verified:

```sql
INSERT OR REPLACE INTO p(id, v) VALUES(2, 'a');   -- 'a' already existed on id=1
SELECT count(*) FROM ch;                          -- 0: the cascade fired
```

Use `INSERT ... ON CONFLICT (v) DO UPDATE` when you mean upsert.

## Foreign keys: five things that must all be true

1. `PRAGMA foreign_keys = ON` on **every connection**. It defaults to off and is per-connection;
   an ORM that opens its own connections must set it in a connect hook, not once at startup. It is
   a no-op inside a transaction, so set it first.
2. The parent key must be the primary key or have a `UNIQUE` index, with a matching collation.
3. The child column needs its own index. SQLite does not create one, and without it every parent
   delete scans the child table — and holds a write lock while doing it.
4. Actions are declared on the child: `ON DELETE CASCADE`, `RESTRICT`, `SET NULL`, `SET DEFAULT`,
   `NO ACTION`. `RESTRICT` cannot be deferred and blocks the parent change immediately; `NO ACTION`
   is checked at the end of the statement and can be deferred to commit.
5. Check the data before trusting the pragma: `PRAGMA foreign_key_check;` lists existing
   violations with table, rowid, parent and constraint id. It returns nothing when clean.

```sql
CREATE TABLE order_lines (
  order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no   INTEGER NOT NULL,
  sku       TEXT    NOT NULL,
  qty       INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, line_no)
) STRICT, WITHOUT ROWID;

CREATE INDEX order_lines_sku ON order_lines(sku);
```

`DEFERRABLE INITIALLY DEFERRED` moves the check to commit time for that one constraint;
`PRAGMA defer_foreign_keys = ON` does it for all of them until the current transaction ends, which
is the practical way to load a cyclic graph of rows.

## Changing a schema

SQLite's `ALTER TABLE` is deliberately minimal:

- `RENAME TO` and `RENAME COLUMN` (3.25+) rewrite references in indexes, triggers and views.
- `ADD COLUMN` cannot add a `PRIMARY KEY` or `UNIQUE` column, cannot use a non-constant default
  such as `CURRENT_TIMESTAMP`, must supply a default if `NOT NULL`, and cannot add a `STORED`
  generated column (virtual is allowed).
- `DROP COLUMN` (3.35+) fails if the column is indexed, part of the primary key, referenced by a
  `CHECK`, foreign key, generated column, partial index, view or trigger.

Anything else is the twelve-step rebuild: create `new_table` with the desired schema, copy rows
with `INSERT INTO new_table SELECT ...`, drop the old table, rename the new one, recreate indexes
and triggers, then `PRAGMA foreign_key_check`. Do it inside one transaction with
`PRAGMA foreign_keys=OFF` around it (the pragma is ignored inside a transaction, so toggle before
`BEGIN`), and remember that `legacy_alter_table` changes how renaming behaves for views.

## Multi-tenancy and naming

SQLite has no schemas, so "one schema per tenant" becomes one *file* per tenant — which is often
the best design anyway: it gives isolation, per-tenant backup and per-tenant deletion for free.
The alternative is a `tenant_id` column on every table, composite indexes led by `tenant_id`, and
the discipline to never forget the predicate. Do not mix the two.

Names are case-insensitive for ASCII, and `sqlite_schema` stores the original text. Avoid
identifiers that differ only by case, and avoid the `sqlite_` prefix, which is reserved.

## Common mistakes

- Forgetting `PRAGMA foreign_keys=ON` on a connection and concluding that foreign keys "don't work
  in SQLite".
- Adding a foreign key without an index on the child column, then watching bulk deletes take
  minutes.
- Using `AUTOINCREMENT` on every table, paying for `sqlite_sequence` writes with no requirement
  that IDs be monotonic.
- Assuming `ALTER TABLE` can add a constraint. It cannot; rebuild the table.
- Relying on `CHECK` for a nullable column without realising NULL passes the check.
- Letting an ORM generate `DATETIME` and `BOOLEAN` columns and believing either is a real type.
