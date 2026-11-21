# Pods, Deployments, StatefulSets and DaemonSets

A Pod is Kubernetes' scheduling and lifecycle unit. It wraps one or more containers that share a network namespace, Pod IP, and optionally mounted volumes. Containers in the same Pod can communicate over `localhost`; they start and stop as part of the same Pod lifecycle. This makes a Pod a good boundary for tightly coupled processes, not a general-purpose way to bundle unrelated services. If two components need independent scaling, rollout or failure handling, they normally belong in separate Pods and communicate through a Service.

## Pods and lifecycle

A Pod specification declares containers, volumes, service account, security context, resource requests, probes and other settings. Once a Pod is bound to a node, it is not moved to another node. If a node fails, a controller may create a new Pod, with a new name and typically a new IP. The desired workload object, not the Pod, provides durable intent. Pods have phases such as Pending, Running, Succeeded and Failed; `Running` does not guarantee that the application is ready to serve traffic.

Init containers run to completion in order before ordinary application containers start. They are useful for bounded initialization such as rendering configuration or waiting for a prerequisite, but waiting loops can hide dependency failures. Kubernetes also supports restartable sidecar containers expressed under `initContainers` with `restartPolicy: Always` in supported versions. These start in order and remain running alongside app containers. This behavior improves startup and shutdown ordering for sidecars, but check the cluster version and any admission mutations or tooling that might strip the field. Ordinary sidecars listed under `containers` remain a valid pattern when those lifecycle guarantees are unnecessary.

A bare Pod is appropriate for experiments and some tightly controlled system workloads. For a durable service, use a controller. The controller recreates Pods from a template and records rollout history or identity as appropriate. Do not patch a live Pod to deploy a new application version; update the owning template.

## Deployments and ReplicaSets

A Deployment manages interchangeable replicas, usually stateless web workers. Its selector must match labels on the Pod template. The Deployment controller creates a ReplicaSet for each Pod-template revision, and the ReplicaSet maintains the requested replica count. On update, the Deployment can create a new ReplicaSet, scale it up and scale the old one down according to rolling update settings.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: nginx:1.27
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 5
```

This uses a public nginx image and its default HTTP port as a runnable example; a production API should use its own image, immutable digest and health endpoint. `maxUnavailable` and `maxSurge` control the rollout's availability/capacity trade-off, not application-level safety. A readiness probe keeps an unready Pod out of Service endpoints, but it does not migrate in-flight requests or guarantee database compatibility. Rollbacks revert a Pod template revision; they cannot reverse a schema migration or undo external side effects.

Commands for inspecting a rollout:

```bash
kubectl rollout status deployment/api
kubectl rollout history deployment/api
kubectl rollout undo deployment/api
kubectl scale deployment/api --replicas=4
```

Manual scaling is temporary if a HorizontalPodAutoscaler controls the same target. Prefer adjusting the declared manifest or its source of truth so reconciliation systems do not revert the change.

## StatefulSets and stable identity

StatefulSets manage Pods whose identity and storage are meaningful across replacement. Pods receive stable ordinal names such as `db-0`, `db-1`; stable network identity is usually provided by a headless Service. A `volumeClaimTemplates` entry can provide a distinct PVC per ordinal. These features support ordered startup, termination and rollout where required, and preserve a Pod's association with its claim when it is recreated.

StatefulSet is not a database operator. It does not understand replication protocol, quorum, leader election, backup consistency or safe schema changes. Stable identity and a volume are building blocks; the application must handle membership and recovery, or an operator must encode those rules. A PVC may outlive a StatefulSet, depending on storage and deletion policies, so deletion needs an explicit data-retention plan. Rolling updates can stall when a Pod is not Ready; investigate the reason rather than forcing deletion without understanding quorum consequences.

Use a headless Service (`clusterIP: None`) when clients need per-Pod DNS records. StatefulSet update strategy can be `RollingUpdate` or `OnDelete`; the latter makes the operator responsible for deleting Pods to trigger template changes. Ordered semantics may be inappropriate for applications that can start and scale independently; Kubernetes also offers parallel management options for some operations. Choose behavior based on application requirements and tested recovery, not simply because a workload contains data.

## DaemonSets and Jobs

A DaemonSet aims to run a Pod on each eligible node, or on each node matching its selectors and scheduling rules. Typical uses include node-level log agents, CNI components and storage daemons. New matching nodes receive the Pod; removed nodes lose it. DaemonSets are not a substitute for a replicated application Deployment, since their replica count follows node eligibility. Ensure updates tolerate partial rollout and that privileged node agents receive narrowly scoped permissions.

Jobs run Pods to completion, with retry policy and completion counts; CronJobs create Jobs on a schedule. They fit finite work such as migrations, reports and batch processing. A Job retry can repeat effects, so task logic should be idempotent or use durable deduplication. CronJobs can overlap depending on concurrency policy and execution duration; schedules do not guarantee exact start time. Set deadlines, history limits and resource requests deliberately, and monitor failed Jobs instead of assuming a successful object creation means the task completed.

## Choosing a controller

| Workload need | Typical controller | Key contract |
|---|---|---|
| Interchangeable replicas and rolling updates | Deployment | Pods can be replaced with new identities |
| Stable ordinal identity and per-replica claims | StatefulSet | Identity and claim association persist |
| One Pod per eligible node | DaemonSet | Replica count follows node eligibility |
| Finite task or scheduled batch | Job / CronJob | Pods complete rather than serve indefinitely |

These are defaults, not rigid categories. A stateful cache might be safely replicated under a Deployment if data is disposable; an application can use a StatefulSet without requiring every ordering default. Validate the controller's behavior against real failure cases.

## Common mistakes and production notes

- Leaving a selector broad enough to capture another team's Pods, or changing an immutable selector during a Deployment update.
- Using `latest` and expecting rollback history to identify the exact bytes previously run.
- Using liveness checks to test a remote dependency, causing a dependency outage to restart every replica.
- Treating a StatefulSet as a complete backup and failover solution.
- Running a Job with non-idempotent effects and assuming retries happen exactly once.

Keep templates under version control, specify a rollout strategy, and test a failed rollout. Watch `kubectl get rs` and `kubectl describe deployment` to determine whether the controller is making progress. For persistent workloads, verify PVC retention and restore procedures separately from controller behavior. In newer clusters, restartable init-container sidecars can provide a better lifecycle model, but remain attentive to version compatibility and the effective Pod resource request while init and sidecar containers overlap.