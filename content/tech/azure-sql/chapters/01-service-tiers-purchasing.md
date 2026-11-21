# Service Tiers and Purchasing Models

Azure SQL Database separates the logical database from the hardware that serves it. Choosing a tier is therefore a capacity and availability decision, not just selecting a number of cores. The service tier determines the storage architecture, feature envelope, resilience characteristics and scaling options. The purchasing model determines how compute capacity is allocated and billed. Compare these dimensions against observed workload behavior and recovery requirements; do not infer that similarly named options have identical limits across regions or generations.

## DTU and vCore models

The DTU purchasing model bundles compute, memory, data I/O and log I/O into a normalized unit. It offers a compact way to choose among predefined service levels, which can be convenient for a simple database whose workload resembles the sizing assumptions. DTU is an aggregate abstraction: it does not let an operator independently choose CPU and storage, nor does the number explain which resource is saturated. A database at a high percentage of DTU utilization may be constrained by one constituent resource. Use Azure metrics and workload evidence rather than treating the bundled figure as a diagnosis.

The vCore model exposes a more explicit resource choice. A deployment selects a compute tier and a compute size, and storage is configured separately within that tier's constraints. This makes it easier to reason about CPU capacity, memory, data storage and licensing options. It also presents configuration concepts familiar to SQL Server operators, but a vCore is not a promise of a fixed end-to-end query time: memory ratios, IO behavior, concurrent activity and service limits still matter. vCore is generally the more useful model when comparing cloud capacity with an existing SQL Server estate or when independently sizing compute and storage.

For either model, understand what is being provisioned for the database and what is shared. In a single database, capacity is dedicated at the database resource boundary, subject to the selected model and tier. In an elastic pool, databases share provisioned capacity and can use it unevenly. Pool capacity is not an unlimited guarantee for every member at its individual maximum. Measure peaks, concurrency and noisy-neighbor behavior across the pool.

## General Purpose, Business Critical and Hyperscale

General Purpose targets common business workloads with a compute/storage separation suited to cost-conscious general use. Its architecture uses remote storage and local compute resources; its availability and IO characteristics follow that service design. It is often a sensible baseline, but it should be tested with the application's actual latency and recovery expectations. A successful benchmark should include the relevant read/write mix, concurrency, data volume, failover behavior and peak periods.

Business Critical is designed for higher performance and availability needs, with local SSD storage and a replica-based architecture. It can reduce IO latency for suitable workloads and provides read-scale options in supported configurations. These capabilities do not remove the need to verify query plans, test client reconnection, or understand how read-only routing is configured. Additional replicas and architecture may increase resource consumption. Do not move a workload to this tier solely because one query is slow; first identify whether the root cause is compute, IO, locking, plan quality or application behavior.

Hyperscale is a distinct architecture for large databases and workloads that benefit from independently scalable compute and distributed storage. It uses a primary compute replica, page servers, a log service, and a shared storage layer; it is not simply a larger General Purpose database. Rapid storage growth, read replicas and backup/restore behavior differ, so assess the Hyperscale-specific operational model before selecting it. See the dedicated chapter for its architecture and constraints.

| Consideration | General Purpose | Business Critical | Hyperscale |
|---|---|---|---|
| Typical design fit | General application workloads | Latency- or availability-sensitive workloads | Large data footprints and elastic storage needs |
| Storage design | Remote storage separated from compute | Local SSD with replica-based design | Distributed storage with page servers and log service |
| Key evaluation | IO and latency under realistic load | Replica behavior and local IO benefit | Feature compatibility, replica topology and recovery |

This is an architectural comparison, not an availability or feature guarantee. Service availability, limits and exact behavior can vary by configuration and region.

## Provisioned compute and serverless

Provisioned compute keeps a selected compute allocation available. It is appropriate when the database has continuous use or predictable demand, needs stable capacity, or has latency expectations incompatible with auto-pause. Capacity can be adjusted manually or through automation. Scaling operations may cause connection disruption or require time to complete; exercise the change process and ensure the application tolerates transient reconnects.

Serverless automatically scales compute within configured minimum and maximum bounds as workload demand changes. For eligible configurations it can automatically pause after an inactivity period and resume when activity returns. The model is useful for intermittent or unpredictable workloads, development/test databases, and low-utilization databases with quiet intervals. Auto-pause is a trade-off: resumption can add startup latency, background activity can prevent pausing, and a configured minimum still defines a floor. Confirm that the selected tier, database features, region and client expectations support the desired behavior. Serverless is not a magic scale-out mechanism for a sudden burst; the maximum and scale response still bound capacity.

Choose a minimum that can serve baseline traffic and a maximum that contains the worst plausible burst. A broad maximum can protect availability but may permit higher consumption than intended; too-low maximum creates resource pressure. Validate using representative load tests and Azure metrics over real usage cycles. A database with a stable baseline and short recurring peaks may be cheaper and more predictable in provisioned compute or an elastic pool.

## Capacity sizing and decision process

Start with measured SQL Server or Azure workload data: CPU, data IO, log IO, data size, concurrency, query latency, memory pressure and peak duration. Map requirements to a candidate tier and purchasing model, then test the actual application. Include maintenance and batch jobs, not only average daytime traffic. Consider whether the workload needs read scale, very large storage, predictable cold-start behavior, zone or geo-resilience, and particular SQL features.

Set operational thresholds below hard platform limits so there is time to investigate or scale. Observe utilization by resource, database and pool. A workload with high log-write utilization behaves differently from one with high CPU. Long-duration averages can conceal short bursts; correlate metric time series with Query Store intervals, deployment events and application latency. Scaling up can be a mitigation, but measure whether it solves the diagnosed bottleneck and whether query/index improvements are still warranted.

### Common mistakes

- Comparing DTU percentages directly to vCore CPU and assuming they mean the same thing. They are different resource abstractions.
- Choosing a tier from a single benchmark that excludes concurrency, log writes, failover or application reconnects.
- Treating serverless auto-pause as free idle operation or overlooking resume latency and minimum capacity.
- Assuming Business Critical eliminates query tuning, or that Hyperscale is only a storage-size setting.
- Assuming a configured maximum is always available instantly or is equivalent to a performance SLA.

### Production notes

Record the decision, measured baseline, peak, capacity limits and a rollback path. Revisit tier selection after data volume, tenancy or query patterns change. Verify current regional availability and service limits through Azure's current documentation and deployment APIs; do not bake transient limits into an application contract.