# Incremental Refresh and Gateway Setup

Refresh strategy controls how source data reaches an Import model and is distinct from report query performance. A full refresh rereads and reprocesses the selected data for a table. Incremental refresh partitions a table by time so the service can refresh a recent range while retaining older partitions. This can shorten routine refreshes for large, append-oriented fact tables, but only when the source and model support the intended filtering and the policy is configured correctly.

## Configure incremental refresh

In Power Query, create DateTime parameters named exactly `RangeStart` and `RangeEnd` with matching types, then filter the fact table using a half-open interval: `column >= RangeStart` and `column < RangeEnd`. A half-open boundary avoids duplicate rows at adjacent partition edges. Verify that the predicate folds to the source when the connector supports folding. Configure the refresh policy in Desktop with a historical storage period and a refresh period, and consider a detect-data-changes column only when its semantics are reliable. The service creates and manages partitions when the model is first published and refreshed; do not assume the Desktop preview itself demonstrates partitioning.

Choose the policy from business retention, late-arriving data and source behavior. If records can be corrected years after creation, refreshing only the most recent days will leave old partitions stale. A reliable modified timestamp can help detect changed partitions where supported, but it must actually update for corrections and be appropriately modeled. Deletions need special consideration: a refresh predicate and incremental policy may not discover a source row that disappeared from an old partition. Plan periodic full or targeted correction processes if the data contract requires them.

Validate the first service refresh, partition boundaries, row counts and reconciliation totals. Test daylight-saving and timezone assumptions; timestamps should have explicit semantics. Monitor failures and duration, and document how a policy change affects existing partitions. XMLA-based partition management may be available in appropriate capacity and configuration, but direct partition manipulation requires operational expertise and should be controlled.

## Orchestrating the refresh lifecycle

Refresh dependencies should be treated as a graph. A dataflow or pipeline may need to finish before a semantic model refresh begins; a model schedule that starts too early can succeed while reading yesterday's materialized output. Coordinate orchestration and expose upstream freshness to downstream users. Make retry behavior bounded and distinguish transient network errors from schema or credential failures. Blindly retrying a bad query can add pressure without resolving the cause. A refresh failure alert should identify the artifact, time, source and responsible owner, while avoiding credentials or sensitive query parameters in logs.

For incremental policies, separate model processing from source ingestion. A source's “last updated” column may change because of a transformation job rather than a business correction, or may fail to change for a correction. Validate it with actual update flows. A late-arriving transaction with an old business date may fall into an already-closed partition; either the refresh horizon or change detection must cover it. If transaction date and modification time have different meanings, use the appropriate fields for partitioning and change detection and document the distinction. Check how timezone conversions occur from source through Power Query to partition boundaries, especially around daylight-saving changes.

A recovery plan should say how to diagnose a failed refresh, rerun safely, and confirm data correctness. Refresh history is useful but not a substitute for business reconciliation. Monitor gateway host CPU, memory and network along with its queue and source latency. A cluster's members should have compatible drivers and network access. Run a controlled failover test after setup and after significant gateway updates.

## Gateways and source connectivity

A gateway provides a secure bridge between the Power BI service and certain data sources on a private network or local machine. The on-premises data gateway (standard mode) is commonly deployed on an always-on, managed Windows host and can be clustered for availability. Personal mode is intended for individual use, not a production shared service. A gateway is not needed for every cloud source; check connector and network requirements.

Install and register the gateway with a managed account and an appropriate recovery key. Keep it patched, monitor host resources and gateway status, and document recovery access. Configure data-source connections and credentials in the service, then map the semantic model to the intended connection. Credential type, privacy levels, source identity, DNS, firewall and driver versions can all affect refresh. For a private cloud endpoint, validate DNS and routes from the gateway host. Do not expose a database publicly as a substitute for a correctly configured private path.

A cluster can improve availability, but it does not make the source highly available or repair bad credentials. Test node failover, patching and concurrent refresh load. Avoid installing a gateway on an analyst's laptop that sleeps or leaves the network. Gateway throughput is shaped by CPU, memory, network and source performance; size using observed workload rather than a fixed folklore number.

### Common mistakes

A production refresh design should include capacity and ownership limits. Stagger heavy model refreshes where sources or gateways are shared, and avoid overlapping processes that compete for the same memory or database resources. Set expectations for how long a refresh can run and who receives alerts outside business hours. Distinguish a skipped schedule, a credential-expiration failure, a gateway offline event and a query timeout; they have different remedies. Make the documented service account or identity renewable and reviewable rather than tying the process to an employee who may leave. Keep the gateway recovery key in an approved secret-management process and restrict who can administer the cluster. Before patching a gateway node, check workload status and the cluster's remaining capacity, then confirm that the node rejoins and can execute a real refresh. Operational continuity depends on these routine checks as much as on the initial installation.

When a gateway is part of a business-critical model, maintain a clear network diagram from the service through the gateway to each source. A private endpoint name may resolve differently on a laptop and on the gateway, and a firewall rule that admits one subnet may not admit the cluster. Test DNS resolution, port reachability and database authentication from each node. Keep gateway administrators separate from report consumers, and document the approved change window. A clear topology shortens incidents and prevents the unsafe “open the firewall to everyone” response.

- Using inclusive start and end boundaries that duplicate rows across partitions.
- Assuming incremental refresh automatically handles old corrections and source deletes.
- Treating a successful Desktop refresh as proof of service credentials, gateway mapping or private DNS.
- Confusing gateway clustering with source database high availability.
- Storing the recovery key or credentials in a broadly shared document.

### Production notes

Keep a refresh runbook with ownership, source connection, data credential identity, gateway cluster, schedules, expected duration, alert routing and recovery steps. Validate row counts and key business totals after a policy change. Where supported, use refresh history and capacity monitoring to distinguish a source timeout from gateway saturation or model processing failure.
