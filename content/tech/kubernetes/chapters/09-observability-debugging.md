# Observability and Debugging Workloads

Kubernetes debugging is the practice of moving across layers without destroying evidence. A Pod can be absent because its controller has not created it, Pending because the scheduler cannot place it, waiting because kubelet cannot start a container, Running but not Ready because the application fails its probe, or Ready while an external route is broken. Read desired state, status, events and logs in that order; then test the path that users actually take.

## Start with the object graph

Find the namespace and owner before acting:

```bash
kubectl get deploy,rs,pods -n apps -l app=api -o wide
kubectl describe deployment api -n apps
kubectl describe pod <pod-name> -n apps
kubectl get events -n apps --sort-by=.metadata.creationTimestamp
```

A Deployment owns a ReplicaSet, which owns Pods. `kubectl get all` is not literally every resource and may omit claims, policies or custom resources. Labels and namespace scope are important: first confirm that the selector is the one you intend. Owner references reveal which controller will recreate a deleted Pod. `describe` combines spec, status, recent events and related metadata; events expire and should not replace centralized logs.

Check Pod conditions and container state. `Pending` covers several causes including scheduling and volume setup. `ImagePullBackOff` suggests image name, registry authentication, network or pull-policy issues. `CrashLoopBackOff` is a backoff state after repeated exits, not the root cause. `kubectl describe pod` events and `kubectl logs --previous` often expose why the previous container exited. A `Running` Pod can still be unready or degraded.

## Logs, exec and ephemeral debugging

Use container selection for multi-container Pods. Logs from a terminated prior instance can explain a crash loop; timestamps help line up events and deployments.

```bash
kubectl logs -n apps <pod-name> -c api --tail=100
kubectl logs -n apps <pod-name> -c api --previous
kubectl exec -n apps <pod-name> -c api -- sh -c 'printenv | sort'
```

`exec` requires the image to contain the requested binary and the caller to have the required permission. Minimal images may not include a shell, curl or package manager. Avoid installing diagnostic software into a production container just to debug; use a controlled ephemeral debug container or a short-lived troubleshooting Pod with approved tooling, subject to cluster policy. Do not dump secrets through `printenv` into a transcript. `kubectl port-forward` is useful for local inspection but bypasses Services, ingress and network policies in ways that can make it a misleading production test.

## Events and probes

Events are namespaced or cluster-scoped messages emitted by components. Look for `FailedScheduling`, `FailedMount`, `FailedAttachVolume`, image errors, probe failures and evictions. Events are a useful timeline but are not guaranteed durable. Centralize logs, metrics and audit events appropriate to your reliability and security needs.

Liveness, readiness and startup probes have distinct meanings. Liveness failure causes kubelet to restart the container after configured failure thresholds. Readiness failure removes the Pod from normal Service endpoints but does not restart it. Startup probes delay liveness and readiness evaluation while an app initializes. A probe should use a cheap, bounded check that represents the intended property. If liveness depends on every downstream database or API, one shared dependency outage can restart all Pods and amplify the incident. Readiness can consider dependencies, but avoid making every temporary dependency hiccup remove every replica at once.

A probe example uses a named port:

```yaml
startupProbe:
  httpGet: { path: /health/startup, port: http }
  periodSeconds: 5
  failureThreshold: 24
livenessProbe:
  httpGet: { path: /health/live, port: http }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /health/ready, port: http }
  periodSeconds: 5
```

Thresholds should follow application startup and recovery times. The example does not imply a fixed Kubernetes default or a suitable production setting. TCP and exec probes are alternatives, each with trade-offs. An HTTP 200 only proves the check endpoint returned success; define carefully what that endpoint promises.

## Networking and service path

If a Pod is Ready but callers fail, inspect the Service selector and EndpointSlices, then test DNS and connectivity from a peer Pod. Compare the Service port to the target port and inspect ingress or Gateway conditions. NetworkPolicy enforcement depends on the CNI. A successful `exec`-based request from the same container may use loopback and does not prove peer traffic works. A successful port-forward does not traverse the normal cluster network dataplane.

For DNS, verify the Pod resolver configuration and test both short and fully qualified names. For HTTP routing, inspect the ingress controller or Gateway implementation's own events and logs. For an external load balancer, check provider status and health checks. Kubernetes resource status often identifies the responsible controller, but cloud-side state may require provider-specific tools.

## Metrics and resource symptoms

`kubectl top pod` and `kubectl top node` depend on the Metrics API, usually provided by metrics-server. They are useful snapshots, not long-term monitoring, accurate billing data or application metrics. Production observability typically combines time-series metrics, logs, traces, Kubernetes events and deployment metadata. Correlate application latency and errors with restarts, CPU throttling, memory pressure, pending replicas and node conditions.

High restart count can be a symptom of OOM, failing probes, process errors or node disruption. Look at the last termination reason and timestamps. A Pending Pod with low current cluster utilization can still be unschedulable because requests, affinity or volume topology do not fit. A Service with endpoints can still route to an app that returns errors. Debug the actual failing layer instead of applying a generic restart.

## Safe operational commands

Use narrow selectors, namespace flags and explicit resource names. Before deleting an object, identify its owner and whether deletion loses local data or triggers a replacement. `kubectl rollout restart` updates a controller's Pod template and performs a controlled replacement; it is not a diagnosis. Capture relevant YAML and events before changing the system. Avoid `kubectl delete pod --all` or broad namespace operations during an incident unless scope and consequences are explicit.

## Rollout and audit context

For a failure that begins after a release, compare the live Pod template and image digest with the previous ReplicaSet. `kubectl rollout history` records revisions of controller templates, while image tags alone may move unless the registry policy makes them immutable. Pair application logs with deployment timestamps, Kubernetes Events and trace identifiers so one request can be followed across services. Restrict log retention and access when payloads may contain personal or secret data. API audit logs answer who changed an object and when; they are distinct from application and controller logs. These timelines help distinguish a bad rollout from a node event or an external dependency incident, and make a rollback decision evidence-based.

## Common mistakes and production notes

- Reading only current logs after a crash and missing `--previous` output.
- Treating `CrashLoopBackOff` as a diagnosis rather than a retry state.
- Assuming a readiness or liveness probe tests the same condition.
- Using privileged debug access without auditing who can exec into production Pods.
- Deleting a Pending Pod repeatedly without fixing the scheduling or storage reason.

Create runbooks that include namespace, owner, selector and rollback steps. Retain enough event and log data to reconstruct rollout failures, and restrict access to logs that might contain sensitive information. Debugging should narrow uncertainty; each action should test a hypothesis while preserving evidence, not merely make the symptom disappear for a few minutes.