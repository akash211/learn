# Autoscaling and Disruption Budgets

Autoscaling involves several distinct control loops. Horizontal Pod Autoscaler (HPA) changes a workload's replica count. Vertical Pod Autoscaler (VPA), when installed, can recommend or apply changes to container resource requests. A cluster autoscaler or node provisioning system adds or removes nodes. They operate at different layers and must be configured so that Pod-level capacity demands can be met by node-level capacity.

## Horizontal Pod Autoscaler

HPA periodically reads metrics and adjusts the scale subresource of a Deployment or StatefulSet. CPU utilization targets are calculated relative to resource requests; without appropriate CPU requests, utilization may be undefined or less useful. HPA can also use memory or custom/external metrics through the relevant metrics APIs and adapters. It does not create metrics by itself: the metrics server provides basic resource metrics, while application or external signals often need a separate adapter.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 2
  maxReplicas: 12
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
```

The values are illustrative. HPA uses a control loop and can be affected by metric delay, stabilization windows, scale policies and readiness. A CPU target of 65% is not a guarantee that latency remains safe. Set minimum replicas for availability, maximum replicas for budgets and downstream capacity, and behavior to avoid oscillation. Scale-out can be slowed by image pulls, readiness and node provisioning; scale-in can disrupt in-flight work. Monitor desired, current and available replicas together.

Queue depth, request concurrency or another business metric may indicate demand better than CPU. A custom metric can still be misleading if it is not normalized per Pod or if metrics are unavailable during startup. Design the metric's semantics and failure handling with the adapter operator. HPA may not scale when metric data is missing or Pods are not ready, so inspect its status and events rather than simply raising the maximum.

## Vertical Pod Autoscaler

VPA is commonly deployed as an add-on rather than a built-in component. It analyzes observed resource use and can recommend requests; depending on mode and setup, it may update Pod resources and recreate Pods to apply changes. Resource requests influence scheduling and other autoscalers, so a VPA recommendation can cause rescheduling or consume more node capacity. Limits are a separate policy decision and should not be inferred blindly from a recommendation.

HPA on CPU utilization and VPA adjusting CPU requests can interact: HPA's percentage denominator changes as VPA changes requests. Avoid combining them on the same resource without understanding the chosen metrics and configuration. A common approach is to use HPA for replicas and VPA recommendations for tuning, or let VPA manage memory while HPA scales on a different metric, subject to tested behavior. VPA availability, API versions and modes vary; review its documentation and production mode carefully.

## Node autoscaling and Karpenter

A node autoscaler responds when Pods cannot be scheduled due to insufficient capacity, or when nodes are underused, according to its own policies. It cannot solve a Pod that has impossible selectors, excessive requests relative to all allowed instance types, blocked quota, unavailable zones or unbound storage. Configure node pools with the architectures, zones, labels, taints and resource shapes workloads actually need. Leave room for DaemonSets and system reservations.

Karpenter is a node provisioning and lifecycle controller used in some Kubernetes environments. Current Karpenter APIs include NodePools and provider-specific NodeClasses; it considers unschedulable Pods and configured constraints to choose capacity, then can consolidate or replace nodes under disruption policy. The project evolves, so pin compatible versions and use its installed API schema rather than copying old `Provisioner` examples. Karpenter is not a core Kubernetes component, and cloud provider integrations and feature availability differ.

Karpenter's disruption budgets can rate-limit some voluntary actions; PodDisruptionBudgets influence eviction of workloads. These are separate mechanisms. Expiration or emergency repair behavior may have different guarantees from graceful consolidation, and provider capacity can still prevent replacement nodes. Read the version-specific Karpenter behavior before relying on any budget as a universal safety barrier.

## PodDisruptionBudget and availability

A PodDisruptionBudget (PDB) limits voluntary disruptions through the Eviction API by requiring a minimum available count or maximum unavailable count for selected Pods. It is useful during node drains and some maintenance, but it does not stop a Deployment rollout, direct Pod deletion in every pathway, node crash, kubelet pressure eviction or all provider actions. A PDB also does not create spare replicas; if an application has one replica, a strict minimum can block maintenance indefinitely.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api
```

The selector must match the intended replicas and not unrelated Pods. Percentage values and rounding matter for small replica counts. A PDB can be impossible to satisfy when the workload is unhealthy or a rollout has no available Pod; check `kubectl get pdb` and its allowed disruptions before draining. Configure deployment surge and readiness together with PDB policy; they govern different operations.

## Coordinating the loops

The HPA may add Pods faster than the node autoscaler can add nodes. A Pod may remain Pending until capacity appears; meanwhile the HPA can hit its max replicas. If a rollout also uses surge, it temporarily requires additional capacity. Model peak demand, rollout surge and failure reserve together. Scale-down is similarly coupled: removing a node evicts Pods, controllers recreate them, and autoscalers may add capacity back if workloads cannot fit. Strict anti-affinity, local volumes and PDBs can block consolidation.

## Signals, readiness and scale-down

An autoscaler only sees the metrics and state exposed to it. CPU-based HPA may react poorly to workloads that spend most of their time waiting on I/O, while queue depth can lag if consumers do not acknowledge work reliably. Metrics need labels and aggregation that match the target semantics; for example, a per-Pod average differs from total queue backlog. During scale-up, new replicas should not be counted as ready capacity until they can serve work. During scale-down, long-lived requests, queue ownership and leader roles need graceful handoff. Configure termination hooks and application shutdown to stop taking new work before the process exits.

A cluster that is autoscaled from zero or near-zero capacity may have a cold-start interval involving node creation, image pulls and initialization. Keep sufficient minimum capacity for critical system services and define behavior for metric outages. Monitor both controller decisions and user-facing signals such as latency, errors and queue age. A stable autoscaling policy is not merely one that converges replica counts; it must preserve service objectives while capacity changes.

## Common mistakes and production notes

- Creating an HPA without CPU requests or a functioning metrics API.
- Choosing replica maximums without considering database connections, queue consumers or external quotas.
- Assuming a PDB protects against a node failure or a bad Deployment rollout.
- Running HPA and VPA on the same metric without understanding feedback interaction.
- Assuming node autoscaling repairs an unschedulable Pod whose placement constraints are contradictory.

Test scale-out and drain behavior during normal operation, not only in a load test. Observe HPA conditions, Pod scheduling latency, node provisioning time, evictions and workload error rates. Use realistic limits on replicas and node pools, and avoid setting arbitrary cluster-wide node counts as if they were universal Kubernetes defaults. Autoscaling is a response to signals and constraints; reliability depends on whether those signals match demand and the infrastructure can satisfy them.