# Agent, Dependencies, and Result Types

`Agent` is PydanticAI's primary interface for defining an LLM workflow. An agent brings together a default model, instructions, tools or toolsets, a dependency type and an output type. It is configuration and reusable behavior; it is not a live conversation by itself. A run passes a prompt and runtime values to that definition, calls the model as needed, executes permitted tools and returns a result wrapper.

## Make the types explicit

`Agent[DepsT, OutputT]` is generic in its dependency and output types. The constructor's `deps_type` and `output_type` describe those roles. For a simple agent, defaults may infer text output and no meaningful dependency object; production code benefits from spelling out types when it clarifies the contract.

```python
from dataclasses import dataclass
from pydantic import BaseModel
from pydantic_ai import Agent

@dataclass
class SearchDeps:
    search_client: object
    tenant_id: str

class Answer(BaseModel):
    text: str
    sources: list[str]

agent = Agent('provider:model', deps_type=SearchDeps,
              output_type=Answer,
              instructions='Answer using the available search evidence.')
```

The type argument is the class/type, not an instance. The actual runtime dependency is supplied to `run` via `deps=...`. The type parameter mainly gives static type checking the intended shape. It does not instantiate, validate, or manage the lifetime of arbitrary dependency objects for you.

## Running and reading the result

`await agent.run(prompt, deps=deps)` is the usual async path. It returns an `AgentRunResult`-style wrapper; the typed final value lives in `.output`, while usage, messages and other run information are accessible on the result. `run_sync` is available in synchronous programs, but should not be called from an already-running event loop; async web handlers should await `run`. Streaming has separate APIs and lifecycle, covered later.

Do not confuse the result wrapper with the output payload. Returning `result` from an endpoint or serializing its internals may expose run metadata or produce an unintended wire format. Extract `result.output`, then map it into the public API's response model. Keep conversation history explicit: when continuing a conversation, pass the appropriate prior messages using the documented history argument rather than assuming the agent object remembers users' prior turns.

An agent can have a configured default model and a run can select or override a model depending on the API version and intended use. Prefer constructing well-defined agent configurations rather than mutating shared defaults per request. An agent definition can be reused concurrently, but dependencies, mutable history and clients still require appropriate per-run or shared-safe lifetimes.

## Dependency and output types are different

Dependencies are trusted application-provided capabilities and context: a database/service object, authenticated tenant information, a clock, or an HTTP client. They are not the user's prompt and are generally not serialized as tool arguments. The model cannot inspect a dependency unless application code exposes information through instructions or tool results. Output types define what the run must return to calling code. Keeping these separate avoids passing credentials in prompts or confusing model-controlled data with application authority.

A small dataclass often makes dependencies readable and typeable. Prefer passing a narrow service interface rather than a broad container full of unrelated secrets and operations. A dependency should have an owner responsible for opening and closing its resources. PydanticAI passes it through run context; the application composes it.

## Agent configuration and lifetime

Construct agents at module or application setup time when their configuration is stable, not on every request without reason. Provider clients may be created lazily or through provider-specific configuration; follow that provider's lifecycle guidance. Use FastAPI lifespan to manage shared clients and supply them as dependencies. Pass request-specific authorization or tenant scope on each run rather than storing mutable user state on a global agent.

Instructions may be static strings or dynamic functions, and the framework exposes the run context to dynamic functions. Treat instructions as model guidance, not an enforcement mechanism. A system prompt that says “only access this tenant” does not enforce tenant isolation; tools must receive and enforce the tenant context.

## Common mistakes

- Passing a dependency instance as `deps_type` rather than declaring its type.
- Assuming `Agent` owns or closes database sessions, HTTP clients, or credentials.
- Reading `.output` when the run actually yields an alternate union result without handling its type.
- Calling `run_sync` inside async code or a running event loop.
- Storing per-user conversation state in a shared global agent.

## Production notes

Use static type checking to catch mismatched `RunContext[Deps]` annotations and calls that omit required dependencies. Add explicit limits for requests, tool calls and elapsed time using supported run settings; check the version-specific API names before adopting a snippet. Keep prompts and chat history bounded. Design the agent contract so the caller can distinguish successful business output from refusal, validation exhaustion, provider failure and cancellation. That is the foundation for a stable service API.

## Worked example: follow the values through a run

Suppose a product agent accepts a user question and returns a typed `ProductAnswer`. The application calls `await agent.run(question, deps=deps)`. If the model proposes a `lookup_product` tool call, PydanticAI validates the argument payload, constructs `RunContext[CatalogDeps]`, and calls the function. The tool uses the catalog service in `ctx.deps`, returns a bounded result, and that result becomes input to the next model response. Once the final output is accepted, the caller reads `result.output` and maps it to the web response. Each stage has a distinct value type and failure mode.

This sequence is why the result wrapper and the typed output should not be conflated. Run metadata is useful for telemetry or debugging, but it is not the business response. Similarly, conversation history is explicit data, not hidden state magically retained by one global agent. If the app supports multi-turn interactions, store and pass the intended history using the current API, with ownership and retention policies.

## Reason about concurrency and reuse

Agent definitions are typically configured once and reused; request-specific values belong in per-run arguments and dependencies. This avoids a common race where one request changes the selected model or dependency object while another request is executing. Shared clients can be efficient, but their concurrency and shutdown behavior comes from the client library. A database session or mutable in-memory conversation object may not be safe to share. Keep framework configuration immutable and resource lifetime with the application container.

When wrapping agent execution in a service function, give that service a typed signature and map expected failures to domain-specific outcomes. This reduces leakage of provider exceptions into every HTTP route. Static checks can then verify dependencies are supplied and consumers handle declared output types. A good boundary remains legible even if a provider integration or API version changes.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Agent, Dependencies, and Result Types. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
