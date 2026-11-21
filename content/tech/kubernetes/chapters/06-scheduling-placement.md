# Scheduling, Affinity, Taints and Topology

The scheduler assigns an unbound Pod to a node that satisfies its requirements. It does not move running Pods when a better node appears, and it does not create capacity by itself. Scheduling is a two-stage idea: filter out nodes that cannot run the Pod, then score feasible nodes and choose among them. Resource requests, node selectors, affinity, taints, volume constraints, topology and priorities all influence the decision. If no node is feasible, the Pod remains Pending and the scheduler reports reasons in Events.

## Hard constraints and preferences

A `nodeSelector` is a simple hard requirement: all listed labels must match. Node affinity expresses richer required or preferred label rules. Required terms filter nodes; preferred terms influence scoring but do not guarantee placement. For example, pinning a workload to a zone may be necessary for data locality, while preferring one zone can keep it flexible when that zone is full. Labels are only as trustworthy as the process that assigns them; protect sensitive node labels from unauthorized modification.

Pod affinity attracts a Pod to nodes already hosting matching Pods, while Pod anti-affinity avoids co-location. These rules use a topology key such as `kubernetes.io/hostname` or a zone label. Required anti-affinity can make Pods unschedulable when there are not enough distinct eligible nodes. Preferred rules preserve flexibility but may be relaxed. Cross-namespace matching and namespaces selectors must be understood carefully so one team's labels do not unexpectedly influence another team's placement.

Topology spread constraints provide a declarative way to distribute matching Pods across domains such as zones or nodes. `maxSkew` bounds the difference in count for `DoNotSchedule`; `ScheduleAnyway` gives preference to placements that reduce imbalance without making it a hard barrier. The `labelSelector` determines which Pods are counted, and `topologyKey` determines the domains. `minDomains` can prevent placing replicas into a smaller-than-expected set of eligible domains, but may also make new Pods Pending during a zone outage. Choose failure behavior intentionally.

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: api
```

This snippet belongs in a Pod template and assumes nodes have the expected zone labels. A hard spread rule across zones can protect availability but blocks rollout if only one zone has capacity; use `ScheduleAnyway` when the balance is a preference rather than a safety condition. Multiple constraints combine, so a node must satisfy all hard constraints at once.

## Taints and tolerations

Node labels attract Pods; taints repel them unless the Pod tolerates the taint. A taint has a key, optional value and effect: `NoSchedule` prevents new placement, `PreferNoSchedule` is a soft avoidance, and `NoExecute` can evict existing Pods that do not tolerate it. Taints are useful for dedicated GPU or system pools, maintenance, and node conditions. Toleration does not force a Pod onto a node; it only removes that taint as a barrier. Combine tolerations with node affinity or selectors when a workload should run only on that pool.

```yaml
spec:
  tolerations:
    - key: workload
      operator: Equal
      value: batch
      effect: NoSchedule
  nodeSelector:
    pool: batch
```

This Pod can run on a node tainted `workload=batch:NoSchedule` only if the node also has the selected label. Do not add broad `operator: Exists` tolerations reflexively: they can admit workloads to nodes reserved for critical or specialized tasks. Kubernetes adds some tolerations automatically for node conditions and lifecycle behavior; inspect the admitted Pod if observed scheduling differs from the authored manifest.

## Priority, preemption and capacity

PriorityClass gives Pods a relative priority. If a high-priority Pod cannot fit, scheduler preemption may evict lower-priority Pods to make room, subject to policy and feasibility. Priority does not guarantee that preemption will help: topology, persistent volume access, anti-affinity or taints may still prevent the Pod from fitting. Priority can also cause service disruption, so do not assign maximum priority to every workload. PodDisruptionBudgets affect voluntary evictions through the Eviction API, but do not prevent all forms of node failure or kubelet pressure eviction.

A Pod can be unschedulable because its requests exceed node allocatable capacity, quota prevents creating replicas, a selector has no matching nodes, a taint has no toleration, a PVC cannot bind in the chosen topology, or a required spread rule has no eligible domain. `kubectl describe pod` and scheduler Events name the constraint classes that filtered nodes. Autoscaler integration may add nodes if a compatible node group or pool can satisfy the Pod; if none can, scaling cannot fix it.

## Affinity pitfalls and scoring

Many independent constraints can interact in surprising ways. A Deployment with required zone affinity, strict anti-affinity per hostname, and a topology spread constraint may have no feasible node after a partial failure. Start with the availability requirement, then add the smallest number of hard constraints necessary. Use preferences for goals that can be traded against availability. Inspect actual labels and taints before changing the workload.

Scheduler scoring chooses among feasible nodes according to enabled plugins and cluster configuration. It is not a general-purpose bin-packing guarantee and can differ across distributions or versions. Avoid hand-optimizing based on one observed placement; cluster autoscaling, DaemonSet overhead and concurrent scheduling all affect capacity. Requests are central to fit, while real utilization is a separate operational measurement.

## Debug workflow

```bash
kubectl get pod <pod> -o wide
kubectl describe pod <pod>
kubectl get nodes --show-labels
kubectl describe node <node>
kubectl get events --sort-by=.metadata.creationTimestamp
```

Start with the Pod's `FailedScheduling` events, then compare required labels, taints, requests and PVC topology to node state. For spread behavior, inspect labels on all intended domains and ensure the selector counts the correct Pods. If the Pod has no event, check API and scheduler health or whether it is owned by a controller that has not created it yet.

## Pod topology spread in rolling updates

A rolling update can temporarily create more Pods than the steady replica count, so a strict spread constraint must accommodate both old and new template labels. If the selector counts both revisions through a shared application label, surge Pods influence skew; if it selects only a version label, old replicas may not be counted. Decide whether availability should be balanced across all versions or only the new rollout cohort. Test the actual rendered Pod template and use `kubectl get pods -o wide --show-labels` to confirm which objects match. Topology spread is part of a workload's capacity contract: its behavior should be revisited when zones are added, removed or temporarily unavailable.

## Common mistakes and production notes

- Treating a toleration as node selection or thinking a preferred affinity is a guarantee.
- Using hard Pod anti-affinity without enough eligible nodes for replicas and rollout surge.
- Setting topology spread to use a label selector that omits existing replicas, producing skew that is not intuitive.
- Assuming a cloud node autoscaler can satisfy every hardware, zone and affinity combination.
- Using node labels for a security boundary without restricting who can change them.

Review placement policies during node pool changes and zone failure exercises. Ensure system components and DaemonSets can run on intended nodes, and keep a flexible pool for workloads that should not be stranded. Evaluate scheduling with real rollout replicas, not only a single Pod. Taints and labels provide governance mechanisms, but workload identity and RBAC determine who is allowed to create the Pod that carries a toleration.