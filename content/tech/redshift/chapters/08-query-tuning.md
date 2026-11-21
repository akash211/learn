# Query Tuning and Execution Plans

Effective Redshift tuning starts by identifying where time goes. A user experiences total latency, which includes queueing, compilation, execution, and result delivery. Improving a scan cannot help when the query spent most of its time waiting for WLM. Conversely, adding queue capacity will not fix a plan that reads far more blocks than necessary or spills large intermediates to disk. Use plan, history, workload, and table-state evidence together.

## Read EXPLAIN as a data-movement plan

`EXPLAIN` shows the optimizer's planned operations and estimated rows, but does not execute the statement. Begin at the bottom of the plan and trace scans, filters, joins, aggregation, sort, and redistribution. Ask how much data each step is expected to process and where it must move. For join nodes, `DS_DIST_NONE` indicates collocated data, while `DS_DIST_ALL_NONE` can be appropriate when a small table is replicated with `DISTSTYLE ALL`. `DS_BCAST_INNER` broadcasts the inner input, `DS_DIST_INNER` or `DS_DIST_OUTER` redistributes one side, and `DS_DIST_BOTH` moves both sides. These labels describe exchange strategy, not automatic verdicts: broadcasting a tiny filtered set can be cheaper than changing a large table's permanent distribution.

Pay particular attention to `DS_DIST_ALL_INNER`, which can concentrate work on a single slice when the table layout causes the inner relation to be redistributed there. For costly broadcast or redistribution, verify actual input size and table distribution before changing DDL. If estimates are wrong, run `ANALYZE` and investigate skew or predicate selectivity first. A distribution change can improve one join while worsening many others, so benchmark a representative workload.

## Compare estimates with execution

`EXPLAIN` estimates are hypotheses. `STL_QUERY`, `STL_QUERY_SUMMARY`, `SVL_QUERY_SUMMARY`, and supported `SYS_QUERY_HISTORY` / `SYS_QUERY_DETAIL` views provide execution evidence. On provisioned clusters, `SVL_QUERY_SUMMARY` breaks work into steps and reports rows, bytes, and execution characteristics. Compare planned rows to observed rows, identify the most expensive steps, and distinguish local scan work from redistribution, sort, and aggregation. Query IDs can have child steps or subqueries; do not mistake a single query's internal steps for separate user requests.

Look for disk spills and high temporary I/O on sort or hash steps. A spill indicates the operation could not complete in its allocated memory and wrote intermediate data to disk. It can arise from large joins, inaccurate estimates, high concurrency, or wide rows. Increasing global concurrency can make spills worse by reducing memory per query. Reducing selected columns, filtering earlier, fixing cardinality estimates, or changing workload isolation may outperform a blanket memory setting.

## Reduce work before adding capacity

Projection and predicate pushdown matter: select only needed columns and filter on useful sort-key or partition columns. Remove accidental many-to-many joins by verifying key uniqueness and row counts. Pre-aggregate when semantics allow, and avoid repeated scans of the same large relation if a materialized result makes sense. Use table statistics and `SVV_TABLE_INFO` to investigate stale statistics, unsorted data, skew, and compression. Ensure any large post-load change is followed by appropriate statistics collection.

For Spectrum queries, inspect external bytes and partitions scanned; local sort keys cannot optimize S3 files. For local tables, use `EXPLAIN` to see whether sort order and distribution support pruning and colocation. The same SQL rewrite can have no effect if the dominant cost is queueing or network movement.

## Reproducible tuning loop

1. Capture the exact query, parameters, concurrency, and freshness of inputs.
2. Measure queue and execution time separately; compare several representative runs.
3. Read `EXPLAIN`, then correlate it with actual step-level history.
4. Change one cause at a time: SQL shape, statistics, table design, WLM, or capacity.
5. Retest with realistic concurrency and data volume, including result correctness.
6. Keep the change only if it improves a stated objective without a worse regression elsewhere.

First-run compilation can distort comparisons, and cache warmth can make repeated runs look artificially good. Compare like with like and retain a baseline. Don't use an isolated timing result as evidence for a broad schema change.

## Estimate errors, skew, and plans

When estimated and actual rows differ substantially, locate the first step where the divergence appears. A scan that returns many more rows than estimated can make every later join and memory decision unreliable. Check stale statistics, predicate selectivity, correlated columns, and whether a literal filter matches the real data distribution. If the data is skewed by tenant or date, a query that is fast for the average value may be slow for a dominant value. Benchmark parameter values that represent both typical and worst-case populations.

Skew can appear in the plan as uneven slice work, but the cause may be a distribution key, a hot join key, a grouping cardinality problem, or uneven data arrival. Inspect per-slice evidence when available and compare it with `SVV_TABLE_INFO`. Avoid applying a single distribution-key change without considering how rows are consumed by other joins. Sometimes the better fix is to pre-aggregate a hot dimension, filter earlier, or split a pathological workload into a separate path.

Execution plans are not contracts: the optimizer can choose a different join order as statistics and table sizes change. Capture plans for high-value queries as diagnostic artifacts, but do not alert on harmless textual plan differences alone. Alert on measurable regressions such as increased queue or execution time, bytes scanned, spill volume, or result freshness. After a change, validate result correctness as well as speed; query rewrites involving joins and aggregates can accidentally alter duplicates or null semantics.

## Make measurements actionable

An effective query-tuning note preserves enough context for another engineer to reproduce the finding: query text or a safely normalized form, parameters, table sizes, relevant sort and distribution state, statistics freshness, WLM route, concurrency, and measurement time. A statement that a query “got slower” without these conditions cannot distinguish regression from normal variance. Protect sensitive literals and identifiers when capturing examples, and store the full diagnostic record in an access-controlled location.

When comparing two SQL formulations, check that they return the same rows and aggregate values, including duplicates, nulls, and time boundaries. A faster query that drops duplicate fact rows or changes null semantics is a correctness defect. For incremental transformations, compare totals and key uniqueness against a trusted baseline. Run the tests under representative concurrency because a query's memory and queue behavior can change when other workloads are present.

Use query labels or application metadata to group related work where supported. This allows the team to compare a dashboard family without exposing every raw statement to a broad audience. Set a regular review cadence for the highest-consumption workloads, and remove or rewrite jobs that no longer have an owner. Tuning is not only a response to incidents: it is a way to keep a warehouse's growth and access patterns aligned before they become a capacity emergency.

## Common mistakes

- Treating every `DS_BCAST_INNER` as wrong, even when the inner relation is tiny.
- Reading `EXPLAIN` without comparing estimates to actual rows and step metrics.
- Increasing concurrency or cluster size before finding queue, spill, or scan causes.
- Ignoring WLM queue time in an end-to-end latency complaint.
- Changing distribution or sort keys based on a single query and not re-testing the workload.
- Assuming a named system view is available and identical on both provisioned and Serverless deployments.
