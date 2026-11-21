# Tool Registration, Type Hints, and Call Validation

A function tool gives a model a narrowly defined way to ask the application for information or request an operation. The model does not execute Python. PydanticAI receives a proposed tool call, validates its name and arguments against the registered tool schema, invokes application code, and supplies the return value to the next model step. This is a control-flow loop: model, tool, model, possibly repeated until a final result or a limit is reached.

## Register by intent

The `@agent.tool` decorator registers a function that receives `RunContext[DepsT]` as its first argument. Use it when the operation needs the current run's dependencies. `@agent.tool_plain` registers a function without run context. The context parameter is part of Python's signature but is not ordinarily a model-supplied argument; the framework injects it. Tools can also be supplied through constructor arguments or composed through toolsets for reuse and integrations.

```python
from pydantic_ai import Agent, RunContext

agent = Agent('provider:model', deps_type=SearchService,
              instructions='Search before answering questions about current records.')

@agent.tool
async def lookup(ctx: RunContext[SearchService], query: str, limit: int = 5) -> list[str]:
    """Search the current tenant's permitted records."""
    return await ctx.deps.search(query, limit=limit)
```

Python type hints describe the input and return contract; the docstring helps describe purpose to the model. Argument schemas are generated from signatures and validated before the tool runs. Default values and descriptions can guide the model, but descriptions are not security policies. Restrict values with suitable types and Pydantic constraints when useful, then enforce business rules in the function.

## Validation is not authorization

Validation can reject a malformed date, a missing string or an out-of-range numeric limit before it reaches the function. It cannot determine whether a user may search a particular tenant unless that trusted identity is carried in context and checked by the tool. Do not accept user ID or permission claims from model-generated arguments when they can be derived from authenticated context. For sensitive actions, check ownership and scopes in application code, validate state transitions, and require explicit user confirmation when appropriate.

Tool code should be ordinary robust Python: finite timeouts, careful exception mapping, query parameterization, bounded result sizes and auditable side effects. A tool's return content is sent back into the model context, so return only relevant, authorized, redacted information. It can influence subsequent model behavior; never treat returned text as trusted instructions or pass it into an unsafe interpreter.

## Design small, composable tools

A tool should have a clear name and one coherent responsibility. Several narrowly scoped search/read tools may be easier for a model to use safely than one powerful function with many modes. Conversely, excessively tiny tools create extra model round-trips and confusing choices. Design around the decisions the model needs to make. Use enums or literal values for finite choices, clear descriptions, and explicit pagination or result caps.

For deterministic transformations, normal Python is often preferable to another LLM round-trip. The tool can compute totals, parse a trusted format, or call a domain service, leaving the model to handle language-level interpretation. Keep side effects idempotent where possible, and use an application-level idempotency key for operations that may be retried.

## Errors and retries

A tool can return a useful error result, raise an exception, or use PydanticAI's `ModelRetry` to indicate that the model should try again with corrected input. These choices mean different things. A recoverable argument issue may be worth explaining to the model; an outage should generally be surfaced or mapped through a bounded policy rather than prompting the model to retry indefinitely. Unhandled exceptions may become agent failures and should be logged safely at the application boundary. Set limits and ensure that retried side effects cannot run twice accidentally.

## Common mistakes

- Thinking a model call directly executes a Python function outside the agent's validated loop.
- Treating the tool description as an authorization check.
- Returning secrets, oversized records, or untrusted instructions to the model.
- Giving a generic `dict[str, object]` schema where precise parameters would be clearer.
- Retrying a side effect without idempotency or a bounded attempt count.

## Production notes

Review the registered tools as an API and security surface. A model should see only functions the current workflow needs. Test accepted and rejected argument payloads, dependency scoping, timeouts, exceptions, cancellation and duplicate requests. Log the tool name, duration and outcome with correlation identifiers; avoid logging credentials, raw prompts or sensitive tool results unless a documented policy allows it. Provider capabilities differ, so schema support and parallel-call behavior must be verified for the chosen model. Tool calling is a model interaction pattern, not a transaction manager.

## Worked example: a read tool and a write tool

A read tool might accept a search phrase and a bounded result limit, derive the tenant from `ctx.deps`, query a service, and return a short list of records. A write tool has a higher authority level. It should verify current application state, confirm that the principal may change that record, validate the transition, and use an idempotency key if requests can repeat. The model's choice to call the tool is not consent and the schema cannot authorize it. For sensitive changes, require an explicit user action or approval before executing.

Signatures should describe the smallest useful interface. Use domain types for dates or finite action choices, meaningful parameter names and docstrings that distinguish similar tools. A descriptive tool helps the model choose correctly, but keep descriptions honest and concise. Avoid exposing internal administrative methods just because they are convenient to register. Toolsets can be composed, but each composition expands the agent's effective capability surface and should be reviewed.

## Test the call boundary, not just the answer

With a scripted model response, test a valid tool call, a malformed argument, a denied resource, and a downstream service timeout. Assert which dependency methods ran and what exact side effects were avoided. Ensure model retries on validation errors do not duplicate completed writes. A tool that returns a long record should be tested for truncation or field minimization, because returned content affects both privacy and subsequent model behavior.

Tool code is ordinary application code and deserves normal review, code ownership and logging. Add network timeouts, parameterized database operations, bounded pagination and safe exception handling. The LLM is an untrusted caller at the boundary even when it is running inside your service. Treat every tool invocation like an API request that must be parsed, authorized and observable.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Tool Registration, Type Hints, and Call Validation. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
