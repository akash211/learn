# Cost Control and Workload Governance

Cost control for Azure SQL Database is an engineering discipline: align capacity with workload, set explicit boundaries, monitor utilization and growth, and connect resource changes to ownership and business demand. Avoid memorizing a price table because charges vary with region, purchasing model, service configuration, storage, backup retention, licensing benefits and contract. Model the architecture in the Azure pricing tools and validate actual consumption from billing data. This chapter focuses on the levers and governance practices rather than price values.

## Understand the cost dimensions

A database's cost is influenced by the purchasing model, selected tier and compute allocation, storage, backup retention and redundancy, replicas, elastic pool capacity, and optional services. Serverless compute changes how compute consumption behaves over time and can auto-pause in eligible configurations, but its minimum, maximum and resume characteristics matter. Provisioned compute keeps capacity available and may better match steady workloads. A pool can share resources across databases with complementary peaks, but it can also force capacity increases when tenants peak together. Hyperscale and read replicas have their own architecture and resource consequences.

Data storage and backup storage are distinct considerations. Monitor database size, growth rate, retained backup volume and LTR configuration. Longer retention and higher redundancy can be necessary for policy and recovery goals but should be intentional. Geo-replication and failover topologies consume resources in secondary regions. Avoid deleting resilience features solely to cut a bill without recalculating RPO/RTO and compliance obligations.

Azure Hybrid Benefit and other licensing constructs may affect eligible deployments; applicability depends on licensing entitlement and configuration. Validate with current Microsoft licensing guidance and procurement rather than assuming that an existing SQL Server license automatically applies. Reserved capacity and savings plans, where applicable, require usage commitments and should follow stable usage evidence. No commitment is a substitute for selecting an appropriate workload shape.

## Right-size with evidence

Collect at least a representative cycle that includes peak business periods, batch work, month-end activity and seasonal patterns. Review CPU, data IO, log IO, storage, worker pressure and Query Store resource consumption. Separate idle time from low-but-essential baseline. A database with low average CPU but a short critical peak may need provisioned headroom; a sporadic dev database may benefit from serverless if pausing is acceptable. A high CPU bill can reflect an inefficient query that is cheaper to fix than to scale permanently.

Use a staged right-sizing process. Establish the current service objective and a workload baseline. Identify the measured bottleneck. Test a lower or alternative configuration under realistic concurrency and error budget. Check p95/p99 latency, saturation duration and recovery behavior. Roll out with alerts and a quick scale-back path. Do not downsize solely because a monthly average looks low; a brief overload may be invisible in aggregated charts yet cause user-facing timeouts.

For pools, use per-database and pool-level telemetry to locate noisy tenants. Define a maximum resource policy, but recognize that per-database maximums do not reserve that capacity. Establish workload governance agreements: which databases share, expected peak patterns, alert ownership, and how to handle simultaneous spikes. Split a database to a separate pool or standalone resource when service objectives conflict. Track storage capacity separately from compute utilization.

## Budgets, tags and automation

Use Azure tags for owner, environment, product, data classification and cost center. Apply Azure Policy to enforce approved regions, resource types, diagnostic settings and security baselines. Organize resources so teams can see spend in Cost Management by application and environment. Budget alerts are signals, not hard spending caps; combine them with ownership and an escalation path. Include planned work such as load testing, restore drills, replicas and temporary migration environments in forecasts.

Automate lifecycle for short-lived dev/test databases, while protecting production resources from accidental deletion or scale changes. Auto-pause can reduce idle compute consumption for eligible workloads, but verify the effect on resume behavior and background tasks. A database that must respond immediately at all hours may not be a good candidate. Use resource locks and controlled identity roles for critical databases, with exceptions documented rather than broadly disabling governance.

Set explicit configuration in infrastructure-as-code so tier, pool, backup retention, redundancy, diagnostics and network policies are reproducible. Review drift and resource inventory regularly. When a database is retired, confirm its data retention and legal hold requirements, archive or delete it through the approved process, and remove unused replicas, private endpoints, alerts, secrets and monitoring workspaces. Orphaned dependencies can continue to incur cost or create security exposure.

## Workload governance and workload groups

Azure SQL Database provides resource governance mechanisms at the service level, and elastic pools share resources across member databases. Application-level governance is equally important: bound connection pools, cap background concurrency, schedule heavy jobs, and apply admission control for expensive operations. Use database permissions and separate workload identities to isolate operational responsibilities. Keep analytical reads from overwhelming transactional paths, potentially using read-scale features where consistency and tier support permit.

Monitor workload shape as well as total consumption. Unexpected growth in query execution count, logical reads, index size, connections or retry rate can predict a capacity problem before it appears as a cost spike. Query Store can reveal a new expensive plan, while Azure Monitor identifies resource saturation. Integrate cost dashboards with performance and reliability signals so teams do not optimize spend at the expense of service objectives.

## Capacity and cost review cycle

A useful monthly or quarterly review asks: what changed in data volume and request mix; are there databases with persistent headroom; are any resources near limits; which automatic tuning actions occurred; are backups and replicas still required; is pool membership still complementary; and which upcoming launches alter peak demand? Record both a cost estimate and an operational risk assessment. Consider a controlled experiment rather than making a broad estate-wide change.

### Common mistakes

- Treating the lowest monthly compute usage as an optimization target without checking critical latency or burst capacity.
- Disabling geo-redundancy, retention or replicas without revisiting recovery and compliance requirements.
- Assuming a pool reserves each database's maximum capacity or always reduces cost.
- Treating budget alerts as spending controls or deleting resources before data retention review.
- Using a fixed price comparison that ignores region, storage, backups, replica topology and licensing eligibility.

### Production notes

Publish a cost owner for every database and a clear escalation path for alerts. Review cost and Query Store together. Forecast data and backup growth, test auto-pause and scale policies before production, and retain a documented approval for changes that reduce resilience. Recheck pricing and feature availability with current Azure calculators and billing exports whenever architecture or commitments change.

## Forecasting and accountable changes

Forecast demand using workload drivers such as tenants, transactions, retained records and report volume rather than extrapolating the last invoice alone. Note the confidence range and capacity trigger that will cause a review. Every proposed reduction should name its owner, affected databases, test window, success measures and rollback condition. For a shared pool, coordinate with all tenant owners before a change that can alter their headroom. Keep a record of the old and new configuration and compare actual billing after the billing data has settled. Separate short-lived migration, restore-drill and load-test resources with tags and expiry automation, but protect active recovery resources from cleanup. Cost governance is successful when spend is explainable and service objectives remain measurable, not simply when compute has been reduced.
