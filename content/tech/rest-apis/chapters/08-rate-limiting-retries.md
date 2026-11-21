# Rate Limiting, Retries, and Idempotency Keys

Rate control protects shared capacity and provides a predictable response when demand exceeds what a service can handle. Retries help clients recover from transient network and server failures. Together, these mechanisms can either improve resilience or amplify an outage. The safe design starts by defining what is limited, how the client learns that, which failures are retryable, and how duplicate writes are prevented.

## Rate limit policy and feedback

A limit can be applied per principal, API key, tenant, endpoint, or aggregate service capacity. It may constrain request count, concurrency, bytes, or cost-weighted operations. There is no universal correct quota or algorithm: choose based on workload and fairness goals, and publish only policy that the service can operate reliably. Fixed windows are simple but permit bursts at window boundaries; token buckets allow configured bursts with a refill rate; leaky buckets smooth output. A concurrency limit controls simultaneous work, which is not equivalent to a request-per-minute quota.

HTTP `429 Too Many Requests` is defined by RFC 6585. Its response can explain the condition and include `Retry-After` as a date or delay. Rate-limit metadata fields have separate specifications and adoption patterns; do not imply that a particular header is universal. Document the algorithm sufficiently for clients to respond without depending on internal counter implementation. Return the same response shape through all relevant layers where possible, and ensure shared gateways and application limiters do not contradict one another.

A 429 is not the only way to protect a system. Under severe overload, a server may shed work earlier, reject admission, or fail fast with a temporary-unavailability status. Limit by authenticated identity when available rather than by IP alone; NATs can place many valid clients behind one address. Still consider unauthenticated endpoints and abuse cases. Avoid revealing sensitive account existence through different quota responses.

## Retry only when justified

A client should distinguish connection failures, timeouts, throttling, validation errors, authorization failures, and server errors. A timeout does not prove that the server did nothing: it may have completed the operation before the response was lost. Retry a safe or idempotent request when appropriate. Retry a non-idempotent operation only when the API provides a deduplication mechanism or the client can otherwise prove the original did not take effect.

Use bounded exponential backoff with jitter. A common shape is delay `min(cap, base * 2^attempt)` plus randomized spread, but choose parameters from the service latency and deadline budget rather than copying a magic schedule. Honor `Retry-After` when supplied, subject to a reasonable total deadline. Limit attempts and total elapsed time. Coordinate retries across layers: if an SDK, gateway, and application each retry three times, one caller request can become many backend attempts. Avoid retrying permanent 4xx failures, and do not retry a write after its deadline if the caller cannot safely reconcile the outcome.

## Idempotency keys for unsafe operations

For a POST that creates a payment, booking, or other one-time effect, an API may define an `Idempotency-Key` request header. It is an application contract, not a universal HTTP header behavior. The key identifies one logical operation, scoped at least to the authenticated principal and operation. The server atomically stores the key, a request fingerprint, and the result so duplicate submissions return the same logical outcome rather than execute again.

The implementation must handle concurrency: two identical requests with the same key arriving together must not both perform the side effect. Persist the reservation before or atomically with the effect, and represent in-progress state when the work cannot complete inside one transaction. Same key with a different payload should fail clearly. Define what happens when a key is retried with changed headers, what response is replayed, how long keys are retained, and what happens after expiry. If a request failed before any effect, the service may allow a retry; if the outcome is unknown, it needs reconciliation rather than blind duplication.

Idempotency is not exactly-once delivery across arbitrary distributed systems. It is a practical deduplication guarantee within a defined scope and retention period. Downstream processors may need the same operation identifier to avoid double effects. Keep the key out of analytics and logs where it can reveal sensitive workflow identifiers; if logged, protect and truncate appropriately.

## Common mistakes

- Retrying every request on every error, including invalid input and authorization failures.
- Retrying immediately in a tight loop and worsening the overload.
- Returning 429 without actionable retry guidance when the service can provide it.
- Trusting client-supplied idempotency keys without principal scoping and request matching.
- Storing the key after performing the charge, leaving a duplicate-effect race.
- Assuming a client timeout means the server rolled back.
- Letting retries at several layers multiply without a shared deadline budget.

## Production notes

Instrument attempts separately from logical operations. Track rate-limit decisions, retry counts, idempotency hits, in-progress key conflicts, and unknown outcomes. Test a dropped response after commit, simultaneous duplicate requests, same-key/different-body requests, expiry, and downstream timeouts. For long-running operations, create an operation resource and let clients poll rather than holding a request open through repeated retries. Resilience behavior is part of the contract: publish retryable status and timeout expectations, and make sure SDK defaults do not silently exceed service limits.

## Retry budgets and overload control

A service's retry policy should fit within an end-to-end time budget. If the caller has 800 milliseconds left, three attempts with one-second waits are not resilience; they are wasted work. Propagate a deadline or remaining-time budget where the protocol and trust model allow it, and stop when little time remains to complete useful work. A downstream call should not consume all capacity waiting for a result the original caller no longer needs. For asynchronous operations, return a durable operation identifier and make polling frequency part of the client guidance.

Backoff jitter matters when many clients fail simultaneously. Without randomness, clients can synchronize their retries at each interval and create repeated load spikes. A retry budget can cap extra attempts as a fraction of normal traffic, limiting amplification during outages. Use circuit breakers and admission control as complementary mechanisms, not as a reason to retry indefinitely. A server may return `503 Service Unavailable` for general overload and use `Retry-After` when it can offer a useful delay; `429` is appropriate when a caller-specific rate policy was exceeded.

Test the full dependency chain under load. Count logical calls and physical attempts separately so dashboards do not hide amplification. Make SDK defaults visible and configurable, and document whether the SDK retries automatically. Ensure retrying a request preserves its idempotency key and body exactly. If the operation's result is unknown, expose a lookup or reconciliation mechanism rather than suggesting the client invent a new key and submit again.
