# Provisioning, Elastic Pools and Scaling

Azure SQL Database provisioning combines an Azure control-plane resource with a database engine endpoint. A logical server is a management and namespace boundary for databases, authentication configuration, firewall rules and selected policies. It is not a virtual machine, SQL Server instance that an administrator patches, or a customer-controlled cluster. The database is the primary unit for schema, query and workload configuration. This distinction affects both onboarding and automation: create and protect the Azure resources through infrastructure-as-code, then manage database objects and permissions through repeatable SQL migrations.

## Provisioning a database

A database is created within a subscription, resource group and logical server, with a region and service configuration. These choices establish important boundaries for governance, network reachability, identity, availability and billing. Select a region based on application latency, data residency, service availability, and recovery topology. A resource group helps organize lifecycle and access control but is not itself a database isolation boundary.

Use a repeatable deployment path such as Bicep, ARM templates, Terraform or Azure CLI for infrastructure, and a migration framework or deployment pipeline for schema. Specify desired tier, purchasing model, compute, storage, collation, zone-redundancy settings where supported, backup redundancy and network policy explicitly. Defaults can evolve and may not match the intended compliance posture. After provisioning, validate connectivity, database compatibility level, diagnostic settings, identity, backup settings and role membership. Resource creation success only says that the control plane accepted a request; it does not prove that the application can connect or that the chosen capacity serves its workload.

The logical server name becomes part of the client endpoint. Applications should use the documented DNS endpoint rather than an IP address because service infrastructure can change. Each database has its own database-scoped principals and configuration, although some administrative features are configured at the logical-server level. Azure SQL Database does not expose a conventional `master`/server administration experience identical to boxed SQL Server. T-SQL support and permissions have service-specific boundaries; do not assume server-level commands from an on-premises runbook will work unchanged.

## Elastic pools

An elastic pool provides shared compute resources for multiple databases. It is designed for a group with variable or complementary demand: one tenant may peak in the morning while another is quiet. Pool compute and storage are provisioned at the pool level, while each database can have per-database minimum and maximum settings to shape resource use. Pool configuration is expressed through a supported purchasing model and tier. Pool capacity is shared, not reserved separately at every database's maximum.

Pools can reduce overprovisioning when utilization is genuinely complementary, but they create a shared-resource domain. Several databases can peak together, a noisy tenant can consume capacity, and aggregate pool limits can constrain all members. Database-level limits can cap an individual workload; they do not guarantee that the remaining pool capacity will satisfy every other database at peak. Monitor pool metrics and per-database utilization and identify which tenants are responsible for resource use. Use workload isolation, separate pools or standalone databases for tenants with strict performance guarantees, distinct security boundaries, or synchronized peaks.

Before consolidating, build a demand profile for each candidate database across normal, peak and batch periods. Include CPU, data IO, log IO, storage growth and maintenance windows. Run a representative test with multiple databases active at once. Make pool membership changes through a controlled process and observe after migration; a single-database benchmark misses contention dynamics. A pool is not a substitute for query isolation or quota-aware application design.

## Scaling and operational changes

Scaling a database or pool means changing service capacity or configuration through Azure. Increasing compute can relieve an identified capacity bottleneck; reducing it can save resources when a workload no longer needs that headroom. Storage limits and behavior depend on the chosen tier. Some operations can take time, and changing configuration can cause brief connectivity interruptions or transient errors. Applications should already implement bounded retries for connection loss rather than assuming a scaling action is invisible.

Use Azure Resource Manager (ARM) control-plane APIs, Azure CLI, PowerShell, Bicep or the portal to change resource configuration. Automate planned scale schedules for known workload cycles, with guardrails, approval and alerting. Avoid rapid oscillation based on a noisy metric: scale decisions have control-plane delay and can themselves add risk. Maintain a documented emergency scale procedure, including who can execute it and how the team verifies that the target resource—not a similarly named database—was changed.

Database copy, restore, geo-replication and pool movement are separate operations from compute scaling. They may create another resource, use capacity during transition, or require endpoint updates. Plan data consistency, cutover and cleanup. Confirm whether a service objective change is supported for the chosen resource and whether its region and tier are available in the subscription. Validate effective settings after operations complete by reading the resource state and testing database behavior.

## Provisioning workflow example

The exact command syntax and parameters vary by Azure CLI version and current API. A typical workflow is to establish the resource group and logical server, then create a database with an explicit service objective and networking posture. Keep credentials and secrets out of command history. Prefer deployment identities and declarative templates for production. A database creation command does not automatically establish least-privilege database users, diagnostics, private connectivity or application secrets; those are distinct deployment steps.

After each change, check Azure Activity Log for control-plane completion and errors, then query the database to validate engine reachability and expected settings. Record the actual resource ID, region, tier and pool membership in deployment output. This makes audits and incident response less dependent on portal screenshots or memory.

## Monitoring shared capacity

Azure Monitor exposes database and pool metrics such as CPU, data IO, log IO and storage consumption, with metric names and dimensions depending on configuration. Diagnostic settings can export resource logs to Log Analytics or another supported destination. Query Store gives query-level history within the database, while pool metrics explain broader contention. These views answer different questions: a database can have modest CPU while pool-level data IO is constrained, or a pool can look healthy while one tenant has a bad plan.

Set alerts on sustained saturation and on growth trajectories, not only instantaneous peaks. Thresholds should allow enough time for diagnosis and a scaling action to finish. Retain enough telemetry to compare before and after changes. Use Resource Graph or inventory automation to detect databases outside approved regions, tiers or policy. Avoid treating a green dashboard as proof of application health; validate end-to-end latency and error rates too.

### Common mistakes

- Treating the logical server as a server VM or assuming all instance-level `master` operations are available.
- Putting every tenant into one pool because their average utilization is low, without analyzing simultaneous peaks.
- Giving a database a high maximum and assuming the pool reserves that capacity for it.
- Automating scale actions with no cooldown, maximum boundary, audit trail or application retry strategy.
- Relying on portal defaults for security, diagnostics, backup redundancy or region.

### Production notes

Define resource naming, tags, ownership, region, retention, alerts and policy at provisioning time. Test both scale-up and scale-down procedures in a non-production resource. Review pool membership as tenants grow and split workloads when shared capacity conflicts with service objectives.