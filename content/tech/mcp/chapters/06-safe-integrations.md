# Safely Exposing Databases and Internal APIs

An MCP server can make internal data easier to reach—and easier to misuse. A language model may produce unexpected arguments, an integration can be misconfigured, and a host may execute a call automatically. The safest design begins with a narrow capability backed by a deliberately constrained identity, then adds limits and observability around every request.

## Prefer a purpose-built access layer

Do not expose a database connection or internal API as a generic “query anything” tool unless the capability is explicitly designed, sandboxed, and reviewed for that purpose. A raw SQL tool turns model output into a language with substantial expressive power. Even if the model usually writes safe SELECT statements, it may issue expensive joins, access restricted columns, or produce malformed SQL. A generic HTTP fetch tool can become a network proxy or reach internal metadata endpoints.

Instead expose task-oriented operations: `get_order_status(order_id)`, `list_recent_deployments(service, limit)`, or `search_docs(query, page_size)`. Keep operations narrow enough that permission, expected cost, result size, and side effects are understandable. Reuse the business service or internal API that already enforces domain rules, rather than reimplementing those rules in an MCP handler. If a low-level query capability is a genuine requirement, provide a constrained query language or read-only database role with explicit table, column, row, and cost boundaries.

## Read-only is a layered property

A tool description that says “read-only” does not make it so. Enforce read-only behavior with multiple independent controls: a database account that cannot modify data, a transaction mode or connection policy that disallows writes, a service endpoint that only permits reads, and input validation that rejects unsupported operations. Avoid reusing credentials that are also used by migrations or administration.

For SQL-backed integrations, prefer parameterized statements and allowlisted identifiers. SQL parameters generally bind values, not table or column names, so dynamic identifiers need strict allowlists. Add tenant predicates and authorization filters within the query or policy layer to avoid retrieving rows the caller cannot see. Put maximum row counts, statement timeouts, and connection pool limits in place. Check that read operations do not trigger expensive stored procedures or side effects in the database.

For internal APIs, use a limited service identity and an explicit allowlist of hosts, routes, methods, and content types. Validate redirects and DNS/network behavior if URLs are involved. A model-supplied URL must not let the server reach arbitrary internal addresses. Do not forward inbound authorization headers to a different origin. Apply response size limits and parse data as data, not instructions.

## Bound cost and output

Every operation needs finite resource limits. Use pagination with a bounded maximum page size, enforce timeouts at both the MCP boundary and downstream client, and cap concurrent requests per caller or tool. Rate limits should account for cost, not just raw request count: a broad search and a point lookup may consume different resources. If the backend supports quotas, pass a verified identity so usage can be attributed accurately.

Return only fields needed for the task. Filter personally identifiable information, credentials, internal notes, and large blobs unless they are essential and authorized. Truncate or paginate large results; summarize carefully only when the server's role and data contract allow it. A small response reduces prompt cost, leakage, and the chance that untrusted embedded content influences the model. Include provenance such as a source identifier or timestamp when a host needs to communicate freshness, but do not fabricate certainty.

Retries require care. A timed-out read can often be retried safely, but a write may have succeeded even if the client never received the response. For side-effecting calls, design idempotency keys or an explicit operation status and document retry behavior. Rate limits and idempotency are server-side responsibilities; a host's behavior varies.

## Audit with useful context

An audit record should link the authenticated principal, tool name, relevant resource or tenant, policy decision, timestamp, correlation ID, and outcome. For writes, record the intended and resulting change in a privacy-conscious way. Avoid storing full prompts, raw result payloads, or access tokens unless there is a documented need and appropriate protection. Security logs require retention limits and access controls; a log that contains secrets is another secret store.

Distinguish operational logs from an audit trail. Logs help diagnose errors and performance. An audit trail needs integrity, attribution, and a defined retention policy. Structured events make it possible to alert on unusual volume, repeated denial, or attempted cross-tenant access. Do not assume that the MCP protocol itself provides a complete audit record; host-side and server-side events may need correlation.

## Database example: bounded reporting

Suppose an assistant needs recent incident summaries. A safer tool accepts a service identifier and a small bounded time window, validates that the caller can access the service, queries a read replica with a read-only principal, caps results to a fixed maximum, and returns only title, severity, time, and a link. The tool does not accept arbitrary table names or SQL. A query timeout and concurrency limit protect the database. The server records principal, service, result count, and latency without logging descriptions that might contain sensitive data.

If a user needs more detail, expose an authorized detail operation that checks the incident itself, rather than returning every database field in a large search response. That stepwise boundary gives the host an opportunity to ask for permission or clarification before revealing sensitive context.

## Common mistakes

- Assuming read-only intent is enforced by documentation or model behavior.
- Using a superuser database account because it is easiest to configure.
- Allowing unbounded `limit`, time ranges, result size, concurrency, or SQL complexity.
- Trusting a caller-provided tenant ID without checking the authenticated principal.
- Returning raw API responses that contain secrets or unneeded personal data.
- Auditing only at the host and leaving direct server calls unattributed.

## Production notes

Threat-model each tool as a public API endpoint even when it is internal. Start with the smallest data and action surface, and prove the backend identity cannot exceed that surface. Test abusive but schema-valid inputs, wrong-tenant identifiers, extremely wide ranges, timeouts, backend outages, and retry behavior. Measure query plans and downstream call volume under realistic concurrency. For any write, document approval, idempotency, rollback or compensation, and audit retention. The server should remain safe when a model chooses a poor operation, a host is permissive, or the caller retries.

## Capacity and data classification

Capacity controls should be tested at the service boundary, not inferred from database settings. A per-process connection pool multiplies across workers and replicas, while rate limits may need a shared store to apply consistently. Classify every returned field and define whether it may be retained by a host or model provider. If sensitive data is necessary, document the purpose, retention, and user-facing notice. Review cached outputs for tenant isolation and freshness.
