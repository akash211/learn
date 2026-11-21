# T-SQL Features and Semantic Edges

T-SQL is SQL Server's procedural extension to standard SQL. It has variables, batches, error handling and control flow alongside relational statements. The syntax often looks familiar across database products, but details such as `TOP`, `OFFSET/FETCH`, `MERGE`, `APPLY` and conversion behaviour affect both correctness and plans. This chapter focuses on SQL Server-specific edges rather than re-teaching joins or aggregation.

## TOP and deterministic pagination

`TOP` limits rows and can be combined with `PERCENT` or `WITH TIES`. Without `ORDER BY`, the chosen rows are not defined. Even with ordering, ties across all order-by expressions do not have a stable sequence unless a unique tiebreaker is included.

```sql
SELECT TOP (20) WITH TIES order_id, customer_id, total_amount
FROM dbo.orders
ORDER BY total_amount DESC, order_id;
```

`TOP` is also valid in DML. A common batching pattern deletes a bounded set and commits between batches, but `TOP` itself does not imply order; select the intended keys in a subquery with an explicit order if the batch must process oldest records first. For update/delete, verify that the predicates and joins identify the intended rows before running a batch repeatedly.

`OFFSET ... FETCH NEXT` is part of `ORDER BY` and works well for shallow page navigation:

```sql
SELECT order_id, order_ts, total_amount
FROM dbo.orders
ORDER BY order_ts DESC, order_id DESC
OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
```

The sort must be unique for stable page boundaries. Large offsets are expensive because SQL Server still has to locate and discard preceding rows. Keyset pagination instead remembers the last seen key and seeks beyond it:

```sql
WHERE order_ts < @last_order_ts
   OR (order_ts = @last_order_ts AND order_id < @last_order_id)
ORDER BY order_ts DESC, order_id DESC;
```

A matching index can make this approach more scalable, while inserts before the current offset are less likely to cause duplicates or skips between requests.

## APPLY and row-wise correlation

`CROSS APPLY` evaluates a table-valued expression for each row on its left and removes left rows that produce no result. `OUTER APPLY` retains such rows with null right-side columns. It is useful for correlated top-N lookups and inline table-valued functions:

```sql
SELECT c.customer_id, recent.order_id, recent.order_ts
FROM dbo.customers AS c
OUTER APPLY (
    SELECT TOP (1) o.order_id, o.order_ts
    FROM dbo.orders AS o
    WHERE o.customer_id = c.customer_id
    ORDER BY o.order_ts DESC, o.order_id DESC
) AS recent;
```

This is not automatically faster than a join. With a supporting `(customer_id, order_ts)` index it can perform an efficient seek per customer; for a large outer input, repeated seeks may be worse than one set-oriented scan and ranking. Inspect actual rows, executions and logical reads.

## Conversion, NULL and errors

`CAST` and `CONVERT` fail the statement when a value cannot be converted. `TRY_CAST` and `TRY_CONVERT` return `NULL` for many conversion failures, which is useful in ingestion and validation but can hide bad data if nulls are silently accepted. Check invalid counts explicitly and distinguish a real input null from a failed conversion.

```sql
SELECT raw_value,
       TRY_CAST(raw_value AS decimal(12, 2)) AS amount
FROM staging.import_rows;
```

Type precedence affects implicit conversions. If a predicate compares a `varchar` column to an `int` parameter, SQL Server may convert the column, preventing a seek and potentially raising conversion errors. Match parameter types to column types. Use `SET XACT_ABORT ON` for many transactional scripts so certain run-time errors terminate and roll back the transaction, but understand that compile errors and some errors have different behaviour. `TRY...CATCH`, `XACT_STATE()` and `THROW` provide structured error handling; `@@ERROR` is easy to overwrite and is not a robust substitute.

## MERGE: powerful syntax with sharp edges

`MERGE` combines insert, update and delete actions based on a source-target match. It can express an upsert, but source keys must be unique for the target match; multiple source rows matching one target row can fail. Concurrency and trigger interactions need particular care, and SQL Server versions have had fixes and edge cases around `MERGE`. Many teams prefer explicit `UPDATE` followed by `INSERT` under a suitable transaction and unique constraint, because the steps and locking are easier to reason about.

