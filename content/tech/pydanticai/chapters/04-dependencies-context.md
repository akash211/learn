# Dependencies and Runtime Context Injection

Dependencies keep application-owned services and state out of model-controlled arguments. PydanticAI lets you declare a dependency type on an `Agent` and then pass a corresponding instance for each run. Tools, dynamic instructions and output validators can access the instance through `RunContext[DepsT]`. This is a lightweight typed injection mechanism; it does not replace resource management in the web framework or application.

## Bundle capabilities, not ambient globals

For one simple value, a dependency can be a string or object. For a real application, a dataclass provides an explicit bundle with a small interface. It might contain a scoped repository, an async HTTP client and a request's authenticated tenant. Use protocols or concrete service types so tools depend on operations they actually need. Avoid a grab-bag of configuration and privileged clients that gives every tool unnecessary authority.

```python
from dataclasses import dataclass
from pydantic_ai import Agent, RunContext

@dataclass
class ResearchDeps:
    search: SearchService
    tenant_id: str

agent = Agent('provider:model', deps_type=ResearchDeps)

@agent.tool
async def search_records(ctx: RunContext[ResearchDeps], query: str) -> list[str]:
    return await ctx.deps.search.for_tenant(ctx.deps.tenant_id, query)
```

The model supplies `query`; the application supplies `tenant_id` and the service. This separation is a security property only if the service enforces the scope and the dependency originates from trusted authentication. A type annotation does not prove a particular runtime object is safe, and a tool should still validate business authorization.

## Runtime context has a lifecycle

A dependency object may wrap a connection or other resource. The application must create it at the right scope and close it at the right time. In FastAPI, application lifespan is appropriate for a shared connection pool or HTTP client; request-scoped dependencies can construct tenant/user-bound services or database sessions. The endpoint passes the right object to `agent.run`. Do not share a mutable session across concurrent independent tasks unless its client library explicitly supports that use.

An agent can be reused, but its definition should not contain mutable request-specific state. Pass dependencies on every run. This makes concurrency and tests easier to reason about and prevents one request's tenant context or credentials leaking into another. When an operation fans out concurrently, create safe per-task resources or serialize use according to the underlying client's contract.

## Context can shape instructions too

`@agent.instructions` can define a function that receives `RunContext` and returns instructions for that run. This is useful for non-secret, relevant runtime context such as a user's locale or current task. Keep the injected text concise and avoid placing credentials or large private records into prompts. For user-specific authorization, the prompt is advisory; the tool must enforce access using the trusted dependency itself.

The context can also expose run-level information such as usage or the agent, depending on the current API. Prefer the documented, typed properties rather than global state. When relying on advanced context features, verify them against the version installed by the application because PydanticAI evolves quickly.

## Testing injection

Dependency injection helps tests replace real services with fakes. A fake repository can record calls and return deterministic results; the model itself can be replaced independently with `TestModel` or `FunctionModel`. Tests should assert that the correct tenant-scoped method ran and that out-of-scope requests are rejected. Avoid building tests that only assert a prompt mentions permissions: the important fact is that application code enforces them.

A dependency's defaults should be intentional. If a dependency is required, do not silently create a production-like privileged fallback when omitted. Fail early with a clear exception. Separate secrets configuration from request context, and use a secret manager or environment configuration for credentials, granting the agent only a service interface that does not expose raw keys unnecessarily.

## Common mistakes

- Putting per-request values on a module-global agent.
- Treating dependency annotations as runtime schema validation for arbitrary objects.
- Passing a credential in a prompt or model-controlled tool argument.
- Sharing an unsafe session object across parallel agent runs.
- Confusing dynamic instructions with authorization enforcement.

## Production notes

Map the dependency graph explicitly: who creates each resource, who closes it, whether it is safe to share, and which tenant or principal it represents. Add concurrency tests for shared clients and isolation tests for user-specific context. Use least-privilege services, short lifetimes for sensitive state, and observability that identifies dependency failures without exposing their contents. Context injection is most useful when it makes authority and ownership visible rather than hiding them.

## Worked pattern: FastAPI owns HTTP scope

A FastAPI dependency can resolve the authenticated principal and a repository or client. The endpoint then constructs an agent dependency bundle and calls the agent. This preserves the distinction between web authentication and agent runtime context: FastAPI binds request data and principal; `RunContext` exposes the run's supplied services to tools. Map the final typed result to an HTTP response schema rather than returning provider or run internals. If the endpoint is called concurrently, each run should receive the correct scope without mutating a shared agent.

For resources with different lifetimes, use application lifespan for shared pools and request-level providers for per-user context. If the agent's model call may take seconds, do not keep a transaction open merely because a request dependency yielded a session. Read the minimal authorized context, release the transaction when safe, and reacquire/recheck before committing a later action. This reduces pool pressure and avoids stale assumptions. The right sequence depends on consistency requirements; document them.

## Make context observable and least-privileged

A dependency bundle should answer three questions: what capabilities can the agent's tools use, which principal or tenant does the data belong to, and who closes each resource? Prefer a narrow service object over a broad application container. Never put secrets into generated instructions simply because context is convenient. If an instruction must vary by locale or task, provide the non-secret value and still enforce restrictions in the service. Add tests that prove two concurrent users cannot observe each other's scoped data.

When run context includes usage or metadata, use the documented API and avoid assuming fields remain stable across versions. Keep context objects simple enough to instantiate as fakes. This makes the boundary testable and keeps orchestration code independent from web framework internals.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Dependencies and Runtime Context Injection. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
