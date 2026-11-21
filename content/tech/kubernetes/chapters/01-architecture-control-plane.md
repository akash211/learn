# Architecture and the Control Plane

Kubernetes is a collection of cooperating processes, not a single scheduler binary. Its central contract is an API: clients submit objects, the API server validates and persists them, and controllers repeatedly act on the persisted desired state. This architecture is why a `kubectl apply` can return successfully before a Pod is running, and why several seconds of apparent delay are normal. Acceptance by the API is not the same as completion by every controller and node.

## The API server and stored state

The `kube-apiserver` is the HTTP interface for Kubernetes resources. `kubectl`, controllers, operators and automation all use this API. Authentication establishes who made a request; authorization (commonly RBAC) checks whether that identity can perform the action; admission can validate or mutate the object; schema validation checks fields and types. Successful writes are stored in etcd, the backing key-value store for cluster state. In managed Kubernetes, the provider usually operates these control-plane components, but a cluster operator still needs to understand their availability and version compatibility.

The API server is not a long-running shell that executes the user's manifest. It stores a declarative object and returns it. A Deployment object expresses a number of replicas and a Pod template; controllers observe that state and create ReplicaSets and Pods. API objects have a `spec`, describing desired state, and a `status`, updated by controllers and the node agents to report observations. `kubectl get -o yaml` exposes both. Status is evidence, not an independent desired-state input to edit casually.

Many APIs have versions, such as `apps/v1` for Deployments and `v1` for Pods and Services. API versions describe a schema and lifecycle, not necessarily a different resource in storage. Removed or deprecated APIs matter during upgrades: manifests, CRDs, operators and clients must be compatible with the target server. Check a cluster's served APIs with `kubectl api-resources` and use supported API versions rather than copying an old manifest from a blog.

## Controllers and reconciliation

A controller is a control loop: read current objects, compare them with a target, then issue API writes to move the system toward that target. The Deployment controller creates or updates a ReplicaSet; a ReplicaSet creates Pods; the scheduler binds eligible unassigned Pods to nodes; kubelet on each assigned node asks the container runtime to create their containers. These components may be separate processes and do not require a single synchronous transaction.

Reconciliation is level-based. A controller generally cares that replicas equal the desired count, not that it saw a particular event. Events and watches help it react quickly, but it can recover after missing a notification by re-reading state. This is different from an imperative script that assumes every command happened exactly once and in a particular order. Controllers can retry transient errors; their behavior remains bounded by available capacity, API connectivity, image availability, policy and the workload's own health.

The control plane has other controllers for endpoints, nodes, namespaces, service accounts and cloud integrations. Some are in `kube-controller-manager`; others are add-ons or external operators. The scheduler makes placement decisions for Pods, but does not launch virtual machines unless paired with a separate node autoscaler or cloud integration. Kubernetes is therefore a control system with pluggable actors, not a complete inventory of every implementation.

## Worker nodes and the Pod boundary

Each worker node typically runs kubelet, a container runtime implementing the Container Runtime Interface (CRI), and a CNI-provided network setup. The kubelet watches for Pods assigned to that node, reports node and Pod status, mounts requested volumes, starts containers and performs configured probes. The runtime (for example containerd or CRI-O) runs OCI containers. A container image is not a Pod: a Pod groups one or more containers that share a network identity and can share volumes. The Pod is the smallest ordinary scheduling unit.

The Kubernetes API does not implement every low-level behavior itself. A CNI plugin connects Pod networking; a CSI driver handles storage; CoreDNS commonly provides cluster DNS; a metrics adapter or exporter may feed autoscaling and monitoring. A Service is an API abstraction whose traffic forwarding depends on cluster networking implementation. Know which component provides a behavior before treating it as a universal property.

## A request's path through the system

Consider this Deployment fragment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: default
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - name: http
              containerPort: 80
```

The API server validates and stores the Deployment. The Deployment controller observes the replica target and creates a ReplicaSet; that controller creates three Pod objects. The scheduler selects an eligible node for each unbound Pod according to resource requests, constraints, taints and priorities. Kubelet then pulls the image if needed, configures networking and mounts, and starts the container. Readiness and status changes propagate through the API. If a Pod is deleted, the ReplicaSet notices the count is low and creates a replacement. A controller can maintain the count, but whether the new replica becomes Ready depends on the app and cluster dependencies.

Useful commands reveal this progression:

```bash
kubectl get deploy,rs,pods -l app=web -o wide
kubectl describe pod <pod-name>
kubectl get events --sort-by=.metadata.creationTimestamp
kubectl get nodes -o wide
```

Use a namespace and selector deliberately; cluster-wide output can obscure the object you are diagnosing. `kubectl describe` is a summary assembled from API state and events, not a packet trace or full controller log.

## Availability, extensions and boundaries

The API server, etcd, controller managers and scheduler are the critical control-plane pieces. A control-plane outage may prevent new API operations and reconciliation decisions, while existing containers can continue serving traffic temporarily. Exact behavior depends on component and workload. High availability design protects the API and data store; it does not automatically make application state highly available. A single database Pod remains a single failure domain even when the API is replicated.

Custom Resource Definitions (CRDs) add schemas to the API, and custom controllers reconcile them. An operator can encode application-specific lifecycle behavior, but adds software that must be secured, upgraded and kept compatible. Admission policies can also affect every matching write. Treat a new cluster-wide CRD, webhook or policy as production code: understand its failure behavior and test upgrade and rollback paths.

## Common mistakes

- Assuming `kubectl apply` means the workload is available. It only confirms the API accepted the request.
- Restarting a Pod before reading Events, controller status and node conditions. A restart often erases useful evidence.
- Treating a cluster's CNI, CSI, DNS or load-balancer behavior as built-in and identical across providers.
- Editing generated Pods directly when their owning Deployment or StatefulSet will recreate them.
- Expecting the scheduler to provision capacity or fix an unsatisfiable Pod specification.

## Production notes

Operate the API and etcd as reliability-critical systems, with supported versions, backups and tested recovery for self-managed control planes. For managed clusters, understand provider maintenance windows, endpoint access and supported version skew. Set alerts for API availability and certificate or upgrade deadlines, and document the components that implement networking, storage and admission. The most productive mental model is: API objects express intent; controllers reconcile it; kubelet and providers implement it; status and events show progress; none of those layers guarantees the application is correct.