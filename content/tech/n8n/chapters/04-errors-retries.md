# Error Handling, Retries and Error Workflows

A production workflow must define what to do when a remote API is slow, unavailable, rate-limited, returns invalid data or accepts a request but the connection fails before the response arrives. n8n offers node-level and workflow-level error handling, but the right choice depends on whether the failed operation is safe to repeat and whether the workflow can identify partial completion.

## Understand the failure first

Failures fall into different classes. A transient network timeout or HTTP 503 may succeed on a later attempt. An HTTP 400 validation error usually needs corrected input, not another identical request. HTTP 401 may indicate an expired or incorrectly scoped credential. A 429 response may carry a `Retry-After` header; retrying too quickly can extend an outage or trigger stricter limits. A node may also succeed remotely but fail locally before recording the response. In that ambiguous case, a retry can duplicate a write.

Inspect the node's error details and the service's semantics. HTTP Request can be configured for response handling and retry behavior; app nodes often expose their own options. Exact UI settings vary by node version. Decide whether the node should stop the execution, use an error output, or continue with failure information. “Continue On Fail” is useful when each item should be examined independently, but continuing without checking the error object may turn a failure into a misleading success downstream.

## Bounded retries and backoff

Retries are appropriate for transient faults when an operation is idempotent or protected by an idempotency key. Use a bounded number of attempts and a delay with backoff rather than retrying indefinitely at a fixed rapid interval. If a node offers “Retry On Fail,” review its maximum attempts and wait interval in the current version. For HTTP calls, honor server guidance such as `Retry-After` when available; a fixed delay can conflict with service policy. If a workflow has multiple retry layers, total attempts multiply: three node retries inside four workflow retries may produce twelve requests.

A retry policy should account for execution deadlines and vendor quotas. A long wait can hold up a worker and increase the backlog. Queue mode can absorb bursts, but it does not make a downstream API faster. When a request is not safe to repeat, do not blindly retry it. Use a client-generated idempotency key if the destination supports one, or first query the destination for a durable operation reference. If neither is possible, route ambiguous outcomes to reconciliation or human review.

## Error workflows

An error workflow is a separate workflow intended to process failures from workflows that reference it as their error handler. The Error Trigger node provides information about the failed workflow and execution, including error context. Use it to alert an operator, create an incident record or enqueue a safe repair task. Configure the workflow's error workflow setting explicitly and verify the behavior in a test failure; merely placing Error Trigger in a workflow does not make that workflow a global handler.

An error handler should be robust and modest. If it calls the same unavailable database or notification API that caused the original failure, it can itself fail. Prefer a separate alert path, include the source workflow and execution identifiers, and avoid forwarding entire execution payloads to broad chat channels. The error handler is not a transaction rollback mechanism. It can report or coordinate recovery, but cannot undo an email, payment or remote write that already completed.

Use a dedicated error path when the workflow can make a local decision. For example, IF can route a 429 response into a wait-and-retry branch, while non-retryable validation errors go to a dead-letter record. In more complex flows, keep the error path bounded and preserve source IDs, attempt count, operation name and the last remote response. Avoid feeding the same malformed item back through a loop without changing the condition that caused failure.

## Partial success and compensation

A workflow may write to a CRM, then fail while sending a notification. Retrying the entire execution could create the CRM record twice. Split steps according to their side-effect boundaries, record the external ID after a successful write, and make the next attempt detect prior completion. In multi-system operations, consider a saga-like pattern: each completed action has a compensating action or a reconciliation step. Compensation is not guaranteed to restore the exact original state, particularly if other users or automations have acted in the meantime.

For batch input, decide whether one failed item should stop all items. Continue-on-fail behavior can allow independent records to complete, but the workflow must collect and surface item-level failures. A success notification should distinguish “all succeeded” from “some items failed.” If business consistency requires all-or-nothing behavior, implement an explicit staging and commit process in a transactional system rather than assuming n8n's graph is atomic.

## Operations and observability

Save enough failed-execution data to debug without retaining sensitive payloads indefinitely. Use execution pruning and external alerts or logs with an appropriate retention policy. Monitor failure rate, execution duration and queue depth rather than only whether the n8n process is alive. Set timeouts so a hung remote request does not occupy a worker forever. Correlate a run with vendor request IDs and a business-level operation key, but do not put access tokens or sensitive customer data in alert messages.

Test failure paths intentionally: simulate a 429, a timeout, malformed JSON, missing credentials and a downstream outage. Verify the exact number of requests, whether any side effect is duplicated, whether alerts are delivered and whether the workflow ends in a visible failed or quarantined state. A green test for the success path says little about production resilience.

## Distinguish error surfaces

A node can fail before it sends a request, receive a non-success HTTP response, or lose its connection after a remote system committed an operation. Those conditions may surface differently in the execution details. Inspect the returned status, response body, request timing and any remote correlation identifier. If a service provides a status endpoint for asynchronous jobs, polling that job is often better than resubmitting the original request. A failed execution is an observation about n8n's attempt, not definitive proof that the remote side effect did not happen.

Separate technical recovery from business recovery. Technical recovery may retry a transient call; business recovery may require an operator to confirm whether a duplicate order, notification or record should be corrected. Keep a quarantined state for items that cannot be processed safely, and expose a controlled way to resume them after repair. Record who resolved the item and what action was taken when the workflow has material business consequences.

## Common mistakes

- Retrying writes without knowing whether the destination supports idempotency.
- Retrying permanent 4xx errors or ignoring `Retry-After` on 429.
- Treating “Continue On Fail” as a recovery policy.
- Assuming the error workflow automatically rolls back prior nodes.
- Alerting with full payloads that may contain personal data or secrets.
- Reporting a mixed batch as successful because at least one item completed.
