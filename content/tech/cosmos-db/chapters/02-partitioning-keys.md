# Partitioning and Partition Keys

Partitioning is the central physical and logical design decision in Azure Cosmos DB. Data and request capacity must be distributed across partitions, while application calls need enough key information to route efficiently. A partition key that is easy to identify but heavily skewed can bottleneck; a key that distributes perfectly but is absent from common queries can force expensive fan-out. The goal is a balanced design for both storage and traffic over the container's lifetime.

## Logical and physical partitions

A logical partition is the set of items sharing one partition-key value. It is an application-level grouping: for example, every item with `tenantId: "northwind"`. The service hashes the key and maps logical partitions into physical partition ranges. A physical partition is an infrastructure allocation that holds one or more logical partitions and serves a share of provisioned RU/s. Many logical values can share a physical partition; one logical partition is not split arbitrarily across physical partitions in the ordinary partitioning model.

This distinction matters operationally. Adding physical capacity can distribute many values, but it does not divide one intrinsically hot logical key into several independently writable keys. A tenant receiving a disproportionate share of requests may saturate the physical range that contains its logical partition, even when the container's total RU/s appears sufficient. A physical partition range can also contain multiple logical values, so a hot range metric is evidence to investigate, not a label naming the offending tenant by itself.

## Choose a key from workload evidence

Evaluate candidate properties against four questions:

1. **Routing:** Do frequent point reads and writes know the key value? Exact key plus `id` enables a targeted point read; queries scoped to a key avoid broad fan-out.
2. **Cardinality and size:** Are there enough distinct values to spread storage? Will any one value accumulate too much data over the container's lifetime?
3. **Throughput distribution:** Do request rates distribute as well as item counts? Uniform record counts do not help if one customer receives most writes.
4. **Atomicity and locality:** Do operations that must transact together share one logical partition? In the NoSQL API, transactional batch and stored procedures have a single logical partition scope.

Consider a multi-tenant service partitioned by tenant. This simplifies tenant-scoped reads and tenant-local transactions. It may fail when a few tenants dominate traffic or grow past key-value constraints. Partitioning by `userId` spreads active work more finely but complicates tenant-wide list operations. A hierarchical partition key can express a hierarchy such as tenant then user where supported, but it does not remove the need to test query routing, limits, and API availability. A synthetic key like `tenantId|bucket` can split heavy tenants, but now a tenant-wide query may need to visit several buckets and a transaction cannot cross those logical partitions.

For time-series ingestion, partitioning only by date can create a hot key if every writer targets today's date. Combining a device or hash bucket with a time window can distribute writes, while retaining a time range for retention or reports may require fan-out across buckets. A random GUID often distributes keys but is poor when common reads start from tenant or device. There is no universally best key: explain which operations become targeted, which are distributed, and which become multi-partition.

## Hot logical partitions and physical ranges

A hot partition is a concentration of RU consumption on one or a few logical key values, often reflected as high utilization in the physical partition ranges hosting them. A key may have many items but low traffic, or few items but intense updates. Diagnose with normalized RU consumption by partition range, request charge and partition-key diagnostics, operation type, key-level telemetry where enabled, and application request patterns. Compare time windows: a temporary burst is different from a stable hot key. Querying logs and metrics incurs operational work, so make telemetry sampling and retention part of the plan.

Increasing total throughput can relieve a broadly saturated container, but a single hot logical partition can remain the limit. More overall RU/s may temporarily increase the share available to physical partitions, yet it can waste budget elsewhere and does not change the concentration. Long-term options include redesigning the key in a new container and migrating, introducing write buckets or sharding suffixes, isolating large tenants, or changing the workload to reduce repeated hot-item updates. Each changes query and transaction complexity. An immutable partition-key path cannot normally be edited in place for existing items: changing it means creating the target container and copying/replaying data.

## Throughput scope and partition scaling

Provisioned RU/s can be assigned at database or container scope depending on configuration. Shared database throughput can improve utilization across multiple containers, but a noisy neighbor may affect workloads sharing the pool. Dedicated container throughput gives clearer isolation but may leave unused capacity. As storage grows, the service can add physical partitions according to service limits and configured throughput; the application still needs a key that offers enough distribution. Autoscale adjusts within a configured maximum, not without bounds, and one busy key can still hit its physical range's limit.

Use partition-aware SDK methods when the key is known. Point reads should pass both item ID and key. Include partition filters in queries where semantics permit. For cross-partition queries, set and observe expected behavior, apply filters and projections early, and use continuation tokens rather than assuming one response contains every result. A query that silently fans out may work during development and become an expensive production path.

## Common mistakes

- Confusing logical partition keys with physical partition range IDs.
- Choosing a low-cardinality key because it makes a convenient filter, without projecting growth and tenant skew.
- Assuming autoscale or more total RU/s can split a single hot logical partition.
- Using a random high-cardinality key that makes every important lookup a fan-out query.
- Expecting multi-item transactions across different logical partition keys.

## Production notes

Build a workload table before choosing: reads, writes, queries, expected partition-key availability, per-key data growth, and required transaction groups. Test with skewed data, including a large tenant and a hot key, rather than uniform synthetic records only. Record migration and repartitioning as planned lifecycle events; a key decision is difficult to reverse after a container has accumulated data.

## Capacity by key and lifetime growth

Estimate each key's growth, not only container-wide storage. For a tenant-oriented container, project the largest tenant's item count and daily RU demand over the retention horizon. If one customer can exceed service limits or dominate writes, have an isolation strategy before launch. For time-oriented data, define retention and deletion behavior together with partitioning: a time bucket can make archival and query windows intuitive, but a single active bucket can concentrate writes. A compound or synthetic key may split the load, at the cost of issuing queries across several suffixes.

The partition key should also be easy to supply reliably. If an API usually knows the order ID but not the tenant or device key, it may need a lookup strategy. A secondary directory item can map a business identifier to a partition key, but that mapping becomes another consistency and availability dependency. Avoid assuming that an application can efficiently discover an item's partition key from the item ID alone.

Test high-percentile key behavior: rank logical keys by RU use and storage, then inspect how the busiest values map to physical ranges. A hot range can include multiple keys, and range splits can change the mapping over time. Treat the metric as a clue, not a permanent identity. Maintain key-distribution dashboards and rehearse a migration to a new key so the team knows how to change course before a critical tenant is blocked.
