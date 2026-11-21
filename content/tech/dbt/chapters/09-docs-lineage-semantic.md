# Documentation, Lineage and the Semantic Layer

A dbt project can make transformation ownership and meaning discoverable, but only if its metadata is maintained alongside its SQL. Descriptions, generated documentation, lineage and semantic definitions help different consumers answer different questions: what does this relation mean, where did this field come from, who owns the dashboard, and how should a metric be computed consistently?

## Document models and columns with the code

Model properties are typically declared in YAML next to the model. A model description explains its purpose and grain; column descriptions define meaning, units, important nullability and caveats. Resource metadata may include owners, tags, groups, access and maturity as supported by the project's version and conventions. Good descriptions are concise and operational: “one row per submitted order, including cancelled orders” is more useful than “orders model.”

Descriptions can flow into database comments when persistence is configured and supported by the adapter, and they appear in generated dbt documentation. A description is not automatically a contract or validation rule. Use tests for executable data expectations and contracts for supported schema guarantees. Keep descriptions near the model so a SQL change that changes business meaning also updates its documentation in the same review.

`dbt docs generate` creates documentation artifacts and, when configured to connect to a warehouse, a catalog describing observed relations and columns. `dbt docs serve` serves the generated site locally for inspection. Generation may query the warehouse to collect catalog information and can therefore require database access and incur warehouse work. The site combines project metadata and graph information; it is only as accurate as the manifest, catalog and authored descriptions supplied to it.

## Lineage reveals impact and gaps

The DAG displayed in documentation shows dependencies from `ref()` and `source()` declarations and declared exposure relationships. Selecting a model shows its parents and children. This is useful for impact analysis, onboarding and debugging a missing field through staging and marts. It is not a magical query parser that discovers every hard-coded table reference in arbitrary SQL, and it does not infer undocumented dashboard dependencies.

Lineage is built from the parsed project graph and artifacts, so the docs site should correspond to a specific project revision and target context. If it is stale or generated from another environment, it can misrepresent current models or omit newly declared dependencies. An artifact bundle tagged with the commit SHA and environment makes it easier to tell what the graph describes.

A model's graph location also informs ownership and access. Staging relations may be internal implementation details; curated marts may be public to a group or downstream project. Use access and group conventions deliberately rather than assuming a file path enforces permissions. Database grants and platform policies remain separate controls.

## Metrics and the semantic layer

A semantic layer aims to define reusable business entities, dimensions, time dimensions and measures so that metrics are computed consistently across tools and queries. In dbt's ecosystem, semantic models and metrics have evolved over multiple releases and product capabilities; configuration and query interfaces depend on the dbt version and whether the project uses Core or Cloud services. Treat “semantic layer” as a governed modeling capability, not a synonym for a `metrics.sql` file or a dashboard calculation.

The goal is to express shared definitions such as net revenue or active customers once with clear grain and dimensions. If every BI workbook implements “net revenue” differently, teams can compare charts that look aligned but use different exclusions or time windows. A semantic definition can centralize calculation and enable consistent querying across consumers. It still requires business agreement: dbt cannot decide whether refunds are subtracted by transaction date or order date.

Before introducing semantic definitions, identify a stable model grain, define metrics in plain language, establish source-of-truth fields and verify how the intended clients query them. Keep a representative reconciliation against trusted reports. Version and test changes to metric meaning like API changes. A semantically centralized but poorly governed metric spreads confusion faster than duplicated SQL.

The product surface has changed over time, so do not copy old syntax from a blog post without checking current documentation for the exact project version and deployment. If a team does not use dbt's semantic services, it can still document metrics in model descriptions or a controlled metrics layer elsewhere; the key requirement is explicit ownership and one authoritative definition.

## Use docs in workflows

Documentation is most useful when it is part of development and release: reviewers see changed descriptions beside changed SQL; CI can parse and validate YAML; a production job generates artifacts from the deployed commit; users browse a stable docs site or catalog. Ensure the access model for docs is appropriate because descriptions and catalog metadata may expose internal schema or business information.

Descriptions, tests, exposures and semantic definitions are complementary. A description says what a field means; a test detects whether values violate a rule; an exposure names a downstream consumer; a semantic definition tells clients how to query a business measure. Strong projects connect them rather than duplicating prose across readmes and dashboards.

## Common mistakes

- Treating generated docs as automatically accurate even when descriptions and exposures have not been maintained.
- Assuming lineage discovers raw-table dependencies written as hard-coded names or dashboards that are not declared as exposures.
- Believing a description enforces the documented rule; use tests or contracts for enforceable expectations.
- Reusing semantic-layer syntax from a different dbt release or product mode without validating compatibility.
- Publishing catalog metadata without checking what database names, columns or descriptions reveal to the audience.

## Production notes

Generate docs from the release artifact and retain a revision identifier. Establish a lightweight standard for model grain, owners, column descriptions and exposure maintenance. For metrics, agree on grain and business semantics before choosing a technical implementation, then reconcile a sample against existing trusted outputs. A discoverable graph is valuable only when its source metadata is reviewed as part of ordinary model changes.

For a metric definition, write a short decision record that states its numerator, denominator, aggregation behavior, time dimension, included statuses, handling of refunds or corrections, and expected grain. Then compare the semantic result with an independently accepted calculation over a limited period. Document how a consumer identifies the correct metric and dimensions, and who approves a definition change. If two teams use different valid definitions, name and describe both rather than quietly changing one. Semantic governance is an ongoing coordination practice: product logic evolves, and the metadata must have an owner who reviews its impact on dashboards, APIs and historical comparisons.

Lineage can guide this review: identify upstream fields that feed the metric, the transformation models that alter them and every declared exposure consuming the result. Check for additional consumers outside dbt's graph, such as scheduled extracts or ad hoc notebooks, before making a breaking change. A model's graph position does not guarantee its only readers are documented. Share the proposed definition and migration date with those owners, keep the previous calculation available long enough to reconcile the transition, and record the final semantic decision next to the model or metric metadata.
