# Production Concerns: Resilience and API Boundaries

A production API is a dependency graph under load, not just a request handler. Its behavior depends on DNS, TLS, gateways, application workers, databases, queues, and downstream services. A design that omits deadlines, backpressure, observability, and clear ownership can look healthy in unit tests and fail under partial outages. This chapter connects API-level choices to practical service operation.

## Timeouts and deadlines

Every outbound call needs a timeout. Without one, a stalled dependency can occupy a worker indefinitely and consume connection pools until unrelated requests fail. Set separate connect, read, and overall deadlines where the client library supports them. A connect timeout bounds establishing a connection; a read timeout often bounds an interval without bytes, not necessarily the full operation. An end-to-end deadline should include queueing, retries, and downstream work, with remaining time propagated where appropriate.

Choose timeout budgets based on measured latency distributions and the caller's service objective. A timeout that is too short creates avoidable failures; one that is too long holds resources and delays recovery. A timeout does not guarantee cancellation reached the remote server, so side effects still need idempotency or reconciliation. Return a meaningful gateway timeout when the API is acting as a gateway and can identify an upstream timeout; avoid disclosing internal hostnames or dependency details.

## Circuit breakers and bulkheads

A circuit breaker tracks failures to a dependency and temporarily stops calls after a configured threshold, allowing the dependency and caller to recover. It commonly has closed, open, and half-open states. Closed permits normal calls; open fails quickly; half-open allows limited probes. Thresholds, reset intervals, and what counts as failure depend on the dependency and workload. A breaker is not a rate limiter or a substitute for timeouts. Misconfigured breakers can oscillate, mask recovery, or turn a brief failure into an extended outage.

Bulkheads isolate resource pools: separate worker or connection capacity for critical versus optional dependencies prevents one slow system from consuming all service capacity. Bound concurrency and queue length. Reject or shed work when the system cannot meet its latency promise rather than accepting unlimited requests that will time out later. Degraded responses are useful only when they are truthful and safe; never silently return stale authorization or financial state as current.

## Observability without leaking data

Use structured logs with request or trace identifiers, route templates, status codes, latency, and dependency outcomes. Avoid logging raw URLs when they contain high-cardinality IDs or query secrets; log normalized route names and safe dimensions. Do not record authorization headers, API keys, passwords, full payment data, or unrestricted request bodies. Traces can show where a request spent time across services, but sampling and attribute limits are needed to control cost and data exposure.

Track both aggregate service objectives and per-route behavior. Useful measures include request rate, error rate by stable category, latency percentiles, saturation (worker pools, database connections, queue depth), timeout and retry counts, and dependency health. Avoid metrics labeled by user ID, arbitrary URL, or error text: high cardinality can overwhelm monitoring systems and create a privacy issue. A trace ID in an RFC 9457 `instance` or extension can help support staff correlate a response with protected server-side diagnostics, as long as it is not a bearer secret.

Health endpoints should distinguish liveness from readiness. Liveness answers whether the process should be restarted; readiness answers whether it should receive new traffic. Do not make a liveness probe fail merely because a downstream service is unavailable, or orchestrators may restart every instance and amplify the outage. Probe dependencies through suitable readiness checks and use bounded timeouts.

## Gateway, BFF, and service responsibilities

An API gateway is an infrastructure boundary that can centralize routing, TLS termination, coarse rate controls, request-size limits, and common telemetry. It does not eliminate the need for application-level authorization, validation, and domain invariants. Keep policies visible and version controlled; duplicate security rules in several places only if ownership and precedence are clear. Gateway-generated errors should preserve a predictable contract where feasible.

A backend-for-frontend (BFF) is an application service tailored to a particular client experience. It can aggregate data, adapt schemas, and reduce client round trips for a mobile or web client. Unlike a generic gateway, it often owns product-specific composition and authorization context. A BFF is useful when clients genuinely need different views; it adds another hop and deployment surface, and should not become a dumping ground for unowned business rules. One gateway and multiple BFFs can coexist because they solve different problems.

## Common mistakes

- Using unbounded downstream waits and hoping the load balancer will time out first.
- Retrying inside a circuit breaker without respecting a shared deadline.
- Making liveness depend on every downstream dependency.
- Logging full request bodies or tokens to debug a production incident.
- Putting request IDs and user IDs into metric labels with unbounded cardinality.
- Treating a gateway as the sole location for authorization enforcement.
- Creating a BFF that duplicates domain rules without a clear owner.

## Production notes

Run failure drills for slow dependencies, dropped responses, connection pool exhaustion, and partial regional outages. Verify that timeouts leave enough budget for error serialization and cleanup. Examine p95/p99 latency and saturation together; low average latency can hide queueing. Set alerts on user-visible objectives rather than every internal metric. Document which team owns each boundary and where request IDs can be queried. Resilience mechanisms need load tests and operational tuning; thresholds copied from another service are not evidence that the design is safe.

## Capacity and graceful degradation

A service should know what it will stop doing first when capacity becomes scarce. Optional enrichment, recommendations, and nonessential analytics may be omitted or served from a clearly marked stale cache, while authorization and core transaction checks remain mandatory. Define degradation per endpoint and communicate it; a response that quietly drops a critical field is a contract change. Bound request body size, per-request fan-out, concurrent work, and queue depth. Admission control can reject work before allocating expensive resources, giving clients a faster, clearer failure than accepting requests the service cannot finish.

Plan for connection-pool behavior as well as CPU. A saturated database pool can make application workers wait, causing request queues to grow even when CPU appears low. Include queue wait in latency measurement and reserve capacity for health and administrative operations. A circuit breaker should be tested for recovery behavior and should not hide persistent failures behind a permanently open state. Define who can adjust thresholds and how changes are rolled back.

A backend-for-frontend also needs independent budgets for downstream fan-out. Parallelizing calls can reduce latency but increase instantaneous load, and one slow call can hold the full response. Apply per-dependency deadlines and decide which fields are required before making the request. If the BFF returns partial data, mark it explicitly and ensure clients know whether retrying can fill the missing component. Operational boundaries need service-level objectives and on-call ownership, not only a diagram.
