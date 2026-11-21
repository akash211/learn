# Webhooks, Scheduling and Idempotency

A workflow can start because a remote system pushes an event, because n8n polls or schedules work, or because an operator starts a manual run. Push and scheduled designs have different failure modes. Webhooks can deliver quickly but may be retried or duplicated by the sender. Polling can recover missed changes only if the remote API exposes a useful cursor or update time. Neither model provides exactly-once processing by itself.

## Webhook URLs and request handling

The Webhook node creates a URL with a path and HTTP method. During testing, n8n exposes a test URL that is available while listening for a test event; active production workflows use a production URL. The exact URL format and response behavior depend on the node's configuration and n8n version. The receiving system must call the correct public endpoint, and reverse proxy configuration must route that endpoint to the appropriate n8n listener.

For a self-hosted instance behind a reverse proxy, configure `WEBHOOK_URL` to the externally reachable HTTPS base URL and set `N8N_PROXY_HOPS` to the number of trusted proxies in front of n8n. The proxy should terminate TLS, preserve required headers and limit access to management endpoints where appropriate. Do not expose the editor merely because a webhook must be public. On cloud, use the URL provided by the service and follow its current webhook and network-access rules.

Choose the webhook response mode deliberately. Responding immediately can acknowledge receipt before slower downstream operations complete; this avoids sender timeouts but means the response does not prove the whole process succeeded. Responding after completion can return a result but may exceed upstream timeouts. The Respond to Webhook node can provide a controlled response when configured with the Webhook node. Return only data the caller needs and avoid echoing secrets or untrusted HTML. Validate request method, content type, schema, authentication or signature, and expected size before performing side effects.

Webhook authentication can be implemented using the node's supported authentication options or a signature-verification step. For signed events, validate the signature against the raw request body and a secret, check timestamp or nonce constraints if the provider specifies them, and use constant-time comparison where custom code is involved. IP allowlisting can add a layer but is not a replacement for cryptographic verification. Avoid putting long-lived bearer tokens in query strings, which are commonly recorded in proxy and access logs.

## Scheduling and polling

Schedule Trigger supports time-based starts, including intervals and calendar schedules. Confirm the workflow's timezone and the instance's timezone configuration; daylight-saving transitions and missed schedules can surprise jobs intended to run at a particular local hour. Schedule behavior also depends on activation. A workflow left inactive in the editor will not behave like a registered production schedule. Test the next execution time and ensure the workflow has enough time to finish before the next scheduled run.

Polling triggers query a service periodically and need a checkpoint strategy. Prefer provider cursors, monotonically increasing IDs or stable updated-at fields. If the workflow only asks for “the latest page,” it can miss changes during downtime or when more records arrive than one page can contain. Use pagination and overlap windows when timestamps can collide or clocks drift, then deduplicate records by a stable event or object ID. Respect API quotas and use bounded windows rather than repeatedly scanning an unbounded history.

## Idempotency and duplicate delivery

Idempotency means repeating the same logical request does not create an additional effect. Webhook providers commonly retry when they do not receive a timely successful response, so the receiver should expect duplicates. Store the provider's event ID or a deterministic business key in a durable system with a uniqueness constraint. On arrival, atomically claim that key before doing work, or use an API's idempotency-key feature. A check-then-write in two separate operations can race when concurrent deliveries arrive.

A deduplication record needs a retention window appropriate to the provider's retry horizon and business risk. If a workflow creates a record in one service and then fails before storing its event ID, the next delivery may create a duplicate. Choose an operation ordering and recovery strategy that closes this gap, such as saving an intent first, using a destination idempotency key, or reconciling by external reference. n8n's execution ID identifies a run, not necessarily the business event; retries often have different execution IDs for the same event.

For scheduled runs, use a lock or durable checkpoint when overlapping executions would conflict. A “run once” setting or workflow concurrency limit can reduce overlap, but it does not provide a distributed transaction across n8n and external systems. If jobs process a time window, record the committed cursor only after all intended records are handled. Reprocessing an overlap window is safer when downstream writes are idempotent than advancing a checkpoint before processing completes.

## Production checklist

1. Separate the public webhook route from editor and administrative access.
2. Validate authentication, schema, size and destination before side effects.
3. Acknowledge quickly only when durable processing or retries are understood.
4. Use stable event IDs, atomic deduplication and destination idempotency where possible.
5. Monitor webhook failures, schedule lag, repeated events and downstream rate limits.
6. Test timeout, duplicate, out-of-order and late-arriving event scenarios.

## Event ordering and acknowledgement

Delivery is not necessarily ordered. A provider can retry an older event after a newer one has arrived, or deliver the same event to parallel executions. If updates represent state snapshots, compare version numbers or timestamps and prevent an older snapshot from overwriting newer state. If events represent deltas, preserve sequence and detect gaps; retrieving the latest object may not reconstruct the missing history. Record the provider event ID, received time and processing outcome to support diagnosis.

Acknowledge timing is part of the integration contract. Some providers stop retrying after any 2xx response, while others inspect response bodies or have their own retry schedules. Return a failure when the request was rejected before durable acceptance; return success once the event has been safely accepted into a durable processing path. Do not claim success merely because n8n received bytes if the workflow may lose the event before completing required work. Read the provider's delivery semantics and simulate its retry behavior.

## Common mistakes

- Treating a successful HTTP response as proof that downstream writes completed.
- Using the test URL in an external production integration.
- Ignoring timezone, workflow activation and overlap behavior for scheduled work.
- Deduplicating with a transient in-memory value that disappears on restart.
- Advancing a polling cursor before all records in the page are safely processed.
- Trusting a secret URL or source IP as the only webhook security control.
