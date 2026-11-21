# Types, Affinity and Dynamic Typing

SQLite has five storage classes and no column types in the sense the rest of the SQL world means.
A value is NULL, INTEGER (signed 64-bit), REAL (IEEE-754 double), TEXT or BLOB, and that is what
is stored on disk. The declared type in `CREATE TABLE` is a *hint* that determines one of five
type affinities, which decide how values are coerced on the way in and how comparisons are done.
Understanding that sentence removes most of the type-related surprises people hit with SQLite.

## Five storage classes, five affinities

| Declared type contains | Affinity | Behaviour |
| --- | --- | --- |
| `INT` | INTEGER | Integers preferred; text that looks numeric is converted |
| `CHAR`, `CLOB`, `TEXT` | TEXT | Text preferred; numbers are converted to text |
| `BLOB`, or no type at all | BLOB | Stored exactly as given, no conversion |
| `REAL`, `FLOA`, `DOUB` | REAL | Reals preferred; integers become floats |
| Anything else (`NUMERIC`, `DECIMAL`, `BOOLEAN`, `DATE`, `VARCHAR`) | NUMERIC | Numeric if it converts losslessly, otherwise text |

The rules are applied in that order, which is why `VARCHAR(20)` gets TEXT affinity (it contains
`CHAR`) while `DECIMAL(10,2)` gets NUMERIC, and why a column declared `BOOLEAN` accepts the string
`'yes'` without complaint. There is no boolean type: `TRUE` and `FALSE` are keywords for `1` and
`0`, and a column that stores `1`/`0` is the idiomatic representation.

On insert, a value may be converted to the column's affinity if the conversion is lossless and
reversible. The canonical demonstration:

```sql
CREATE TABLE t(a INT, b TEXT, c REAL, d NUMERIC, e VARCHAR(20));
INSERT INTO t VALUES('500.0','500.0','500.0','500.0','500.0');
SELECT typeof(a), a, typeof(b), b, typeof(c), c, typeof(d), d, typeof(e), e FROM t;
-- integer|500 | text|500.0 | real|500.0 | integer|500 | text|500.0
```

Two things to notice. `NUMERIC` turned `'500.0'` into the integer `500`, because that is lossless
and the affinity prefers integers — which is exactly the wrong behaviour for a money column.
And `REAL` kept `500.0`, because the affinity forces a float even when the value is integral.

## Comparison is where the damage happens

Values of different storage classes are ordered NULL < numbers < text < blob. Within numbers,
integer and real compare numerically. Text compares with the column's collation (`BINARY` by
default), and a numeric-looking string is never compared as a number unless affinity says so.

```sql
SELECT '1' = 1;        -- 0: text vs integer, different storage classes
SELECT '1' < 1;        -- 0: numbers sort before text
SELECT '10' < '9';     -- 1: text comparison, lexicographic
SELECT 2 < '10';       -- 1: integer sorts before text
```

The subtle part is that **affinity is applied before comparison** when one side is a column.
A `TEXT` column compared to the integer `1` has TEXT affinity applied to the `1`, so it becomes
`'1'` and the comparison can match. An `INTEGER` column compared to `'1'` converts the string and
matches. But two literals, or two columns with different affinities, are compared as-is. That is
why `WHERE id = '42'` finds the row on an INTEGER column, while `SELECT '42' = 42` is false, and
why a join between a `TEXT` code column and an `INTEGER` code column silently misses every row
that is not textually identical.

Two more consequences worth internalising. `ORDER BY` on a mixed-type column produces the storage
class order, not numeric order — a column holding `1`, `2.5`, `'a'` sorts as 1, 2.5, 'a'. And an
index on a column only helps comparisons whose affinity matches the index's collation; an index
built for `BINARY` will not serve a `NOCASE` comparison.

## No dates, no decimals

SQLite has no DATE, TIME, TIMESTAMP or DECIMAL type. It has date and time *functions*, which
accept and return strings, numbers or Julian day values. The two sane conventions are:

