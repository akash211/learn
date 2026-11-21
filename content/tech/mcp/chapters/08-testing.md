# Testing an MCP Server

An MCP server needs more than unit tests for its business functions. Tests should cover the protocol boundary that clients see, authorization and data behavior, transport lifecycle, and the host or model loop that chooses and consumes capabilities. A good test strategy starts cheap and deterministic, then adds integration and agent-in-the-loop tests to expose mismatches that a handler test cannot find.

## Unit-test domain logic first

Keep domain behavior outside the MCP registration layer so it can be tested directly. Test filtering, validation, permission decisions, transformations, and side-effect rules with ordinary Python tests. Mock external APIs or use a local test database where appropriate, but do not mock the code whose authorization behavior you intend to verify. Test wrong-tenant access, missing records, invalid ranges, maximum result limits, and write idempotency.

Test schema and handler-specific logic separately. Verify that invalid inputs are rejected, valid inputs reach the expected service method, and failures become the intended client-visible outcome. A typed function signature may generate a schema, but the domain layer should still reject values outside business rules. Test exceptions at the boundary, including cancellation and timeout behavior if supported by the selected SDK.

## Protocol-level tests

Use the official SDK's in-memory transport, client helpers, or test harness where available. Start a client against the server and exercise discovery or the appropriate lifecycle for the pinned specification. List tools, resources, prompts, and templates; inspect their names, descriptions, and schemas. Call tools with valid, invalid, missing, extra, and boundary arguments. Read a resource and request a prompt. Confirm response shapes, content types, and errors match what an actual client receives.

Contract tests should catch accidental breaking changes. Snapshot schemas or assert key properties rather than comparing volatile generated ordering or SDK-specific metadata. Assert that the required properties and safety bounds exist, that output fields do not include internal secrets, and that sensitive resources are omitted or denied for the wrong principal. When a tool or description changes, review the client-facing behavior rather than only checking Python imports.

A test against a private handler method is not enough: it bypasses request parsing, serialization, protocol dispatch, and transport. A full protocol client test verifies these behaviors while remaining fast and deterministic. For compatibility, maintain a small matrix with representative target clients and versions. A client might ignore optional fields, handle errors differently, or not support a primitive the server exposes.

## Transport and deployment tests

Run separate tests for stdio and remote HTTP when both are supported. For stdio, launch the actual process, send protocol requests through stdin/stdout, and verify that stdout contains only protocol messages. Check startup failure, stderr diagnostics, signal handling, and graceful shutdown. Do not simply call `main()` in the same process if the real deployment uses a child process.

For HTTP, exercise the production-equivalent transport route through the app or gateway. Verify TLS termination assumptions, authentication and authorization headers, streaming responses, request-size limits, proxy timeouts, and network disconnect behavior. If OAuth or discovery is used, test expired and wrong-audience tokens, issuer mismatch, missing scope, and revoked access. Ensure reverse proxies do not buffer or break streaming. Keep such tests in a controlled environment and avoid sending production credentials in CI.

Test dependency failures intentionally: downstream timeout, throttling, malformed response, connection reset, and service unavailability. Verify that the server returns a safe error, releases sessions, and does not leak sensitive diagnostics. Measure concurrency boundaries and confirm a slow backend does not exhaust the entire process. If the protocol revision includes progress, cancellation, subscriptions, or task features, test them only where the implementation and target clients support them.

## Agent-in-the-loop testing

A protocol-correct tool can still be confusing or unsafe for a model. Agent-in-the-loop evaluations check whether the host and model can understand tool descriptions, select the appropriate capability, construct valid arguments, interpret results, and ask for clarification when needed. Include scenarios for ambiguous requests, missing identifiers, invalid values, sensitive operations, and tool errors. Confirm that approval is requested for actions that should not be automatic and that model output does not bypass server-side checks.

These evaluations should use synthetic or redacted data and stable test accounts. Record the model, prompt, host, server schema, and SDK versions because model behavior and host tool presentation change over time. Score both task success and safety properties: correct tool choice, no call when authorization is absent, bounded arguments, and truthful explanation of failures. A “pass” on one model does not prove security. The enforcement remains deterministic server code and authenticated policy.

Do not let an evaluation agent execute arbitrary production write tools. Provide a sandbox, fake service, or disposable tenant. Keep evaluation prompts and transcripts free of secrets. Make reproducible seeds or fixtures where possible, but expect some outputs to vary and assert observable behavior rather than exact prose.

## Test a read-only reporting tool

For a reporting server, test that the database principal cannot write; a valid user sees only their permitted rows; a different tenant's record is denied; a huge requested limit is capped or rejected; and the result excludes internal columns. Simulate a database timeout and verify safe failure, audit correlation, and resource cleanup. Then run the server through a real MCP client and verify the advertised schema represents the same bounds. Finally ask a test agent for an unauthorized record and confirm the server rejects it even if the agent produces syntactically valid arguments.

## Common mistakes

- Testing only Python functions and never sending a protocol request.
- Using mocks that bypass the authorization or tenant-filtering logic.
- Treating schema generation as proof that runtime business validation works.
- Testing remote auth only with a valid token and never checking audience or scope failures.
- Treating model evaluation as a security boundary or allowing it to reach production writes.
- Ignoring stdout contamination, disconnect cleanup, or proxy streaming in deployment tests.

## Production notes

Make schema, authorization, and transport tests required CI gates. Run dependency and SDK upgrades against a compatibility matrix before release. Keep test fixtures representative but non-sensitive, and include fault injection for expensive operations and upstream outages. Publish a test report that records tested spec and SDK versions so “MCP compatible” has a concrete meaning. Unit tests establish local correctness; protocol tests establish the wire contract; deployment tests establish the transport path; agent tests establish usability under model behavior. No single tier replaces the others.

## Maintainable regression coverage

Keep representative protocol fixtures with the server release so schema changes can be reviewed in context. Avoid brittle assertions on JSON key ordering or generated descriptions that are not contractually stable. At the same time, assert important invariants precisely: denied principals receive no protected content, result counts stay within limits, and expected fields remain present. Run the slower host compatibility and agent evaluations on release candidates, while keeping core deterministic boundary tests fast enough for every commit.
