# The Relational Model and Normalisation

Most SQL bugs are semantic, not syntactic. They come from a wrong mental model of what a
table *is*: which values are comparable, what a NULL means, whether two rows are
interchangeable, and which facts are stored twice. Get the model right and the syntax is a
detail.

## Relations, tuples, attributes

A relation is a set of tuples over a fixed set of named attributes. In practice: a table, its
rows, its columns. Two properties matter more than the vocabulary.

**Attributes are typed and ordered; tuples are not.** A row has no inherent position. `ORDER
BY` is the only thing that gives a result an order, and without it the engine may return rows
in any sequence — including different sequences for the same query on different days. The
first thing to fix in a query that "sometimes returns the wrong row" is usually a missing
`ORDER BY` next to a `LIMIT`.

**SQL tables are bags, not sets.** The model says duplicates cannot exist; SQL permits them,
because removing duplicates costs work. `SELECT country FROM customers` returns one row per
customer, not one per country. `DISTINCT` is an explicit, and often expensive, conversion
from bag to set. Keep this asymmetry in mind — many "why is my join duplicating rows"
questions are really "I assumed the left side was unique".

A **domain** is the set of legal values for an attribute. Declaring it (`NUMERIC(12,2)`,
`DATE`, `VARCHAR(255)`) is a promise the engine can enforce and, more importantly,
*reason about*. A `DATE` column lets the planner estimate selectivity from a histogram; a
`VARCHAR` column holding dates in three formats lets it do nothing.

## Keys

| Term | Meaning | Practical note |
|---|---|---|
| Superkey | Any attribute set that uniquely identifies a tuple | Usually many exist |
| Candidate key | Minimal superkey | One is chosen as primary |
| Primary key | The chosen identifier | Implies NOT NULL + unique |
| Alternate key | A candidate key not chosen | Enforce with UNIQUE |
| Foreign key | Attribute set referencing a candidate key elsewhere | Not automatically indexed |

The distinction between *natural* and *surrogate* keys is a design decision, not a rule.
Natural keys (ISO country codes) are meaningful but change; surrogate keys (identity columns,
UUIDs) are stable but require joins to interpret. Warehouses usually carry both: a surrogate
primary key plus a unique constraint on the natural key, so late-arriving data can be matched
on the business identifier.

## NULL is not a value

`NULL` means "unknown", not "empty" and not "zero". It propagates through three-valued logic:
`NULL = NULL` evaluates to *unknown*, not *true*. Only `IS NULL` and `IS NOT NULL` test for it.

```sql
-- Returns zero rows: every comparison is UNKNOWN, so the WHERE clause rejects all rows
SELECT * FROM customers WHERE country = NULL;

-- Correct
SELECT * FROM customers WHERE country IS NULL;
```

Aggregates ignore NULLs, which produces results people rarely intend:

```sql
SELECT
  COUNT(*)              AS rows_total,      -- counts rows
  COUNT(country)        AS rows_with_country,
  AVG(total_amount)     AS avg_non_null,    -- divides by non-NULL count
  AVG(COALESCE(total_amount, 0)) AS avg_treating_null_as_zero
FROM orders;
```

`avg_non_null` and `avg_treating_null_as_zero` differ whenever any order has a NULL amount.
Neither is "wrong"; they answer different questions. Decide which question you are asking
before writing the expression.

Three-valued logic also breaks `NOT IN`:

```sql
-- If any orders.customer_id is NULL, this returns no rows at all
SELECT customer_id FROM customers
WHERE customer_id NOT IN (SELECT customer_id FROM orders);
```

The subquery yields a set containing NULL; `x <> NULL` is UNKNOWN for every candidate, and
`NOT IN` requires all comparisons to be true. Use `NOT EXISTS` or `LEFT JOIN … IS NULL`
instead. This is one of the most reliable correctness bugs in production SQL and it never
raises an error.

## Normalisation

