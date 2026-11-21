# Services, Ingress and DNS

Pods are replaceable endpoints. Their IPs can change when they are recreated, and a Deployment can scale from one Pod to many. Clients should not track Pod addresses. Kubernetes Services provide a stable virtual endpoint for a set of selected Pods, while EndpointSlices publish the current backends. DNS records make those stable service names convenient for in-cluster clients.

## Service selectors and ports

A Service selector matches Pod labels. The control plane's endpoint controller updates EndpointSlices as matching Pods become eligible; readiness affects whether an endpoint is normally considered ready for traffic. A Service has a stable cluster IP for its lifetime unless it is headless, and kube-proxy or an alternative dataplane implements forwarding. The exact packet path, source-IP behavior and load distribution depend on that implementation.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector:
    app: api
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: http
  type: ClusterIP
```

The Service's `port` is the port clients use; `targetPort` is the port on selected Pods and can be a named container port. A Service does not start a process or verify the application's protocol. If selector labels do not match, the Service can exist with no endpoints. Inspect it with:

```bash
kubectl get service api
kubectl get endpointslice -l kubernetes.io/service-name=api
kubectl get pods -l app=api --show-labels
```

A `ClusterIP` Service is reachable within the cluster network. `NodePort` exposes a port through nodes, commonly as an implementation detail or for simple environments. `LoadBalancer` asks the environment or cloud controller to provision an external load balancer where supported. The API request is portable, but address allocation, health checks, firewall rules, annotations and costs are provider-specific. Do not assume a local cluster can provision an external cloud load balancer.

A headless Service sets `clusterIP: None`; DNS can return endpoint addresses rather than one virtual IP. StatefulSets often use this for stable per-Pod names. A Service without a selector may be used with manually managed EndpointSlices, but that shifts endpoint lifecycle ownership to the operator.

## Cluster DNS

A typical cluster runs CoreDNS and configures Pods to use cluster DNS. A service in the same namespace is generally addressable by its short name; cross-namespace clients use a qualified name such as `api.payments` or `api.payments.svc.cluster.local`, with the cluster domain configurable. DNS resolution is not an authorization check. NetworkPolicy and application authentication still determine whether traffic is allowed.

DNS failures can look like application outages. Check the Pod's `/etc/resolv.conf`, query DNS from a suitable diagnostic Pod, and inspect CoreDNS Pod status and logs. Search paths and `ndots` can cause a short hostname to generate several queries; external lookups may therefore be slower than expected. DNS caching behavior depends on the client, node-local cache and CoreDNS configuration. A successful DNS lookup proves name resolution at that moment, not that a TCP connection or application request succeeds.

## Ingress and Gateway API

Ingress is a Kubernetes API for HTTP(S) routing rules, but it is not itself a proxy. An Ingress controller watches these resources and programs a data plane such as a reverse proxy or cloud load balancer. Different controllers support different annotations and features; the same Ingress manifest may not behave identically across implementations. Ingress is established and widely supported, but its API surface is intentionally narrower than many controller-specific features.

Gateway API is a newer, role-oriented family of APIs designed for extensible traffic management. A GatewayClass identifies a controller implementation; a Gateway describes listeners; HTTPRoute attaches routing rules and backends. It supports richer portable patterns such as header matching and weighted routing, though the installed controller determines implementation support and conformance. Gateway API resources are add-on CRDs and implementation components; they are not guaranteed to be installed in every cluster. Check the implementation's support matrix and install CRDs and controller deliberately.

A simplified HTTPRoute can look like this:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: apps
spec:
  parentRefs:
    - name: public-gateway
      namespace: edge
  hostnames: [api.example.test]
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1
      backendRefs:
        - name: api
          port: 80
```

The Gateway listener must permit the route's namespace and hostname, and the referenced Service must exist with healthy endpoints. The controller reports acceptance and programmed conditions on resources; read them rather than assuming the object was applied successfully in the data plane. `kubectl describe httproute` and `kubectl get gateway,httproute -A` are useful starting points.

## External traffic and TLS

For TLS termination, decide where certificates live and which component terminates encryption. Ingress controllers commonly reference a TLS Secret; Gateway listeners use certificate references according to the implementation and API. Certificate rotation, private key access and hostname validation need operational ownership. If TLS terminates at an external load balancer, the cluster may receive plaintext or re-encrypted traffic; document the trust boundary and preserve client identity only through trusted proxy headers.

A `LoadBalancer` Service is often the simplest external exposure for one TCP service. Ingress or Gateway API is often more efficient for several HTTP services sharing an entry point, because routing is centralized. Neither choice removes the need for firewall policy, DNS records, health checks or rate limiting. Public exposure should be an intentional interface rather than an accidental consequence of changing Service type.

## Traffic policy and security

`externalTrafficPolicy: Local` can preserve client source IP in some implementations, but only nodes with local endpoints can serve traffic and load-balancer health checks matter. Session affinity can influence backend selection but is not a replacement for shared session state. NetworkPolicy controls Pod communication only when the CNI enforces it, and default policies vary. Service identity is not an identity-based security boundary by itself.

## Session behavior and endpoint changes

A Service's distribution is normally per connection or packet-path decision, depending on the dataplane; it does not guarantee an even number of requests per replica. Long-lived HTTP/2 or WebSocket connections can remain attached to one backend, so replica counts and request counts can diverge. If an application stores sessions only in process memory, a new connection may land on a replica that does not know the session. Prefer stateless request handling or an intentionally shared session store. Readiness removal prevents new traffic through ordinary endpoint handling, but established connections may continue until the client or proxy closes them. Graceful shutdown should stop accepting new work and finish in-flight requests within the termination grace period. These details matter when interpreting a rollout that appears healthy in Pod status but still produces brief client errors.

## Common mistakes and production notes

- Confusing Service `port` with Pod `targetPort`, leading to valid but unreachable endpoints.
- Applying an Ingress without an installed controller or assuming a specific annotation is portable.
- Debugging DNS when the Service has no ready EndpointSlices, or blaming DNS for a refused TCP connection.
- Making a Service public before confirming TLS, authentication, firewall and ownership.
- Expecting `kubectl port-forward` success to prove the production ingress path is healthy.

Use a request path to localize faults: resolve the name, inspect Service and EndpointSlice state, test connectivity to the Service and then test the chosen ingress or Gateway implementation. Keep selectors and labels consistent through rollout. For multi-team clusters, control which namespaces may attach routes to shared Gateways, and treat the Gateway controller and its CRDs as production dependencies that need upgrades and monitoring.