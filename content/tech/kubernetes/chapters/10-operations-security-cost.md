# Operations, Security, Cost and Multi-Tenancy

Running Kubernetes safely is an ongoing operating practice, not the act of creating a cluster. Operators must manage versions, API compatibility, identities, policy, network boundaries, workload resources and the shared cost model. A managed control plane reduces some administrative work but does not make application workloads or add-ons self-maintaining.

## Upgrades and lifecycle

Kubernetes releases on a regular cadence and supports a limited number of recent minor releases. Exact supported windows and upgrade paths change; consult the official release and provider policy before planning. Keep API clients, CRDs, controllers, admission webhooks, CNI, CSI, metrics adapters and node images compatible with the target version. A successful control-plane upgrade can still leave an old CRD controller or deprecated manifest broken.

A safe upgrade begins with inventory: `kubectl api-resources`, API deprecation warnings, deployed CRDs and controllers, node versions, and provider-specific add-ons. Test the target in a representative non-production cluster. Update manifests away from removed APIs, validate webhook availability, and verify backup/restore and rollback options. Upgrade control plane and nodes according to provider guidance; version skew rules apply to components such as kubelet and `kubectl`. Drain nodes carefully, with PDBs and local storage considered. Rollback is not always as simple as downgrading a control plane or restoring etcd.

Plan maintenance capacity. A node drain uses eviction for eligible Pods and can be blocked by a PDB, local data, unmanaged Pods or termination hooks. A Pod may be unavailable during an otherwise successful upgrade if it has no spare replica. Confirm application redundancy and storage behavior before maintenance, and watch new node conditions and workload readiness afterward.

## RBAC and identity

Kubernetes authentication identifies a user, workload or service account; RBAC authorization grants verbs on API resources. A Role is namespaced and a ClusterRole can express cluster-wide permissions; bindings connect roles to subjects. Prefer namespace-scoped Roles, narrowly scoped resources and verbs, and dedicated ServiceAccounts for workloads that need API access. Avoid `cluster-admin` for routine automation.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: config-reader
  namespace: apps
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
```

This role intentionally does not grant access to Secrets. Bind it only to the specific service account or group that needs it. `kubectl auth can-i` tests the current identity's authorization. RBAC is additive: there are no deny rules, so review all bindings and groups, not just one role. A user who can create Pods may often mount namespace Secrets; minimize who can create arbitrary Pods in sensitive namespaces.

## Pod and API security

Use Pod Security Standards through namespace labels or an equivalent admission policy to restrict privileged containers, host namespaces, host paths, capabilities and unsafe security contexts. Run as non-root where possible, drop unnecessary Linux capabilities, use read-only root filesystems where compatible, and set seccomp profiles. Pin images by digest or immutable version and use a trusted registry, signature verification and vulnerability scanning appropriate to your supply chain.

NetworkPolicy expresses allowed Pod ingress and egress, but only works if the CNI enforces it. Start with a tested default-deny policy and explicit DNS, monitoring and service dependencies; a policy that accidentally blocks DNS can look like an application fault. Policies are additive and selectors have namespace scope subtleties. Validate policy in a test namespace before applying cluster-wide.

Admission can enforce standards at API request time. ValidatingAdmissionPolicy uses CEL expressions in the API server and is stable in current Kubernetes; policies require bindings to take effect. A webhook remains useful for logic that needs external context or complex mutation, but introduces a network dependency on the admission path. Test failure policy, scope, exemptions and latency. A `failurePolicy: Fail` can reject matching requests when evaluation fails; a broad policy can prevent deployments across the cluster. Stage enforcement with audit or warning modes where supported before denying production changes.

## Multi-tenancy and governance

Namespaces organize namespaced resources and are useful policy boundaries, but are not independent clusters. They share the control plane, nodes, kernel, network and often storage or admission components. A namespace does not protect an application from a privileged workload on the same node. For mutually untrusted tenants, stronger isolation may require dedicated clusters, virtualized nodes or provider-specific sandboxing.

A namespace onboarding baseline can include ResourceQuota, LimitRange, RBAC, network policy, Pod Security labels, default service account settings, and observability. Separate duties: platform operators manage cluster-wide extensions and node pools; application teams manage a constrained namespace and approved templates. Audit who can create CRDs, ClusterRoles, webhooks, privileged Pods, hostPath mounts and node selectors. Namespaces alone are not billing or security boundaries.

## Cost and capacity

Kubernetes cost arises from node capacity, storage, load balancers, data transfer, control-plane offerings and operations. Requests drive scheduling and many capacity/cost reports; unused requested resources can strand node capacity. Limits can lead to CPU throttling or OOM, so reducing them simply to improve utilization may degrade reliability. Track actual use, requests, pending workloads, idle capacity, storage growth and external service costs together.

Node autoscaling can reduce unused compute but may create churn or interfere with local storage and strict placement policies. Consolidation and spot/preemptible capacity need disruption-aware workloads, PDBs and graceful termination. Keep a reserve for rollout surge, node failure and system daemons; a cluster packed to measured average usage has no margin for peak load. Cost allocation by namespace or labels is an estimate unless the accounting system maps shared resources explicitly.

## Operational security and upgrades

Restrict API endpoint access, rotate credentials, secure etcd backups, monitor audit logs and patch nodes. Treat kubeconfigs as sensitive identities; a copied admin kubeconfig may grant full cluster access. Avoid static cloud credentials in Pods where workload identity federation is available. Keep controller permissions minimal and review upgrade compatibility of CRDs and webhooks as part of release management.

## Supply chain and ownership boundaries

An image's provenance matters after it reaches the cluster. Prefer pinned digests or immutable tags, maintain a controlled build path, scan for known vulnerabilities and decide how signatures or attestations are verified at admission. Scanning is not a guarantee that a build is trustworthy; access to the source repository, build runners and registry credentials must also be protected. Separate the permissions that build and publish images from those that deploy them.

Operational ownership should be explicit for shared services. The platform team may own the CNI, ingress controller, storage classes, admission policies and node images, while application teams own their templates, probes, resource settings and data lifecycle. Define incident escalation and compatibility expectations before a cluster add-on upgrade. Avoid giving tenant teams broad cluster permissions to solve routine deployment needs. A clear boundary reduces both security exposure and time spent diagnosing whether a failure belongs to the application, a controller or the infrastructure provider.

## Common mistakes and production notes

- Assuming managed Kubernetes removes responsibility for add-ons, application RBAC and workload patching.
- Using namespace boundaries as if they were VM or kernel boundaries.
- Deploying a fail-closed admission webhook with no availability and bypass plan.
- Applying default-deny NetworkPolicy without allowing required DNS and telemetry paths.
- Reducing every request to observed average and leaving no room for bursts or recovery.

Write an operational ownership map: who owns the control plane, nodes, CNI, CSI, ingress/Gateway, policies and application data. Keep an upgrade calendar, least-privilege review and tested disaster recovery. A cluster is a shared platform; tenancy is safe only when identity, admission, network, resource and node-isolation controls are composed and tested together.