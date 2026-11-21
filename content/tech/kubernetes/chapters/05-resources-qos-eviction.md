# Resources, Requests, QoS and Eviction

Resource declarations connect the scheduler's capacity model to the kernel's runtime enforcement. Requests influence where a Pod may fit; limits constrain what containers can consume. They are different controls, and omitting them does not mean a workload has no cost. Unbounded Pods can consume node resources until neighbors or node agents fail.

## Requests and limits

CPU is measured in cores (for example `500m` is half a CPU); memory uses byte units such as `Mi` or `Gi`. Requests are used primarily by the scheduler to account for a Pod's reservation. A container may use more than its CPU request when spare capacity exists. A CPU limit is enforced as a ceiling, typically through throttling, not as a dedicated core. Memory request guides scheduling and pressure decisions; a memory limit is enforced reactively by the kernel and an over-limit process may be OOM-killed.

```yaml
resources:
  requests:
    cpu: "250m"
    memory: "256Mi"
  limits:
    cpu: "1"
    memory: "512Mi"
```

These are illustrative application values, not universal recommendations. Measure representative peak load and memory behavior, and include runtime overhead. A too-low CPU limit can increase latency through throttling; an arbitrarily high request reserves capacity the workload rarely uses; a memory limit below peak causes restarts. Memory is not reliably throttled like CPU: once a cgroup exceeds its limit, the kernel may kill a process, but timing depends on pressure.

The scheduler uses effective Pod requests and node allocatable resources, not a dashboard's momentary utilization. Container requests are generally summed for concurrently running containers, while regular init containers run sequentially; restartable sidecar init containers can overlap with subsequent init and app containers. Effective Pod requests therefore need to reflect the highest resource phase. Pod overhead and Pod-level resource features may also affect accounting where supported. Inspect Kubernetes version and API behavior for advanced features rather than assuming all clusters calculate every new field identically.

A limit without a request is generally copied to the request unless admission defaults change it. Namespace `LimitRange` can apply defaults or enforce bounds; `ResourceQuota` can cap aggregate resource requests, limits or object counts in a namespace. These policies can cause Pod creation or scheduling failures that appear unrelated to an individual manifest. Check the admitted Pod and namespace policies when requests differ from submitted values.

## Quality of Service classes

Kubernetes assigns a Pod a QoS class: `Guaranteed`, `Burstable` or `BestEffort`. For container-level CPU and memory, `Guaranteed` requires every container to have both request and limit for both CPU and memory, with each request equal to its corresponding limit. `BestEffort` has no CPU or memory requests or limits. Other configurations are `Burstable`. Check the actual Pod with `kubectl get pod <name> -o jsonpath='{.status.qosClass}'`.

QoS is useful but not a simple invulnerability ranking. Under node pressure, kubelet eviction decisions account for whether usage exceeds requests, Pod priority and usage relative to requests. QoS offers an intuition but does not replace understanding the eviction signals. `Guaranteed` Pods can still be terminated by their own limit, preempted or evicted if the node must recover critical resources. A memory request is not a private memory reservation in the same sense as a dedicated VM.

## Node pressure and eviction

Kubelet monitors signals such as available memory, filesystem space and inode availability. If thresholds are crossed, it may evict Pods to preserve node stability. This node-pressure eviction is different from an API eviction initiated by a controller or administrator. Node-pressure eviction does not honor a PodDisruptionBudget and hard thresholds may lead to immediate termination. A PDB protects against certain voluntary disruptions that use the Eviction API; it cannot prevent every failure or kubelet action.

Ephemeral storage also needs attention. Container writable layers, logs and `emptyDir` volumes consume node-local storage. Request and limit `ephemeral-storage` where supported and useful; monitor disk and inode pressure. A Pod can fail even if CPU and memory look healthy. `emptyDir` data is tied to the Pod and may consume memory if configured as memory-backed; it is not durable storage.

## Sizing and diagnosis

Start by measuring workload behavior over representative peaks and failure modes. CPU usage percentiles help tune requests; application latency under throttling helps decide whether a limit is appropriate. Memory working set, OOM events and runtime heap should guide request/limit choices. Use `kubectl top` as a quick signal only when the metrics API is installed; it is not a complete historical observability system.

```bash
kubectl describe pod <pod-name>
kubectl get pod <pod-name> -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'
kubectl top pod <pod-name> --containers
kubectl describe node <node-name>
```

Inspect `OOMKilled`, restart counts, `Pending` reasons, node conditions and events. A `Pending` Pod may have an unsatisfied CPU or memory request even while average cluster utilization is low: requests determine schedulable capacity, and fragmentation or placement rules can make remaining capacity unusable. A running container with high latency may be CPU throttled; verify metrics such as throttled time in your monitoring stack instead of inferring from an average CPU chart.

## Admission defaults and capacity planning

Resource policy is often layered. A LimitRange may apply a default request or limit, and a namespace quota may require requests or limits for every container. A Pod can be rejected at admission before the scheduler evaluates it, or admitted but remain Pending because its effective request cannot fit. Compare the authored template with the live Pod using `kubectl get pod <name> -o yaml`; this shows mutations and defaults applied at creation. When a workload adds a sidecar through a webhook, that container's request may materially change scheduling and QoS even though the application chart did not change.

For capacity planning, sum effective requests across all Pods, then account for DaemonSets, system reservations, rollout surge and failure reserve. Node allocatable is lower than raw machine capacity because kubelet and system processes need resources. Fragmentation matters: a cluster may have enough total free CPU but no single node with sufficient memory, or topology and taints can make nominal capacity unavailable to a workload. Track Pending duration alongside utilization and requests. Autoscalers make decisions from requests and constraints; inaccurate values can produce both excess nodes and unschedulable replicas. Review quotas and node pools when workload shape changes, rather than treating a single utilization percentage as the capacity model.

## Common mistakes

- Setting requests equal to current idle usage and then wondering why the Pod is evicted at peak.
- Setting CPU limits too tightly without testing latency and throttling behavior.
- Treating `Guaranteed` QoS as a promise that the Pod cannot be killed.
- Forgetting init-container resource peaks, sidecars, logs and ephemeral storage.
- Raising cluster node count to solve Pending Pods without checking quota, selectors, taints or requested capacity.

## Production notes

Set default and maximum policies at namespace boundaries, but do not let a LimitRange silently impose values inappropriate for every service. Track request-to-usage ratios and regularly revisit them as traffic and runtime change. Reserve resources for system daemons through the node management configuration where available; user workloads do not own all node capacity. Keep capacity headroom for rollout surge and recovery, and distinguish workload OOM from node-pressure eviction. Resource policy is both a reliability and cost decision: accurate requests let schedulers place work safely and autoscalers estimate demand, while generous defaults can strand capacity and inflate spend.