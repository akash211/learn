# Workload Management: WLM, Queues, and SQA

Workload management (WLM) decides how queries wait for and use cluster resources. A well-designed system does not maximize the count of simultaneously running queries; it gives each workload a predictable share of memory and execution capacity while keeping important work from waiting behind unrelated jobs. Queues and service classes are the mental model for understanding this behavior, even when automatic WLM makes many allocation decisions dynamically.

## Queues, routing, and concurrency

WLM routes queries to queues using rules based on user groups, query groups, query monitoring rules, and other configuration. A queue can separate dashboards from scheduled transformations, ad hoc analyst work, or ingestion. This protects a latency-sensitive workload from a long batch scan and makes service behavior observable. If everything enters one broad queue, small queries can sit behind resource-heavy jobs, and the administrator loses a clear lever for prioritization.

Automatic WLM uses query priorities and dynamic memory/concurrency allocation to make decisions based on workload needs. Manual WLM instead configures explicit queues and slot counts. Automatic WLM is usually the sensible baseline because static concurrency settings can waste memory or oversubscribe it as query shapes vary. Manual WLM remains useful where the workload needs explicit, stable resource partitions and the operator can manage the trade-offs. Do not copy a queue configuration from another cluster without considering node size, query mix, and peak concurrency.

A slot count is not an independent throughput knob. Increasing concurrent slots can reduce memory available to each query and trigger disk spills. Decreasing slots can lengthen the queue while allowing complex queries to complete faster. Tune using both queue time and execution time. `STL_WLM_QUERY` records queue and execution details for provisioned clusters; `STV_WLM_QUERY_STATE` and `STV_WLM_SERVICE_CLASS_STATE` provide current snapshots. For cross-environment monitoring, review the applicable `SYS` workload views as well.

## Short Query Acceleration

Short Query Acceleration (SQA) identifies eligible short-running queries and executes them in dedicated resources rather than making them wait behind longer work in a user-defined queue. Redshift predicts query duration from workload behavior; the maximum runtime threshold can be dynamic or configured. Short read-only queries and certain CTAS queries can be eligible. SQA is not a replacement for sensible WLM routing: queries need to be eligible and in the relevant path, and a query that exceeds its expected short runtime may be returned to a regular queue.

SQA is useful for dashboards and interactive tools where a modest query should not wait behind a large transformation. Monitor how many queries use the SQA service class, their queue time, and whether they are evicted or run longer than expected. Avoid artificially labeling substantial scans as short just to get priority; that undermines the isolation model and produces unpredictable behavior.

## Concurrency scaling

Concurrency scaling adds transient cluster capacity for eligible queries when queues experience concurrency pressure. It can be enabled for selected WLM queues, allowing supported reads and some write/ETL operations to run on a concurrency scaling cluster instead of waiting. Query eligibility is constrained by operation type, table design, deployment configuration, and service rules. It is not a transparent second cluster for every statement, nor is it a remedy for a single badly planned query.

Think of it as a burst-handling mechanism. If query volume regularly pushes work into scaling, examine whether the workload should be isolated, queries improved, or baseline capacity changed. Check the `concurrency_scaling_status` field in relevant query history and compare scaled execution, main-cluster execution, and queue time. The service exposes concurrency-scaling-specific views such as `SVCS_QUERY_SUMMARY`; older provisioned views may not capture all environments in the same way.

## Query monitoring rules and operational evidence

Query monitoring rules can observe metrics and take configured actions such as logging, hopping, or aborting a query. They are guardrails, not query optimizers. An abort threshold for a runaway scan can prevent resource starvation, but a poorly chosen rule can cancel legitimate work. Test rules with representative load and communicate their behavior to workload owners.

Track at least three dimensions: queue latency, execution latency, and resource intensity. A rising queue time with stable execution time suggests concurrency or routing pressure. A rising execution time can indicate plan regression, more data, stale statistics, spills, or external scan changes. A cluster that appears “busy” is not enough evidence to resize: determine which workload is consuming resources and whether that consumption delivers useful results.

```sql
-- Provisioned-cluster WLM history; confirm columns for your environment.
SELECT service_class, final_state,
       AVG(total_queue_time) AS avg_queue_us,
       AVG(total_exec_time) AS avg_exec_us,
       COUNT(*) AS query_count
FROM stl_wlm_query
WHERE userid > 1
GROUP BY 1, 2
ORDER BY 1, 2;
```

System-log rows may contain query text or other sensitive details. Grant visibility only to roles that need it, and export metrics rather than raw SQL where possible.

## Queue design in practice

Create workload groups around service objectives rather than organizational labels alone. A reporting queue might prioritize predictable dashboard latency, while a transformation queue may favor throughput and tolerate longer completion time. Keep routing rules mutually understandable: a user group and a query group can both match, and rule order or classification can produce surprising placement. Test the route by submitting representative statements and checking their actual service class, not just by reviewing the intended configuration.

Avoid over-fragmenting the queue system. Every queue boundary creates operational decisions and can leave capacity idle in one group while another waits, depending on the WLM model. Automatic WLM can flex resources across work, while manual queues can enforce explicit isolation at the cost of more tuning. There is no universal queue count. Evaluate tail latency, batch completion, memory behavior, and fairness under the same mixed workload. Query monitoring rules can provide guardrails for runaway scans, but a rule should be tuned with production-like queries so a legitimate month-end job is not repeatedly aborted.

A useful incident review labels each slow request with both its route and its plan behavior. If an interactive request waits because a large batch fills its queue, routing or SQA may help. If it has a short queue and spills during execution, routing is unlikely to solve it. If all queues wait at once, investigate shared capacity and cluster-wide work. This distinction keeps operators from changing several unrelated WLM settings during an incident and makes before/after comparisons meaningful.

## Common mistakes

- Raising concurrency slots without measuring memory pressure and spill behavior.
- Treating concurrency scaling as a way to make one expensive query faster.
- Routing all users into one queue and hoping SQA compensates.
- Setting a static SQA threshold without checking workload patterns.
- Tuning on execution time alone while queue time is the actual user-visible delay.
- Forgetting that manual WLM settings and service class identifiers are deployment-specific.
