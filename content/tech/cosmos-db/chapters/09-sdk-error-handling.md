# SDK Usage and Error Handling

The Azure Cosmos DB SDK is more than a thin HTTP wrapper. It manages endpoint discovery, connection behavior, session tokens, retry policies, diagnostics, serialization, and—in many languages—bulk execution. Correct use of the SDK can determine whether a workload is efficient and whether its consistency assumptions hold. Keep a long-lived client for an account and application lifetime, configure it deliberately, and instrument the full request path.

## Client and operation shape

Create a singleton or otherwise long-lived client rather than constructing one per request. A client maintains connections and routing metadata; repeated construction adds latency and resource overhead. Set the preferred regions and consistency at startup from explicit configuration. Reuse a serializer configuration and ensure its JSON naming conventions match the stored item shapes. Avoid embedding account keys in source code; use managed identity or a secret store with least-privilege access where supported.

For reads, use point operations when both item ID and partition key are known. For queries, pass the partition key if the request is naturally scoped, project only needed fields, and page through results using continuation tokens. Treat a continuation token as an opaque cursor, not an offset or promise that the underlying dataset never changes. Don't collect an unbounded query into a list before returning the first result to a caller.

Use ETags and conditional writes for optimistic concurrency when two clients may update the same item. A 412 precondition failure indicates that the observed version is stale; re-read and reconcile rather than blindly repeating the same replacement. Use idempotent item IDs or application idempotency keys for create flows that may be retried after an uncertain network outcome.

## Retries and status handling

SDK retry policies handle common transient responses, including throttling (429), using server retry guidance. Avoid adding an immediate outer loop that retries every exception; nested retries multiply latency and load. Define an overall request deadline and ensure SDK retry time fits within it. Log when retries are exhausted, along with status code, substatus, activity ID, request charge, retry delay, and diagnostic timeline where available.

A 429 is a throughput signal, not necessarily a failed business operation if the SDK ultimately succeeds. Monitor both service-side throttles and application-visible failures. If exhausted, inspect normalized RU by partition range, query diagnostics, and key skew. A 5xx or timeout may also leave a write outcome uncertain. A retry of a create can produce a conflict if the first attempt committed; use stable IDs and handle conflict by reading and validating the existing item. Treat authorization, invalid input, and malformed query errors as non-retryable until the cause is fixed.

For cancellation, propagate the caller's cancellation token so abandoned requests do not consume retries and response work unnecessarily. However, cancellation on the client does not prove a server-side write did not commit. On a retry, reconcile by idempotency key or read-before-retry logic appropriate to the business operation.

## Bulk and transactional batch

Bulk execution is designed for high-throughput independent operations. SDK bulk modes can group and schedule operations efficiently, but are not one all-or-nothing transaction. Limit concurrency, tune it against throughput and latency, and expect throttling if the workload exceeds available RU/s. Make the pipeline restartable with deterministic IDs and a checkpoint or reconciliation plan. Do not treat a successful bulk API call as proof that every item succeeded; inspect per-operation results.

Transactional batch is different: it groups point operations for the same logical partition key and commits all or none. Keep batches bounded and inspect individual operation responses when the batch fails. A failed item can cause other operations to report dependency failures. The batch does not provide a cross-partition transaction, and a multi-partition business process requires a different model, saga, or compensating action. When the SDK offers patch operations, use them for targeted field updates where appropriate; a smaller payload does not automatically mean an operation is free of index or RU cost.

## Diagnostics and resilience

Cosmos DB SDK diagnostics can reveal contacted regions, retries, request durations, and query execution details. Capture these on failures and unusually slow requests; logging every full diagnostic payload at high volume can add cost and noise. Correlate with Azure Monitor metrics and service-side diagnostic logs using timestamps and activity identifiers. Keep PII and secrets out of log fields.

Resilience includes connection and routing configuration, but also application behavior under partial failure: idempotency, bounded retry, circuit breaking where appropriate, backpressure, and graceful degradation. Load tests should include 429s, temporary network loss, regional failover, and service throttling. Client SDK versions matter; upgrade deliberately and run compatibility tests before production rollout.

## Common mistakes

- Creating a new SDK client per request or failing to configure preferred regions.
- Retrying all exceptions in a tight loop, overriding SDK backoff, or exceeding user deadlines.
- Assuming a client timeout proves that a write was not committed.
- Treating bulk execution as transactional or ignoring individual operation failures.
- Using transactional batch across more than one partition key.
- Discarding diagnostics that could distinguish hot partitions from general capacity pressure.

## Production notes

Centralize client construction, serializer settings, region preferences, retry/deadline policy, and diagnostics. Track operation type, status/substatus, RU charge, retries, latency percentiles, and partition-key scope. Test replay after timeout and partial bulk failure. Revisit SDK guidance when upgrading because retry defaults, diagnostics, and feature support evolve across language clients.

## Distinguish retryable from reconcilable failures

A retry policy can safely repeat some requests, but an application must consider whether the server may already have applied the operation. Read-only queries and deterministic upserts often have clearer replay behavior than a workflow that generates a new random identifier or triggers an external action. Use a request identity that remains stable across client retries. If the service returns a conflict after a timed-out create, read the existing item and compare its idempotency key and payload before reporting success. A mismatched record is a business conflict that needs resolution.

Classify failures by cause and action: 429 means respect retry-after and examine capacity; 412 means refresh and reconcile an optimistic concurrency conflict; 404 may be a genuine absence or a routing/model error; authorization errors need configuration correction; transient network or service errors need bounded retries and uncertainty handling. Use status and substatus codes alongside diagnostics, not broad exception type alone. Apply a request-level timeout that leaves enough time for SDK retries and response processing.

For bulk pipelines, persist progress only after each batch's outcomes are known and durable. On restart, replay deterministic operations and track failures individually. A per-item result ledger makes it possible to repair only rejected records rather than rerunning the whole import blindly. Keep concurrency configurable so operators can reduce pressure during a throttling incident without deploying new code. This combination of bounded retries, idempotency, and diagnostics makes transient faults recoverable rather than invisible.
