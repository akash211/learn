# Constraints, Keys and Data Integrity

Constraints are the only part of a data model that is enforced by the storage engine rather
than by hope. They are also the part most often dropped during a migration to a warehouse,
usually with the reasoning "the pipeline checks it" — which is true until the pipeline is
late, or someone runs a manual backfill.

## Primary keys

A primary key is `UNIQUE` + `NOT NULL`, and a table has at most one. That is the entire
definition; everything else is implementation.

```sql
CREATE TABLE customers (
  customer_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        VARCHAR(320) NOT NULL,
  name         VARCHAR(200) NOT NULL,
  country      CHAR(2),
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);
```

PostgreSQL and Snowflake both accept `GENERATED ALWAYS AS IDENTITY`; SQL Server uses
`BIGINT IDENTITY(1,1)`. Sequences are the portable alternative, at the cost of an extra
round trip and a separate object to manage.

**Natural versus surrogate.** `email` is a natural key for a customer — until someone changes
it, or two customers share a household address, or the source system reuses it. Surrogate
integers are stable but leak nothing and require joins to interpret. The pragmatic pattern is
both: surrogate primary key, unique constraint on the natural key. The unique constraint is
what protects you from duplicates; the surrogate is what foreign keys point at.

In SQL Server, the primary key is clustered by default. That makes a random `UNIQUEIDENTIFIER`
PK actively harmful — every insert lands on a random page. Either make it nonclustered and
cluster on a monotonic column, or use `NEWSEQUENTIALID()`.

## UNIQUE and the NULL question

This is where engines diverge in a way that silently changes behaviour:

| Engine | Multiple NULLs in a UNIQUE column? |
|---|---|
| PostgreSQL | Yes — NULLs are distinct for uniqueness |
| SQL Server | No — a single-column UNIQUE constraint allows only one NULL |
| Snowflake | Not enforced at all (metadata only) |
| Oracle | No |

If you need "unique among non-NULL values" on SQL Server, use a filtered unique index:

```sql
CREATE UNIQUE INDEX ux_customers_email
  ON customers (email)
  WHERE email IS NOT NULL;
```

PostgreSQL has partial indexes with the same syntax. This is also the right tool for
"at most one active record per customer":

```sql
CREATE UNIQUE INDEX ux_one_active_subscription
  ON subscriptions (customer_id)
  WHERE status = 'active';
```

SQL Server calls these filtered indexes and has a narrower predicate grammar (simple
comparisons and `IS NOT NULL`, no `OR`). Snowflake cannot enforce either; the check has to be
a scheduled data-quality test.

## Foreign keys

```sql
CREATE TABLE orders (
  order_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers (customer_id),
  order_ts     TIMESTAMP NOT NULL,
  status       VARCHAR(20) NOT NULL
               CHECK (status IN ('pending','paid','shipped','cancelled')),
  total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0)
);
```

Two performance facts are routinely missed:

1. **The child column is not indexed automatically.** PostgreSQL and SQL Server both require
   you to create an index on `orders(customer_id)` yourself. Without it, deleting a customer
   requires a full scan of `orders` to check for references, and every join on that column is
   a scan.
2. **The parent column must be unique.** SQL Server requires a unique index on the referenced
   column; PostgreSQL requires a unique or primary key constraint. A foreign key to a
   non-unique column is rejected.

`ON DELETE` behaviour is a design decision with sharp edges:

| Action | Effect |
|---|---|
| `RESTRICT` / `NO ACTION` | Reject the delete if children exist (checked immediately vs at end of statement) |
| `CASCADE` | Delete children — convenient, and how people lose data |
| `SET NULL` | Orphan the child by nulling the column (it must be nullable) |
| `SET DEFAULT` | Repoint children at a default row |

`CASCADE` is right for genuine composition (order → order_items). It is wrong for reference
data (deleting a country should not delete its customers). In warehouses, cascades are
irrelevant because nothing is enforced.

**Deferrable constraints** are PostgreSQL-only among these three: `DEFERRABLE INITIALLY
DEFERRED` moves the check to commit time, which lets you insert a parent and child in either
order inside a transaction, or perform a circular swap of unique values. SQL Server and
Snowflake check immediately.

## CHECK constraints and the NULL loophole

A `CHECK` constraint passes when it evaluates to `TRUE` **or UNKNOWN**. So:

```sql
CHECK (total_amount > 0)
```

does not reject `NULL` — it accepts it. If the column must be present, you need both
`NOT NULL` and the check. This is not a bug; it follows from three-valued logic, and it is the
reason a "validated" column still contains NULLs in production.

Snowflake does not support `CHECK` constraints at all. SQL Server and PostgreSQL do, and both
evaluate them on insert and update but not on existing rows when you add one — `ALTER TABLE …
ADD CONSTRAINT … CHECK (…)` fails if existing data violates it, unless you add it `NOT VALID`
(PostgreSQL) and validate later. That two-step is how you add a constraint to a large table
without a long exclusive lock.

## Integrity in a warehouse

Snowflake enforces `NOT NULL` and nothing else on standard tables. Primary keys, unique keys
and foreign keys are parsed, stored, and exposed to the optimiser — which can use them to
eliminate joins — but never checked. This is deliberate: enforcing uniqueness on every insert
would require global coordination across micro-partitions, defeating the architecture.

The consequences are concrete:

- A `MERGE` can create duplicates if the source has more than one row per key.
- A "primary key" column can contain NULLs.
- Referential integrity is a modelling claim, not a fact.

The replacement is a testing layer. In a dbt project, the minimum viable contract is:

```yaml
models:
  - name: dim_customers
    columns:
      - name: customer_id
        tests: [unique, not_null]
      - name: country
        tests:
          - relationships:
              to: ref('dim_countries')
              field: country_code
```

`unique` + `not_null` on every key, `relationships` on every foreign key, and `accepted_values`
on every status column. Run them in CI and after every load; failing tests should block
promotion, not produce a warning nobody reads.

## Deduplication without constraints

When the engine will not enforce uniqueness, make the write idempotent instead of hoping:

```sql
-- PostgreSQL / SQL Server: constraint as arbiter
INSERT INTO customers (customer_id, email, name)
VALUES (?, ?, ?)
ON CONFLICT (customer_id) DO UPDATE
  SET email = EXCLUDED.email, name = EXCLUDED.name;

-- Snowflake: dedupe the source, then merge
MERGE INTO customers t
USING (
  SELECT * FROM customers_stage
  QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY updated_at DESC) = 1
) s
ON t.customer_id = s.customer_id
WHEN MATCHED THEN UPDATE SET t.email = s.email, t.name = s.name
WHEN NOT MATCHED THEN INSERT (customer_id, email, name)
  VALUES (s.customer_id, s.email, s.name);
```

`ON CONFLICT` needs a unique index to arbitrate — without one it cannot work. This is the
strongest practical argument for keeping constraints even in systems that "don't need" them.

## Common mistakes

- Assuming a foreign key created an index on the child column.
- Adding `CHECK (x > 0)` and expecting it to reject NULL.
- Relying on a Snowflake primary key for uniqueness.
- Using `CASCADE` on reference data.
- Adding a constraint to a large table in one statement during business hours.

## Production notes

Constraints cost write throughput and buy correctness; the trade is worth it in OLTP and
impossible in an MPP warehouse, so the warehouse needs tests instead. Whatever the engine,
treat every key as having three separate obligations — declared, enforced, and monitored —
and know which of the three you actually have. In Snowflake the answer is "declared and
monitored, not enforced", and the monitoring is the part you must not skip.