```sql
-- ISO-8601 text in UTC, sortable and comparable as text
created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
-- Unix epoch seconds as an integer
created_at INTEGER NOT NULL DEFAULT (unixepoch())
```

ISO text sorts correctly because the format is fixed-width and zero-padded, and it survives a
`json` round-trip; integer epochs are smaller and faster to index but unreadable in a dump. Do not
store local time, and do not rely on `datetime('now')` producing a `T` separator or milliseconds —
it returns `YYYY-MM-DD HH:MM:SS`, which sorts differently from the ISO form with `T`.

Money is the same story: `DECIMAL`/`NUMERIC` affinity will happily store a float, and floats do
not add up. Store integer minor units (cents, paise) and format at the edge. When you must divide,
remember that `/` on two integers is integer division — `7/2` is `3`, not `3.5`.

Integer arithmetic is 64-bit. A literal that exceeds `9223372036854775807` becomes REAL, and
`sum()` over integers that overflow raises `integer overflow` rather than wrapping; `total()`
always returns a float and never raises. Neither is what a finance report wants, which is another
reason to keep the unit small.

## STRICT tables

Since 3.37, `CREATE TABLE ... STRICT` opts into a real type system. Only `INT`, `INTEGER`, `REAL`,
`TEXT`, `BLOB` and `ANY` are allowed, values are checked against the declared type on write, and
`PRIMARY KEY` implies `NOT NULL`.

```sql
CREATE TABLE orders (
  id       INTEGER PRIMARY KEY,
  customer INTEGER NOT NULL REFERENCES customers(id),
  status   TEXT    NOT NULL CHECK (status IN ('new','paid','shipped')),
  total_cents INTEGER NOT NULL,
  payload  ANY
) STRICT;
```

`STRICT` is not "no coercion": an integer written to a `TEXT` column is still converted to text
because that conversion is lossless. What it rejects is lossy or nonsensical storage — a blob in a
`TEXT` column, the string `'abc'` in an `INTEGER` column. `ANY` is the escape hatch that behaves
like a pre-STRICT column. For new schemas there is little reason not to use it; for existing ones,
converting requires the table-rebuild procedure because `ALTER TABLE` cannot add `STRICT`.

## Collation and text

The default collation is `BINARY`, so `'Apple'` and `'apple'` are distinct and `ORDER BY` puts all
capitals first. `COLLATE NOCASE` folds ASCII case only (not Unicode), and `COLLATE RTRIM` ignores
trailing spaces. `LIKE` is case-insensitive for ASCII by default; `GLOB` is case-sensitive and
supports `*`/`?`/`[...]`.

```sql
CREATE TABLE users (email TEXT COLLATE NOCASE UNIQUE);
SELECT count(DISTINCT name) FROM t;   -- NOCASE column folds 'Apple' and 'apple'
```

Collation is part of the index definition: a `UNIQUE` on a `NOCASE` column enforces
case-insensitive uniqueness, while the same constraint on a `BINARY` column does not.

## Production notes

- Run `PRAGMA integrity_check` after any change to a type-affinity assumption; a `CAST` that
  silently produced `0` is not detectable afterwards.
- Use `typeof(x)` and `quote(x)` when debugging. They show the storage class and the literal,
  which is usually enough to explain a comparison that "should" match.
- If an ORM generates `VARCHAR(n)`, `BOOLEAN` and `DATETIME`, it is generating affinity hints, not
  constraints. Nothing enforces the length, and nothing stops a string in a boolean column.

## Common mistakes

- Declaring `NUMERIC` or `DECIMAL` for money and assuming the decimals are preserved.
- Comparing a `TEXT` column to an integer in one query and to a string in another, then wondering
  why one uses the index and the other does not.
- Expecting `UNIQUE` to reject multiple NULLs. It does not: SQLite follows the SQL standard here,
  and several NULLs are allowed.
- Storing timestamps as `datetime('now')` in one code path and ISO-8601 with `T` in another, then
  sorting the column.
- Assuming `STRICT` validates lengths. `TEXT` has no length limit, and `VARCHAR(20)` is rejected
  outright by a strict table — it is not one of the six permitted type names.
