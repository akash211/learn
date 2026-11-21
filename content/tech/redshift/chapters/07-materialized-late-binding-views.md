# Materialized Views and Late-Binding Views

Views offer two different contracts in Redshift. A standard view stores a query definition and runs it when referenced; it does not store the result. A materialized view (MV) stores query results so repeated consumers can avoid recomputing expensive joins or aggregations. A late-binding view delays validation of referenced objects until query time, allowing looser coupling across schemas and external tables. Choosing among them is a decision about freshness, latency, and dependency management.

## Materialized views: precompute with a refresh contract

An MV can accelerate recurring analytics where the source changes more often than the report needs to be recomputed. For example, daily sales by product and region can be aggregated once, then queried by dashboards with lower scan and join cost. The benefit depends on whether the MV's definition can be refreshed incrementally and whether its refresh work is cheaper than repeatedly executing the original query. Not every SQL construct or source is eligible for incremental refresh, and eligibility can depend on the definition and engine capabilities. Confirm the current limitations before treating incremental refresh as guaranteed.

```sql
CREATE MATERIALIZED VIEW analytics.daily_sales AS
SELECT sale_date, product_id, region_id,
       SUM(amount) AS gross_sales,
       COUNT(*) AS sale_count
FROM warehouse.sales
GROUP BY 1, 2, 3;

REFRESH MATERIALIZED VIEW analytics.daily_sales;
```

A refresh is not automatically a live view of the base tables. Consumers see the stored result as of its last successful refresh. Decide whether refresh is scheduled, triggered by a pipeline, or driven by automatic query rewrite support in the particular environment. Query rewrite can substitute an eligible materialized view for part of a user's query, but it is not a universal guarantee. Validate using `EXPLAIN` and monitor actual usage.

## Incremental versus full refresh

Incremental refresh processes changes rather than rebuilding the entire result, when the view definition and change history permit it. Full refresh recomputes all rows and can create a much larger resource event. Design MVs for incremental capability where possible, but do not simplify correctness requirements solely to qualify. Compare freshness goals, base-table churn, refresh duration, and the cost of recomputation. A refresh workflow should expose failures and lag to consumers instead of silently serving stale data indefinitely.

Redshift maintenance interacts with MVs: when a dependent view is stale and still needs deleted base-table rows to refresh incrementally, vacuum may retain those rows. Refreshing the view before vacuum can release that dependency. `VACUUM ... FORCE` can reclaim them but causes affected stale views to require full recomputation on their next refresh. MV lifecycle therefore belongs in both refresh design and storage operations.

## Standard and late-binding views

A standard view validates its referenced objects when it is created and records dependencies. It is useful for reusable logic, data abstraction, and controlled permissions. A late-binding view is created with `WITH NO SCHEMA BINDING`; Redshift does not verify the referenced relations until the view is queried. This is helpful when a view references external tables or when deployment order means that a referenced object may be created later. References must be schema-qualified. The flexibility moves failure detection from deployment time to query time, so it should be paired with validation tests.

Late binding allows the underlying table or external relation to change without automatically dropping the view, but it does not make incompatible changes safe. If the object is missing or expected columns no longer exist, queries fail when they reach it. Granting `SELECT` on the view does not remove the need to arrange access to referenced objects according to Redshift's rules and the owner's privileges. Recreating a referenced object may also require checking permissions again.

## Choose and observe deliberately

Use standard views for a stable relational interface whose dependencies should be checked early. Use late-binding views when loose coupling across deployment or Spectrum boundaries is worth delayed validation. Use MVs when repeated computation is the bottleneck and a documented refresh lag is acceptable. Avoid deeply nested layers that obscure query plans or make permission ownership difficult to reason about.

Monitor refresh duration, success, staleness, and storage as first-class service indicators. System views such as `STV_MV_INFO` describe current MV metadata; `SVL_MV_REFRESH_STATUS` and related history can help investigate refreshes on supported provisioned deployments. Check the current catalog and `SYS` views for the deployment in use. Test query rewrite with a representative query and plan instead of assuming that creating an MV guarantees its use.

## View governance and deployment

Views are interfaces and should be versioned with the same care as tables. A standard view can fail early when a referenced object is dropped or altered, which is valuable when the dependency is part of a coordinated schema deployment. A late-binding view shifts that check to query time. A deployment pipeline using late binding should therefore run a smoke query after creating or altering every referenced object and validate expected columns and types. Otherwise, a green DDL deployment can leave a broken production interface.

Ownership and permissions deserve explicit review. Determine which role owns the view, who can replace its definition, and what privileges are needed on the underlying schema and relations. If an object is dropped and recreated, do not assume the grants of the previous object carry forward. A view can expose a curated subset of data, but an inappropriate owner or broad underlying privilege can undermine that boundary. Test with a non-admin consumer account, not only the deployer.

For materialized views, define a freshness target and a refresh mechanism with a named owner. The refresh schedule should account for base-table load timing and late-arriving data. Monitor both completion and lag, and alert when refresh failures would cause downstream reporting to exceed its freshness promise. If query rewrite is relied on, verify eligibility with plans after view changes and keep a fallback query path. An MV that exists but is rarely refreshed or never selected by the optimizer is still consuming storage and operational attention.

A useful practice is to maintain two refresh tests: one following an ordinary small batch that should refresh incrementally, and another following a larger backfill that may force a full recompute. Record the expected duration and result row count. If a refresh unexpectedly switches to a full path, investigate which base relation or operation prevented incremental processing before the next production cycle. Changes to MV definitions should be deployed with their refresh job and downstream dashboards, not as isolated DDL.

## Common mistakes

- Treating a materialized view as transactionally current with its base tables.
- Assuming every MV definition supports incremental refresh.
- Forgetting that stale MVs can affect vacuum space reclamation.
- Using late binding to avoid dependency errors, then discovering failures only in production queries.
- Assuming a standard view precomputes data or a late-binding view grants access by itself.
- Creating MVs without an owner for refresh, freshness SLOs, and failure monitoring.
