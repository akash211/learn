# Sources, Freshness and Exposures

A dbt project transforms data, but it usually does not ingest it. Sources give the project a named interface to externally managed relations; freshness checks help determine whether upstream data is arriving; exposures describe important downstream consumers. Together they make the edges before and after dbt models more visible without pretending that dbt owns the whole data supply chain.

## Declare external relations as sources

A source is declared in YAML, usually alongside staging models. It groups tables under a logical name and can configure database and schema information, descriptions, columns, tests and freshness. Model SQL then uses `source()` rather than spelling a physical table name:

```yaml
sources:
  - name: app
    database: raw
    schema: storefront
    tables:
      - name: orders
        description: Order records loaded from the application.
        columns:
          - name: order_id
            data_tests: [not_null, unique]
```

```sql
select order_id, customer_id, created_at
from {{ source('app', 'orders') }}
```

The arguments to `source()` are the declared source and table names. dbt resolves them for the target, creates a graph node and edge, and makes the source visible in docs. A source is a logical declaration, not an ingestion job; an external loader must create and maintain the physical table. Treat source names and columns as interfaces, and do not silently repoint a source to a different data product without review.

`source()` also prevents raw dependencies from disappearing behind hard-coded schema names. It supports database and schema overrides per environment where configured, allowing development and production profiles to resolve appropriately. Explicit identifiers and quoting configuration may be needed for mixed-case or reserved-word names; use consistent naming rather than relying on platform-specific implicit case behavior.

## Freshness is a data-arrival signal

Freshness checks compare a configured timestamp column in a source table with a threshold. Depending on the source configuration and adapter, dbt evaluates the maximum loaded timestamp and reports status such as pass, warn or error. A simplified configuration looks like:

```yaml
sources:
  - name: app
    tables:
      - name: orders
        loaded_at_field: _ingested_at
        freshness:
          warn_after: {count: 12, period: hour}
          error_after: {count: 24, period: hour}
```

Run `dbt source freshness` to check configured sources; it is separate from `dbt run` and from a model's transformation tests. Freshness tells you whether a chosen loading timestamp looks recent, not whether every source record arrived, whether the values are correct, or whether business events happened recently. A table can be fresh because one new row arrived while an important partition is missing. Conversely, an old timestamp might be expected for a quiet or seasonal source.

Choose the right field. A business `updated_at` value may be backfilled or edited, while a reliable ingestion timestamp indicates when the warehouse received the row. Freshness thresholds should account for source cadence, time zones, weekends and expected delivery latency. A warning threshold provides lead time; an error threshold expresses a true service-impact boundary. Communicate which upstream team owns each alert and how to distinguish loader failure from a source that legitimately had no new data.

Freshness results can be included in artifacts and scheduled in an orchestration workflow. They do not automatically delay every downstream model unless the orchestration and selection flow explicitly enforces that dependency. If freshness is a release gate, make it part of the build sequence and fail or alert deliberately rather than assuming a source declaration alone blocks builds.

## Exposures connect models to consumers

An exposure declares a downstream use of dbt-managed data, such as a dashboard, application, notebook or ML job. It can include a human-readable name, type, owner, URL, maturity, description and upstream `depends_on` references. These references allow dbt docs to show lineage from models toward the consumer and help teams assess impact when an upstream node changes.

```yaml
exposures:
  - name: weekly_revenue_dashboard
    label: Weekly revenue dashboard
    type: dashboard
    owner:
      name: Analytics
      email: analytics@example.com
    depends_on:
      - ref('fct_revenue')
```

An exposure does not execute the BI dashboard or verify its calculations. It is metadata supplied by the project author. Keep it current when dashboards are retired, moved to a different model or given a new owner. A stale exposure misleads impact analysis; a missing exposure makes a seemingly isolated mart look unused.

Selectors can use exposures to locate upstream dependencies. For example, `dbt build --select +exposure:weekly_revenue_dashboard` selects resources feeding the declared exposure, subject to selection semantics and resource types. This can be useful for focused CI, but inspect the resulting selection with `dbt ls` first. The graph only knows what is declared, so an exposure that omits a dependency cannot include it.

## Model source boundaries explicitly

Sources, models and exposures can form a larger dependency chain: external application table → source declaration → staging model → fact table → dashboard exposure. The chain communicates operational responsibility. The ingestion team owns the source arrival; the dbt project owns transformations; the dashboard owner owns the consuming visualization. Metadata is most effective when those boundaries and contacts are precise.

For multiple environments, avoid defining every raw table as a different source merely because schemas differ. Use environment-aware configuration so the logical source represents the same upstream product across targets. On the other hand, if dev and prod read different datasets or have different quality expectations, record that explicitly. Names should express business or system boundaries, not one developer's temporary schema.

## Common mistakes

- Using `source()` as though it creates or loads the raw relation. It only declares and references an upstream table.
- Setting freshness on a business event timestamp that can be backdated instead of a reliable arrival timestamp.
- Treating freshness as proof of completeness or correctness. It checks recency of the selected timestamp signal.
- Assuming source freshness is automatically executed before models; schedule and gate it explicitly.
- Leaving an exposure's owner and `depends_on` list stale, producing misleading lineage and impact assessments.

## Production notes

Define source ownership and loading-time conventions before setting thresholds. Retain freshness artifacts and route warnings to the team able to act. Use source tests for structure and key expectations, freshness for arrival timeliness, model tests for transformed data, and exposures for consumer lineage; these signals answer different questions. Regularly compare declared sources and exposures with the real ingestion catalogue and BI inventory so the graph stays operationally useful.

A practical ownership record can include the source system, ingestion owner, expected cadence, loaded-at column, freshness thresholds, critical partitions and escalation route. The purpose is not to duplicate a full data catalogue in YAML, but to give an operator enough context to route a failure and determine whether a warning is expected. Tie exposure ownership to an actual team or individual and remove retired dashboards. When a source schema changes, review both the dbt source properties and the ingestion contract; a model may continue compiling while a newly added or renamed upstream field changes meaning. Freshness checks, source tests and downstream reconciliations should be designed together, with distinct thresholds and clear remediation.