If using `MERGE`, define the match key precisely, enforce uniqueness in the target, keep the `ON` clause to identity matching rather than filtering target eligibility, and test concurrent writers. `HOLDLOCK` can provide serializable semantics for the target in some upsert patterns, but it is not a magic correctness switch and may increase blocking. Review current version-specific guidance and test the exact pattern under concurrency.

## Batches, variables and output

`GO` is a client-side batch separator understood by tools such as SSMS and `sqlcmd`; it is not a T-SQL statement sent to the server. A variable declared in one batch is not in scope in the next. `IDENTITY` values can have gaps, and `SCOPE_IDENTITY()` is safer than `@@IDENTITY` when triggers insert into other identity tables. Neither guarantees gap-free numbering.

## Common mistakes

- Using `TOP` without a deterministic `ORDER BY` and expecting repeatable records.
- Using deep `OFFSET` pagination for a large interactive result set instead of keyset pagination.
- Assuming `CROSS APPLY` always beats a join or that a correlated expression executes only once.
- Treating `TRY_CAST` nulls as valid source data without measuring conversion failures.
- Writing an upsert with `MERGE` without a unique target key and a concurrency test.
- Putting `GO` inside application SQL sent through a driver; it belongs to the client scripting layer.


## T-SQL correctness patterns worth explaining

Interview questions often test whether a candidate can reason about semantics under nulls, errors, concurrency and repeated execution. `NULL` means unknown, so `column = NULL` is not a true comparison; use `IS NULL`. A `NOT IN` subquery containing a null can produce UNKNOWN for every candidate and return no rows. For anti-joins, `NOT EXISTS` is often easier to reason about, but its correlated predicate and indexes still matter. SQL Server's three-valued logic also means a `CHECK` constraint accepts UNKNOWN, so explicitly account for nullable columns when a rule requires a value.

A conversion on the indexed column can change both correctness and access path. If a `varchar` column is compared to an `int`, type precedence may force conversion of every string value to integer. That can fail on malformed values and prevent an efficient seek. Declare parameters with the exact column type and inspect the plan for `CONVERT_IMPLICIT`. `TRY_CONVERT` is useful at ingestion boundaries, but retain the raw value and measure rejects rather than allowing a bad input to disappear into NULL.

```sql
SELECT COUNT_BIG(*) AS invalid_amounts
FROM staging.import_rows
WHERE raw_amount IS NOT NULL
  AND TRY_CONVERT(decimal(12,2), raw_amount) IS NULL;
```

`SET NOCOUNT ON` suppresses per-statement row-count messages from procedures and can reduce chatty client traffic; it does not change rows affected. `SCOPE_IDENTITY()` returns the last identity generated in the same scope, unlike `@@IDENTITY`, which can be affected by a trigger's insert into another identity table. Identity is not a gap-free sequence: rollbacks, caching and failed inserts can leave gaps. If a caller needs the generated key set from a multirow statement, use the `OUTPUT inserted.key` clause rather than assuming one scalar identity is sufficient.

## Transactions and error handling in scripts

A robust multi-step data change makes transaction intent explicit and defines what happens on error. A common template uses `SET XACT_ABORT ON`, `TRY...CATCH`, a transaction, and `XACT_STATE()` to decide whether rollback is required. `THROW` re-raises an error with its context; swallowing errors or returning success after a partial rollback is dangerous. Keep the transaction short and avoid external calls inside it. `XACT_ABORT` is useful, not universal protection: compile errors, client cancellation, distributed work and errors with special semantics require deliberate handling. A connection pool may reuse a session, so session settings and transaction cleanup should be explicit in procedures and drivers.

`GO` is parsed by client tooling, not by SQL Server. It cannot appear as a separator in a statement sent through ADO.NET or another driver; send separate batches instead. This matters for deployment scripts that declare variables, change database context, or create procedures. `CREATE OR ALTER` availability is version-dependent. Interview answers should state the target version when syntax or feature availability matters, rather than assuming every SQL Server edition and Azure service exposes identical behavior.
