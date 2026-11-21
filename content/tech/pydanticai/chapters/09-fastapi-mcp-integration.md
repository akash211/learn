# Integration with FastAPI and MCP

PydanticAI can live behind a FastAPI endpoint, while MCP toolsets can connect an agent to tools served by MCP-compatible systems. These are complementary boundaries: FastAPI accepts and returns HTTP requests for your application; an agent coordinates model interactions; MCP defines a protocol for exposing tools to an MCP client. Combining them does not remove the need to manage resource lifetimes, authenticate callers or limit model authority.

## Place the agent behind an HTTP contract

Keep the endpoint focused on HTTP concerns: validate the request, authenticate the caller, build scoped dependencies, invoke the agent and map its result or errors to a stable response. Keep provider details and tool orchestration in an application service so they can be tested without the web framework. Use FastAPI lifespan to create shared clients and connection pools, then close them when the app shuts down. Request-specific principal and tenant information belong in request dependencies and should be passed into each agent run.

```python
from fastapi import FastAPI, Depends
from pydantic import BaseModel

class AskRequest(BaseModel):
    question: str

class AskResponse(BaseModel):
    answer: str

@app.post('/ask', response_model=AskResponse)
async def ask(body: AskRequest, principal=Depends(current_principal)):
    deps = build_agent_deps(principal)
    result = await answer_agent.run(body.question, deps=deps)
    return AskResponse(answer=result.output.text)
```

This is a shape, not a complete authentication or error policy. Do not return the entire agent result object by accident. Map provider outages, validation exhaustion, refusals and timeouts deliberately; avoid exposing stack traces or raw provider errors. Set request and provider timeouts and apply concurrency controls. A synchronous endpoint or `run_sync` is generally the wrong choice inside an async request handler.

## Resource ownership and async work

The endpoint request may own a database transaction or client dependency. A long LLM run can hold that resource while waiting on the provider, which increases pool pressure. Often it is better to fetch only the required data, close the transaction, then run the model with a small immutable context. Background job requirements such as durable retries and queueing belong in a job system, not an in-process request task by assumption.

Streaming agents through `StreamingResponse` or SSE requires explicit disconnect and cancellation handling, proxy configuration, and a policy for failures after response headers are sent. Validate and authorize before opening the stream. Avoid keeping a request-scoped DB session alive for a slow client. Test through the actual ASGI app and, for operational guarantees, through the production proxy path.

## MCP as an external toolset boundary

PydanticAI's MCP client support includes `MCPToolset` in documented configurations. The toolset can be registered with an agent and can connect through supported transports such as local stdio or remote HTTP transport. Dependency extras and transport APIs may change; consult the current MCP client guide for installation and lifecycle specifics. Use the documented context manager or lifecycle mechanism to start and close connections predictably.

An MCP server's tool descriptions and schemas are inputs from another system. Review and allowlist servers, tools and permissions; authenticate remote transport appropriately; validate outputs and enforce application policy before using returned data. A shared connection may represent one identity, which is not a substitute for per-user authorization. Avoid automatically exposing every connected tool to every workflow. Remote tools can fail, time out, return untrusted content or perform side effects.

## Security and observability

Treat both client prompts and tool results as untrusted. Enforce authorization in deterministic code, limit tool scope and redact data sent to external providers. Add request identifiers across HTTP and agent runs, plus metrics for model latency, tool latency, validation retries, failures and usage. Avoid logging credentials, full chat history or personal data by default. Apply rate limits and budget controls at the API boundary, since model requests can be expensive and a loop can call several tools.

## Common mistakes

- Blocking the event loop by invoking synchronous model or SDK code from `async def`.
- Returning run internals instead of a stable response DTO.
- Holding DB transactions open across model waits or slow streams.
- Treating an MCP tool's schema or description as proof it is safe.
- Assuming a shared MCP connection has per-user identity and isolation.

## Production notes

Keep the HTTP, agent and MCP layers independently testable. Use ASGI integration tests with model overrides and fake toolsets, then separate deployment tests for provider connectivity and proxies. Document which component owns each client and how it is closed. Pin compatible package versions, especially where optional MCP dependencies are involved. The composition works best when every boundary has a typed contract and an explicit authority model.

## An HTTP endpoint has two contracts

The endpoint request/response schema and the agent's internal dependency/output types are related but need not be identical. A caller may submit a short question, while the agent receives a bundle containing a scoped service and returns an internal model with provenance and review state. FastAPI then maps that result to a safe public DTO. This separation prevents framework metadata, private fields and internal provider failures from leaking onto the wire.

Error mapping should preserve meaning without exposing internals. A provider outage may be a retryable service error; invalid client input belongs to request validation; an agent output rejected by domain policy may require review rather than a generic 500. Do not return raw exception text to the caller. Include request correlation in logs so operators can connect the HTTP response to run telemetry without storing all prompt content. Set a deadline that covers the full request and coordinate it with provider and tool timeouts.

## MCP lifecycle and least authority

An MCP toolset introduces a remote or subprocess connection that must be opened and closed predictably. A lifecycle context can make ownership explicit and avoid starting a process unexpectedly for every call. Confirm which transport and optional dependencies are supported by your pinned release. Handle server disconnection and tool errors as ordinary dependency failures. Stdio subprocesses, remote HTTP servers and in-process servers have different security and operational profiles.

Review each server and tool's effective privilege. A shared connection may act as a single identity, so do not imply that requests automatically inherit the authenticated web user's permissions. If user-specific auth is required, design that propagation explicitly. Validate and bound tool outputs, since remote data may contain prompt injection or sensitive fields. MCP standardizes communication, not trust or authorization.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Integration with FastAPI and MCP. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
