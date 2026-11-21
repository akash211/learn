# Tests and Data Contracts

A dbt model can compile and successfully create a table while still containing duplicate keys, null identifiers, invalid relationships or wrong business logic. Testing makes assumptions executable. The useful question is not “how many tests do we have?” but “which important failure modes would this test reveal, and what action follows a failure?”

## Data tests check relations after build

A data test is a query that returns failing records. If it returns zero rows, it passes; if it returns rows, dbt reports a failure count. Built-in generic tests commonly include `not_null`, `unique`, `accepted_values` and `relationships`. Declare them in model YAML:

```yaml
models:
  - name: dim_customers
    columns:
      - name: customer_id
        data_tests:
          - not_null
          - unique
      - name: status
        data_tests:
          - accepted_values:
              arguments:
                values: ['active', 'inactive']
```

`relationships` checks that values in one column exist in a referenced column, expressing a referential-integrity expectation. It does not enforce a database foreign-key constraint; it queries the data as a test. The newer `data_tests:` property clarifies that these are data tests; many projects still have legacy `tests:` syntax. Test syntax and nesting can vary with dbt version, so keep project conventions compatible with the pinned release.

Generic tests are parameterized reusable SQL. Teams can define custom generic tests in macros, with arguments and optional configuration, then attach them to multiple models or columns. The test name and arguments become part of the test node in the project graph. This is ideal for repeated expectations such as positive balances, valid date bounds or uniqueness across a composite key.

A singular test is a SQL file under `tests/` whose query returns rows violating one project-specific rule. For instance, a `fct_orders_amounts.sql` test could return orders where total amount differs from the sum of line amounts beyond a tolerance. Singular tests are easy for one-off assertions; if the same rule is needed repeatedly, refactor it into a generic test rather than copy-pasting.

## Unit tests check SQL logic with fixtures

dbt introduced native SQL model unit tests in v1.8. They define static `given` rows for each `ref()` or `source()` input and expected output rows. These exercise transformation logic before a complete model build and are valuable for tricky `CASE` rules, date handling, window functions, regex logic and regression-prone edge cases. They complement data tests, which inspect the actual built relation.

```yaml
unit_tests:
  - name: cancelled_orders_are_excluded
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - {order_id: 1, status: placed}
          - {order_id: 2, status: cancelled}
    expect:
      rows:
        - {order_id: 1, status: placed}
```

The exact YAML format supports additional input and override features; all model dependencies used by the unit-test SQL must be represented as inputs. Unit tests are not a general SQL emulator and have adapter and feature limitations. They do not replace integration tests against the target warehouse, test the actual ingestion pipeline, or prove that production data satisfies assumptions. Use static fixtures to test the branch logic you control; run integration/data tests to verify deployed relations.

## Contract: declared schema boundary

A model contract specifies expected output columns and data types in YAML and can be enforced for supported materializations and adapters. With `contract: {enforced: true}`, dbt checks the model's declared result against the contract before materializing it. It is most useful at a stable interface—such as a public mart consumed by BI, downstream projects or a data product—where silent schema drift breaks consumers.

Contracts are not a substitute for data tests. A contract checks the shape and types of the output, not that each value is valid, complete or semantically correct. A model can satisfy its column list while assigning the wrong revenue definition. Constraints may be supported differently per adapter and materialization; views support a narrower set than tables, and some resource types do not support enforced contracts. Incremental contracts require careful `on_schema_change` behavior: for supported configurations, choose `append_new_columns` or `fail` rather than allowing a mismatch to silently persist. Treat column removal or type changes as potentially breaking changes.

A contract should be reviewed like an API schema. Decide which fields are stable, document meaning and nullability expectations, and coordinate breaking changes with consumers. Tests can assert data properties such as uniqueness and accepted values; contracts establish the structural promise. A database constraint may enforce a rule at write time, but support and enforcement behavior vary, so do not assume a YAML constraint is physically enforced everywhere.

## Prioritize by risk and response

Not every model needs every test. A high-value mart may need a contract, key uniqueness, non-null identifiers, accepted business statuses, relationships to dimensions, a reconciliation test and unit tests for its transformation rules. A scratch intermediate model might need fewer checks. Consider data criticality, consumer count, source volatility and cost of an undetected failure.

Tests also consume warehouse queries. A broad relationship test across huge tables may be expensive; use filters, partition-aware logic or appropriate test configuration where supported. Avoid making a fragile test warning-only without understanding that this weakens the deployment gate. Severity, tags and selection can support a policy: fast critical tests on pull requests, broader checks on scheduled production runs.

When a test fails, read the failing records and determine whether the data is wrong, the assumption is wrong, or the model is wrong. Do not reflexively weaken the test until it passes. Identify an owner and a clear action: upstream incident, data contract change, model fix, or an approved exception. A failure with no response path becomes alert noise.

## Common mistakes

- Confusing a unit test's expected output with a test of production data; it uses static fixtures.
- Treating a contract as semantic validation. It checks schema, not the truth of business calculations.
- Adding `unique` without checking the model's grain; the true key may be composite or uniqueness may not be expected.
- Leaving YAML with ambiguous test arguments while upgrading across versions; pin and validate syntax.
- Suppressing a failing test instead of investigating whether it caught a real upstream or transformation defect.

## Production notes

Use `dbt build` in CI when you want selected models and their tests in one dependency-aware command; `dbt run` alone does not execute tests. Separate fast unit tests from expensive warehouse data checks where appropriate, but do not merge code without a credible integration signal. Version contracts with the SQL, review them as consumer-facing changes, and retain test artifacts so failures can be tied to exact code and environment.

An actionable test definition names the expectation in business terms, scopes it to the intended grain and identifies the owning team. For instance, “one row per settled payment” is clearer than a test called `unique_id_2`; the owner can determine whether a failure means a duplicate source event, a faulty join or an invalid contract. Document accepted exceptions and their expiry rather than editing test logic to conceal a temporary upstream incident. This creates a review trail for intentional data-quality compromises. Run fast, high-signal checks near the pull request and schedule expensive broad checks at a cadence that can still detect problems before consumers are harmed.
