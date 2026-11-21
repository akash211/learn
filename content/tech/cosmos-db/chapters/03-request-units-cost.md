# Request Units and Cost Mechanics

Request units (RUs) are Cosmos DB's normalized measure of the work needed to serve database operations. They abstract CPU, memory, and storage I/O so that reads, writes, and queries can be charged against a throughput budget. The RU model helps estimate capacity, but it does not mean every operation has one fixed universal cost: item size, indexed paths, query selectivity, consistency, and partition routing all affect consumption. Never estimate a production bill from a single point-read example.

## RU charge and throughput budget

A request returns an RU charge in SDK diagnostics or response metadata. A point read of a small item addressed by both ID and partition key is typically much cheaper than scanning many items, but its measured charge depends on actual item properties and service behavior. Writes generally consume more as items grow and more index entries must be maintained. Queries consume work based on items and index paths examined, result count and size, cross-partition fan-out, and any computation. Multiple requests compete for configured RU/s over time.

Provisioned throughput is expressed as RU/s: a rate budget, not a bank of units that can be saved indefinitely. If operations directed to a throughput scope consume more than their available share in a short interval, requests can be throttled with HTTP 429. Manual throughput sets a provisioned amount; autoscale varies capacity up to a configured maximum and has a lower operating range. Serverless is another billing/capacity model where available, but its limits and economics differ. Choose by measured burst shape, steady load, predictability, and required feature set. Avoid inserting per-RU price assumptions into architecture notes; pricing varies by region, model, and configuration and should be calculated using the current Azure pricing calculator and account settings.

A rough capacity exercise uses a representative operation mix. If a workload performs `r` reads/s averaging `R` RU, `w` writes/s averaging `W` RU, and `q` queries/s averaging `Q` RU, expected demand is approximately `rR + wW + qQ` RU/s before peak headroom and uneven partition distribution. This is an estimate, not a guarantee: query p95 and p99 charges may be much higher than the mean. Benchmark realistic document sizes, indexes, and tenant skew. Include retries and background change-feed processing in the same throughput budget if they share it.

## Cost mechanics beyond operations

The invoice is not simply one total RU count multiplied by an assumed price. Relevant dimensions can include provisioned or autoscale throughput, storage, backup configuration, region count, networking, and analytical or other selected capabilities; billing details vary by account type and region. Multi-region placement can multiply provisioned capacity requirements or charges depending on throughput model and service configuration. Shared throughput pools improve utilization only when workloads' peaks do not conflict. Reserved capacity, free tiers, and regional pricing can change the bill, so use current official calculators and pricing documentation rather than memorized figures.

Model a monthly profile from distinct environments and workloads: baseline, peak, traffic seasonality, failover capacity, background jobs, storage growth, index overhead, and backup retention. Include the cost of headroom necessary for latency objectives. Then compare a dedicated container with shared database throughput, autoscale max selection, and serverless where appropriate. Ensure monitoring alerts distinguish a workload saturation problem from overprovisioning. If RU/s are ample but query latency is poor, adding throughput alone may not fix an inefficient query or network issue.

## Normalized RU and hidden hot spots

Normalized RU consumption is a utilization signal, commonly reported from 0% to 100%, that reflects the most utilized physical partition range in the observed interval. Thus the container can show 100% even when overall average usage looks moderate: one range is saturated. Inspect this metric by partition range alongside request charge and 429 counts. A high value on one range suggests skew or a hot key; high values across ranges suggest broad capacity pressure. Azure Monitor's sampling interval can hide short spikes, so correlate metrics with SDK diagnostics and logs for specific requests.

Normalized RU is not the same as the RUs consumed by one operation, and it does not identify the precise logical key without additional diagnostics. A small overall percentage does not prove that every request is safe from throttling. Conversely, a brief 100% value or a small number of retried 429 responses does not automatically imply a customer-visible incident. Evaluate retry delay, tail latency, request failures, and key distribution together.

## Handle 429s without hiding problems

The service returns 429 when the relevant budget is exceeded. Official SDKs generally retry transient throttling using server-provided retry guidance, but applications should use the SDK's retry behavior rather than layering aggressive immediate retry loops. A retry is additional load and may extend response time; unbounded retries can amplify an overload. Set a request deadline, respect retry-after behavior, and surface exhausted retries as an explicit failure. For idempotent operations, retrying is often safe; for ambiguous write outcomes, use stable item IDs and idempotent upsert or reconciliation logic.

Investigate: (1) are 429s widespread or limited to a partition range; (2) what operations and queries consume the budget; (3) did item sizes, indexing, or traffic change; (4) is the key skewed; and (5) do SDK retries meet the user-facing latency objective? If all partitions are consistently saturated and the workload is efficient, raise throughput or adjust capacity model. If one key is hot, redesign the partitioning or workload before treating global capacity as the only lever. Reduce query work by narrowing results and optimizing indexes; batch writes where appropriate, but do not assume batching lowers total RU consumption.

## Common mistakes

- Treating an RU as a fixed amount of money or believing every read costs the same.
- Sizing only from average request volume and ignoring p95/p99 charge, bursts, and partition skew.
- Treating autoscale as unbounded capacity or assuming it prevents all 429s.
- Ignoring retries and background consumers in capacity and end-to-end latency calculations.
- Increasing throughput before checking query efficiency and hot logical partitions.

## Production notes

Capture RU charge, status code, activity ID, operation type, latency, and partition-aware diagnostics for representative calls. Use repeatable load tests and keep their data distribution realistic. Review normalized RU, 429 rate, retry latency, storage growth, and index policy after application changes. Model costs with current regional pricing and validate any estimated bill against the selected account configuration; service terms change over time.

## Turning measurements into a capacity decision

Measure operations with the SDK version and account configuration that will ship. Capture request charge for successful and failed operations, because validation errors, conflicts, and retries can still consume work. For queries, record page count and total charge across the full result, not just the first response. For bulk ingestion, include retry and serialization overhead and test whether the source can sustain the intended rate without creating a backlog. A dashboard that reports only average RU/s conceals both expensive outliers and hot key distributions.

Keep a capacity worksheet with the workload assumptions: operation mix, item size, update frequency, index paths, partition-key skew, consistency level, peak multiplier, and background task schedule. Update the worksheet when a new endpoint or schema field is introduced. Forecast a normal day, an expected seasonal peak, and a regional failover where remaining capacity must serve displaced traffic. If the design changes from one to several regions, recalculate throughput and replication implications rather than copying the original number.

Cost controls should connect a budget threshold to a safe action: alert, pause a noncritical batch, reduce a background concurrency limit, or route low-priority work to a queue. Avoid silently dropping writes. Review actual bills against the forecast after deployment and explain variances by throughput, storage, regions, or workload changes. Never rely on an old unit price to infer current cost; the calculator and billing configuration are the source for a current estimate.