Normalisation is the process of removing redundancy so that each fact is stored once. The
motivation is concrete: if a customer's country is stored on every order row, updating it
means updating many rows, and missing one leaves the database self-contradictory.

| Form | Rule | Violation example |
|---|---|---|
| 1NF | Atomic values, no repeating groups | `phone1, phone2, phone3` columns |
| 2NF | No partial dependency on part of a composite key | `order_items(order_id, product_id, product_name)` |
| 3NF | No transitive dependency between non-key attributes | `orders(order_id, customer_id, customer_country)` |
| BCNF | Every determinant is a candidate key | Overlapping composite candidate keys |

The classic 3NF failure is worth spelling out. In `orders(order_id, customer_id,
customer_country)`, `customer_country` depends on `customer_id`, not on the key
`order_id`. That is a transitive dependency: the country is a fact about the customer, stored
in the orders table. Moving it to `customers` removes the update anomaly and the delete
anomaly (deleting the last order for a customer would otherwise erase the only record of
where they live).

Third normal form is the usual target for transactional schemas. BCNF is stricter and matters
when you have overlapping candidate keys — for example a table of `(student, subject,
teacher)` where each teacher teaches exactly one subject. Most teams stop at 3NF and handle
the remaining edge cases with constraints.

## Why warehouses denormalise anyway

A star schema keeps the same discipline but inverts the priority: one central **fact** table
(orders, order_items) surrounded by **dimensions** (customer, product, date). Dimensions are
deliberately wide and redundant, sometimes pre-joined into a single flat table.

The reason is physical. Columnar warehouses read only the columns a query mentions and
compress runs of similar values well. A wide dimension that repeats `country` on every row
compresses to almost nothing, while the join it avoids would cost a shuffle across
micro-partitions. Normalisation optimises for *write correctness*; star schemas optimise for
*scan efficiency*. OLTP systems normalise because they write constantly and read narrowly;
warehouses denormalise because they read broadly and write in batches.

## Engine differences that bite early

- **Booleans.** PostgreSQL and Snowflake have a real `BOOLEAN`. SQL Server does not — use
  `BIT` and compare to `1`/`0`. Predicates still work (`WHERE is_active = 1`).
- **Identifiers.** PostgreSQL folds unquoted names to lowercase, Snowflake to uppercase, and
  SQL Server preserves case but compares according to collation. Quoting is `"x"` in
  PostgreSQL and Snowflake, `[x]` in SQL Server. Portable SQL avoids quoted identifiers
  entirely.
- **CHAR semantics.** In SQL Server, `CHAR` values are blank-padded and trailing spaces are
  ignored in comparisons, so `'a' = 'a '` is true. `VARCHAR` avoids the confusion.
- **Money.** Never use `FLOAT`/`DOUBLE` for currency. Use `NUMERIC(12,2)` (PostgreSQL,
  Snowflake `NUMBER(12,2)`) or `DECIMAL` in SQL Server.
- **Constraint enforcement.** Snowflake does not enforce primary, unique or foreign keys on
  standard tables — it records them as metadata for the optimiser. PostgreSQL and SQL Server
  enforce them. Do not port a schema to Snowflake and assume integrity moved with it.

## Common mistakes

- Treating `NULL` as a value in comparisons, `NOT IN`, or `AVG`.
- Assuming a table has an order without an `ORDER BY`.
- Assuming a join's left side is unique when it is not, then "fixing" the duplication with
  `DISTINCT`.
- Storing the same fact in two tables and calling it denormalisation when it is just drift.

## Production notes

Write the constraint even if the warehouse ignores it: it documents intent, and dbt tests or
a scheduled check can enforce it. Keep one canonical definition of each business entity, and
let derived tables be rebuilt rather than patched. If two tables disagree about a customer's
country, you do not have a normalisation problem — you have two sources of truth, and the
query that "sometimes" returns the wrong answer is the symptom.
