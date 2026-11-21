# Schema Enforcement and Evolution

A Delta table stores a schema in its transaction-log metadata. The schema is part of the table contract, not an incidental property inferred from whichever Parquet file a reader happens to inspect. On a write, Delta checks that incoming data can be safely represented under the table schema. This catches many accidental changes—such as a misspelled column or incompatible type—before they become a confusing downstream read problem.

## Enforcement is the default

Suppose a table has `customer_id STRING`, `amount DECIMAL(12,2)` and `event_date DATE`. Appending a DataFrame with `customerId`, `amount STRING`, or an unexpected nested structure should not be treated as harmless. With enforcement, the write fails rather than quietly creating a mixed-schema table. A failed write is useful feedback: compare source and target schema, check nullability and type conversion, and determine whether the input is malformed or the table contract genuinely needs to change.

Schema enforcement does not mean every data-quality rule is automatically enforced. A schema can require types and column structure, but business constraints such as “amount is non-negative” need explicit constraints or pipeline validation. Null handling, timestamp zones, decimal precision, case sensitivity and nested-field behavior should be tested in the engine that owns the write.

## Evolution should be explicit

Schema evolution is the controlled path for an intentional source change. For compatible changes such as adding a new column, Spark's Delta integration supports schema merge options in selected write operations. Common examples use `.option("mergeSchema", "true")` on a write or an operation-specific schema-evolution option for `MERGE`. Exact syntax and supported evolution behavior depend on delta-spark and Spark versions; platform-specific conveniences can differ.

```python
(df.write.format("delta")
   .option("mergeSchema", "true")
   .mode("append")
   .save(path))
```

This turns a particular write into a schema-changing transaction. It does not make arbitrary type changes safe, and it should not be switched on globally as a cure for every mismatch. Schema merge can convert a misspelled source field into a persistent extra column, increasing ambiguity and adding a protocol or compatibility consequence in some cases.

Use explicit DDL or `ALTER TABLE` when the table contract should change independently of data ingestion. For example, an intentional new nullable column is better introduced with a reviewed migration than discovered by a production batch at 2 a.m. Type widening can avoid a data rewrite for certain supported widening conversions, but availability is version- and protocol-dependent; some releases have identified type widening as preview. Do not present preview or recently released behavior as universal compatibility.

## Nested schemas and column mapping

Nested structs, arrays and maps need the same care as top-level columns. A producer may add a field inside a struct, change its nullability, or alter a nested type. Readers and writers must agree on how that change is represented. Column mapping separates logical column names from physical Parquet names, enabling certain renames and drops without rewriting every file. It is a table feature that changes protocol requirements: older readers may be unable to interpret the table. A simple `ALTER TABLE RENAME COLUMN` is not automatically safe for all external clients.

When columns are renamed or dropped, inspect the relevant client documentation and table protocol. A logical field disappearing from the current schema does not necessarily mean its old bytes are purged from historical files. Data lifecycle and schema lifecycle are different concerns.

## A practical evolution workflow

1. **Detect and classify.** Capture source schema changes and decide if the change is additive, a safe widening, a rename, a semantic change or invalid input.
2. **Review the contract.** Ask which consumers use the column, whether nulls are possible, and whether changed units or meaning require a new field rather than reusing the old name.
3. **Validate compatibility.** Check the Spark/Delta versions and every external reader/writer against any feature or protocol upgrade.
4. **Apply deliberately.** Use a migration or a narrowly scoped merge-schema write. Keep the change in a transaction and avoid mixing unrelated schema changes with large data backfills.
5. **Test consumers.** Run representative queries, downstream schema checks and time-travel reads if the feature affects historical interpretation.
6. **Observe and document.** Record the table version, change owner and rollback plan. A protocol upgrade may be irreversible even if the column can later be removed.

For semi-structured payloads, choose deliberately between a stable typed schema, a map/variant representation where supported, or raw JSON plus parsed columns. Newer Delta releases have introduced `VARIANT` support and related capabilities, but engine support and preview status vary. A flexible type reduces ingestion friction but does not eliminate the need to version semantic fields or test readers.

## Common mistakes

- **Turning on schema merge everywhere.** This can promote source drift and typos into the shared contract.
- **Confusing addition with reinterpretation.** A column changing from cents to dollars is not a type-level schema change; it is a semantic breaking change.
- **Assuming compatible Spark types mean compatible engines.** Protocol features and physical column mapping can exclude older readers.
- **Changing nullability by assumption.** Existing nulls and writer checks can make an apparently simple tightening fail.
- **Treating schema overwrite as a routine repair.** It can discard metadata or make historical files hard to interpret.

## Production notes

Store schema snapshots and validation results with pipeline releases. In a multi-producer lakehouse, assign a clear owner to shared table contracts; otherwise independent ingestion jobs can race to redefine the same schema. Prefer additive, nullable changes for compatibility, and publish a deprecation window before dropping or reinterpreting columns. For any feature that upgrades table protocol, test the oldest production reader and writer—not just the latest notebook runtime.

## Evolution as a consumer contract

Schema evolution is safest when producers and consumers have an explicit compatibility policy. Add a field with a stable name and meaning, document its null behavior, and let consumers adopt it before making it mandatory. If a field's meaning changes, create a new column or a new schema version instead of silently reusing its name. A compatibility test can compare the proposed schema with the published contract and fail a deployment when a breaking change has no migration plan.

For a shared table, also examine historical rows. A newly added field may be null in old files even when new writes populate it; queries must handle that transition. A type widening may be logically safe for one engine while unsupported in another, and a renamed column can affect generated SQL, dashboards and external readers. Capture a sample of each major client in CI where practical. This makes the schema migration an ordinary release artifact rather than an incident discovered by a downstream job. Keep the compatibility result with the table's schema version so a new connector release can be checked against the same contract before deployment.