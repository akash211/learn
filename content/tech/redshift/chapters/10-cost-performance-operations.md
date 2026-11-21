# Cost and Performance Operations

Operating Redshift means aligning capacity with workload while keeping query behavior predictable. There is no single “right-size” action: elastic resize, concurrency scaling, Serverless capacity controls, table design, and workload scheduling solve different problems. An operator needs a baseline of latency, queueing, throughput, storage, and data freshness before changing capacity. Without it, a resize can hide an inefficient query while making costs and future diagnostics harder.

## Elastic resize and capacity planning

Elastic resize changes the compute capacity of a provisioned cluster more quickly than some traditional resize paths, subject to supported node types, configuration, and service constraints. It can be useful for predictable peaks—for example, scaling before a monthly close and returning to baseline afterward. A resize can alter the number of slices and how data is distributed, so its effects include more than raw CPU. Check table distribution and representative query plans after a topology change, and allow for any required rebalancing or operational transition.

Classic resize remains an option in some situations, often with different duration and transition characteristics. The correct choice depends on the source and target configuration and the current service behavior. Plan a maintenance window or an approved operational procedure, verify snapshots and rollback options, and test client behavior during transitions. Never assume that a resize is instantaneous or invisible to every session.

## Serverless trade-offs

Redshift Serverless removes some cluster-capacity management and can suit intermittent, variable, or newly launched workloads. Workgroups and namespaces define operational boundaries; capacity scales within configured controls. This can reduce idle-capacity management but is not a guarantee that any query has fixed latency or cost. Spiky queries, external scans, concurrency, and poorly bounded workloads still need monitoring and guardrails. Compare Serverless with provisioned clusters using actual workload patterns, including idle periods, peaks, refresh cycles, sharing, and operational ownership—not an assumed hourly or per-query price.

Use capacity limits and usage monitoring to keep unexpected workload changes visible. Do not choose a capacity ceiling so low that the workload repeatedly throttles, and do not remove safeguards simply to make a benchmark pass. Treat environment-specific billing dimensions as something to verify in current AWS documentation and account data; this module intentionally avoids quoting pricing numbers.

## Monitor the workload, not just the cluster

A useful operational dashboard separates queue duration, execution time, concurrency, bytes scanned, spill indicators, load throughput, maintenance state, and storage trends. For provisioned clusters, `STL_QUERY`, `STL_WLM_QUERY`, `SVL_QUERY_SUMMARY`, and `STV_WLM_QUERY_STATE` provide different kinds of evidence: history, per-step details, and current snapshots. `SVV_TABLE_INFO` helps connect table design and maintenance state to query changes. `SYS_QUERY_HISTORY`, `SYS_QUERY_DETAIL`, and related SYS views can simplify monitoring across provisioned and Serverless environments; verify supported fields before writing a permanent integration.

System-table history is not an observability warehouse. `STL_` log history is retained for a limited time, and `STV_` tables represent transient state. Export the metrics and query identifiers needed for longer-term baselines, audit, and trend analysis. Filter out system-generated work where appropriate, protect query text, and retain enough context to compare like workloads over time.

## Cost hygiene and operational cadence

Review expensive queries by total resource consumption, not only worst single-run latency. A moderate query executed thousands of times can matter more than one rare long scan. Identify redundant BI refreshes, unbounded ad hoc scans, repeated computation that could be materialized, and overly frequent full refreshes. Apply workload controls to prevent one consumer from monopolizing shared capacity. For predictable periodic jobs, schedule large ingestion and maintenance away from peak interactive traffic when freshness allows.

A weekly or monthly review should include capacity utilization, queue wait, concurrency scaling usage, Serverless usage, top queries, table growth, unsorted and deleted-row indicators, load failures, and materialized-view freshness. Set service-level objectives with the report owners: freshness, p95/p99 latency, and acceptable queue delay. When an alert fires, distinguish expected peak from a regression; compare the same hour, data volume, and concurrency against the baseline.

## Capacity changes as controlled experiments

Capacity work is easier to assess when treated as a controlled experiment. Define the hypothesis first: for example, “queue wait dominates the morning dashboard SLO, and additional capacity will reduce it.” Select a stable set of queries, a representative concurrency pattern, and a measurement period. Record expected effects on execution time, queue time, batch completion, and usage. If only a subset of users benefits, that may point to routing or isolation rather than a cluster-wide size change.

Elastic resize and other topology changes can alter slice count and data placement. Query performance may shift even when SQL and table definitions do not. After resizing, compare key table state and plans, and allow the system to complete required transitions before making a final judgment. Avoid concurrent changes to WLM, sort keys, and capacity because they make cause and effect difficult to determine. If a rollback is needed, have a tested route back and communicate which sessions or jobs may be affected.

For Serverless, observe capacity utilization and workgroup behavior over a full cycle, including idle periods and bursts. Apply usage controls that prevent runaway activity while leaving enough headroom for legitimate peaks. A workload with periodic large scans may need query-level guardrails even when capacity is managed. Keep operational dashboards focused on outcomes—latency, freshness, throughput, and reliability—and use usage metrics to explain them rather than treating resource utilization as the goal by itself.

Capacity should be reviewed in business terms as well as technical metrics. A dashboard owner may prefer consistent freshness over an occasional fast result; a finance close may accept a wider latency window in exchange for dependable completion. Document these service objectives and identify who can approve a change that shifts cost or affects another workload. When teams share a cluster or workgroup, publish the change schedule so they can distinguish planned scaling from an outage.

A capacity forecast should include data growth and workload growth separately. More stored history may increase scan time even if the active user count stays constant, while more concurrent BI sessions can increase queueing without materially changing total bytes. Track trends in both and revisit sort, distribution, and retention strategies before assuming the only answer is more compute. For S3-backed workloads, file growth and partition proliferation are additional dimensions that cluster resizing cannot correct.

For any operational change, preserve a clear rollback path and success criterion. A resize that temporarily improves latency but pushes WLM queues elsewhere is not a success. A cost reduction that breaches freshness SLOs is also not success. Review outcomes with workload owners after the change window and adjust guardrails based on observed behavior. This closes the loop between technical tuning and the service that Redshift is expected to provide.

## Production notes

- Keep an operational record of resize events and correlate them with query latency and distribution changes.
- Use change management for parameter groups, IAM roles, WLM, table keys, and workgroup capacity.
- Verify snapshots, maintenance windows, and recovery procedures before disruptive changes.
- Review current AWS documentation for feature eligibility and console/API options because the service evolves.

## Common mistakes

- Scaling up before identifying whether a workload is queue-bound, scan-bound, or spill-bound.
- Comparing Serverless and provisioned using a single peak query rather than a representative usage cycle.
- Treating concurrency scaling as permanent baseline capacity.
- Ignoring repeated moderate queries and focusing only on one-off long-running statements.
- Relying on transient system tables as the only long-term monitoring record.
- Making capacity or cost claims from outdated or context-free pricing assumptions.
