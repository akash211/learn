# Tool Descriptions, Validation, and Error Envelopes

A tool schema has two audiences. The MCP client needs a machine-readable contract to validate and route a call. The model and human need a description that explains when the operation applies and what it does. Strong tools are predictable because both contract and prose make the same behavior clear. A schema is not merely documentation: it becomes part of the model-facing context and can affect which actions are proposed.

## Describe the actual operation

Use a stable, descriptive name that conveys the action and object, such as `search_open_tickets` or `create_calendar_draft`. Avoid vague names like `run`, `fetch`, or `process`. A description should explain:

- The task and conditions for using the tool.
- What the operation reads or changes, including whether it has side effects.
- Important constraints: required identifiers, date ranges, limits, supported filters, and whether values are exact or fuzzy.
- What the result contains and how missing or ambiguous data is represented.
- Any confirmation or approval expectation that the host should apply.

Give input fields clear names and concise descriptions. Make requiredness explicit, bound strings and numbers where supported, and choose enums when the valid set is known. Use a small object rather than positional or overloaded fields. Avoid optional parameters with unclear defaults: “limit omitted” should have a defined behavior and safe maximum. Keep output shape concise and stable. If a tool returns untrusted user-generated text, preserve that distinction rather than embedding it as instructions.

Descriptions must be truthful and should be reviewed like code. Saying “read-only” is not enforcement. Saying “safe” is not a control. Host behavior around descriptions, tool annotations, and approvals is not uniform, and tool metadata can come from a server that is not trusted. Server-side validation and authorization remain mandatory.

## Structured input and output

SDKs such as the Python SDK can generate input schema from type hints, docstrings, or validation models. Inspect the actual generated schema in tests. Check required properties, defaults, nullability, formats, bounds, enums, nested structures, and descriptions. JSON Schema support and SDK conversion behavior can vary by SDK release and protocol version. Test with the least capable target client as well as the preferred one.

Validation has layers. Protocol/SDK validation checks that the request is shaped correctly. Domain validation checks that the values are meaningful. Authorization checks that this principal may access the requested target. Database or service constraints protect persistence. Do not conflate one layer with another. A JSON Schema can reject a negative page size, but only an authorization check can determine whether the principal may view a record.

For outputs, structured content can be easier for hosts and downstream model calls to consume than ad hoc prose. Keep it stable and avoid returning excessive records. In some versions, structured tool output schemas are supported; others may not understand them. Where relevant, provide both a human-readable text representation and machine-validated structure according to the supported SDK. Never assume a return annotation automatically guarantees safe serialization or full output validation without testing.

## Errors are part of the contract

Distinguish protocol-level failures from a tool that ran and encountered an expected domain outcome. A malformed JSON-RPC message, unknown method, or invalid protocol parameters may be represented as a JSON-RPC error. A tool call may instead return a tool-result envelope indicating an execution error or a normal result with a domain-level “not found,” depending on the protocol and SDK design. The exact error flag, result content, and code conventions are version-dependent; follow the spec and SDK rather than inventing a universal envelope.

Design error behavior so clients can recover. A “not found” result should not look like an empty successful record if the distinction matters. A validation error should identify the bad field without echoing secrets. A permission error should not reveal restricted data. A transient dependency failure may be retryable, but only if the operation's side effects and idempotency allow it. Include a stable error category or machine-readable code where supported, alongside safe human-readable text.

Do not return stack traces, SQL statements, internal hostnames, secrets, or raw provider errors to the client. Log the detailed exception in a protected system and include a correlation ID that can help operators locate it. Client-facing messages should be actionable but minimal. Avoid converting every exception to a successful text result; doing so can trick the host or model into treating failure as data.

## Designing a good failure path

For an expected business outcome, such as an unavailable record, return a shape that is explicit and documented. For a system failure, map the underlying exception at the boundary, preserve enough internal diagnostics, and avoid retrying blindly. A database timeout may need a user-facing “temporarily unavailable” response; a validation error should not trigger a retry with the same input. If the SDK exposes cancellation, progress, or task handles, handle them according to its supported version and make partial completion clear.

Use idempotency for operations that may be retried after a network interruption. If an action was accepted but will finish asynchronously, return a clearly defined job or operation identifier and expose a status capability if needed. The host may retry a request if a response stream fails, and transport-level retries cannot prove that a server-side effect did not occur. This is why writes need explicit retry semantics.

## Example description pattern

A useful description might say: “Searches incidents visible to the authenticated user for one service. Use when asked for recent incidents, not for arbitrary log retrieval. `service` must be an authorized service slug. `since_hours` is 1–168 and defaults to 24; results are capped at 20. Returns incident ID, title, severity, and update time; descriptions may contain user-provided text. This tool is read-only.” The implementation must still apply authorization, limits, projection, and read-only credentials.

## Common mistakes

- Reusing a short name like `search` for several different meanings.
- Writing marketing-style descriptions with no constraints or side-effect details.
- Relying on an input schema to enforce tenant or object permissions.
- Returning a stack trace or treating an error as normal prose with no indication of failure.
- Assuming all MCP clients interpret structured output or error flags identically.
- Designing a write tool without idempotency or retry guidance.

## Production notes

Treat tool schemas and descriptions as versioned public interfaces. Review changes to names, descriptions, defaults, and return fields because they may alter model behavior even when the wire shape remains valid. Add schema snapshot tests and representative model-facing evaluations, but do not use evaluation success as a security test. Record error categories and downstream correlation IDs without leaking sensitive input. A good contract makes correct use likely and mistakes diagnosable; a secure implementation still rejects unauthorized or invalid operations regardless of what the description says.