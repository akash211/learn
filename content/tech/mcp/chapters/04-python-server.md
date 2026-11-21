# Building a Python Server with FastMCP

A Python SDK handles MCP message schemas, dispatch, and transport mechanics so application code can focus on capabilities. FastMCP is a high-level API associated with the Python SDK that lets developers register tools, resources, and prompts with Python functions and decorators. The exact import path, server class, options, and transport entry points have changed across SDK generations, including major-version changes. Treat code here as a representative pattern for a compatible SDK release, pin the version, and confirm names against that release's documentation before deploying.

## Start from service logic

Keep domain operations as ordinary functions or service methods, separate from MCP registration. This makes them easier to unit test, reuse from HTTP handlers, and review for permission and data handling. The MCP layer should be thin: parse a model-facing request, establish the caller context, call a narrowly scoped service operation, and shape a response. Do not put all business logic in a decorator body simply because the example is short.

A common FastMCP-style sketch looks like this:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("catalog")

@mcp.tool()
def find_product(sku: str) -> dict:
    """Look up one active product by its exact SKU."""
    # Validate domain rules and call an injected/service-layer dependency.
    product = catalog_service.find_active(sku)
    if product is None:
        raise ProductNotFound(sku)
    return {"sku": product.sku, "name": product.name, "available": product.available}
```

This example shows intent, not a drop-in implementation: exception mapping, service construction, and transport configuration depend on the SDK and application. In production, avoid global service state if it hides resource ownership or identity. Use an application composition layer to construct database pools, clients, and services; close them on shutdown. Each invocation should use a safe transaction or session scope.

## Schemas from Python type hints

A key benefit of a high-level Python SDK is deriving the tool's JSON Schema from a callable signature and annotations. For a simple tool, parameters such as `sku: str`, `limit: int`, or a constrained model can inform the declared input schema. Defaults, optional values, nested data types, and docstrings may contribute to the generated contract, depending on the SDK and its supported types. This reduces handwritten schema duplication and can provide a validation layer before calling the handler.

Generated schema is not a security control. An annotation does not establish that the user may access a record, that a string is a safe path, or that a value is within a business limit. Validate authorization and domain invariants at runtime. Define bounds explicitly where possible, and inspect the generated JSON Schema with a client or MCP Inspector. Complex Python types may not map as expected; unsupported annotations, unions, aliases, or custom validators may be rejected, weakened, or translated differently across SDK versions.

Use explicit input models or validation logic for complex parameters rather than a large unstructured dictionary. A typed query object can constrain allowed filters and pagination. Avoid accepting a raw SQL string, shell command, or arbitrary URL as an “easy” universal input. Type hints help create a schema, but a broad schema can still be a dangerously broad capability.

## Registering resources and prompts

FastMCP-style decorators can register resources at fixed or templated URIs and prompts with named arguments. A resource handler should return bounded content with an appropriate type, and should apply the same caller-specific access rules as a tool. A prompt handler should assemble predictable messages from validated values without embedding credentials or treating retrieved content as trusted instructions.

SDK APIs differ in how they represent resource content and prompt message blocks. Check whether the chosen version expects a string, structured content object, async generator, or another type. Also verify which URI forms and template features a target host supports. Use the protocol-level type that is documented for the pinned version rather than relying on a convenient SDK coercion that might change.

## Async and blocking work

An async tool handler is useful when downstream clients are asynchronous and the handler awaits network or database I/O. Do not call blocking libraries directly inside `async def`; that blocks the event loop. Either use a supported async driver, isolate the blocking operation in a thread with bounded concurrency and client-side timeouts, or use a synchronous handler if the SDK has a safe execution model for it. CPU-heavy work generally belongs in a bounded worker process or job system, not in the request path.

Cancellation and timeout behavior are not interchangeable. Cancelling a coroutine may stop waiting while an underlying blocking call continues. Set timeouts in the downstream client, apply server-level deadlines where supported, and ensure cleanup in exceptions and cancellations. Limit concurrent calls to avoid exhausting database connections or vendor quotas.

## Identity and dependency injection

The handler needs a trustworthy caller identity to enforce permissions, particularly for remote servers. How that identity reaches the SDK context is version- and transport-specific. Do not store the current user's token in a mutable global variable or assume one server instance handles only one user. Bind identity to the request/invocation context with the SDK's supported mechanisms, then pass a principal or scoped service into the domain layer. If the SDK does not expose the required identity safely, place a well-designed authenticated gateway or adapter in front rather than silently using a shared superuser credential.

For stdio, the process may run with the desktop user's operating-system privileges. For remote HTTP, use the HTTP authorization mechanism appropriate to the selected specification and SDK. A service-to-service credential identifies the server, not necessarily the end user. Decide explicitly whether the server acts as itself, delegates user identity, or exchanges a scoped credential. Never confuse host configuration or tool input fields with authenticated identity.

## Run and inspect locally

The Python SDK commonly supplies a development command or Inspector integration, but names vary between releases. Use the tooling installed from the pinned dependency set. Exercise the server with a compatible client: list tools, inspect the generated schema, call a valid request, test invalid arguments, and verify resource and prompt responses. For stdio, check that logs go to stderr and the process exits cleanly. For HTTP, verify the exact transport route, content types, auth headers, and streaming behavior.

A minimal development example is not a deployment plan. Production configuration should use explicit transport, bind address, TLS or trusted proxy configuration, authentication, timeouts, and resource lifecycle. Don't assume a local dev command applies the same defaults or security as the production service.

## Common mistakes

- Copying decorator imports from an example for a different major SDK version.
- Assuming Python hints fully validate inputs or enforce authorization.
- Returning whole ORM objects and exposing internal fields through serialization.
- Using global shared sessions or a global mutable “current user.”
- Running blocking network calls inside an async handler without thread isolation or timeouts.
- Assuming a server's stdio or development defaults are safe for network exposure.

## Production notes

Pin Python and SDK versions, review dependency advisories, and run schema snapshots against every supported client. Keep registration code declarative and domain code independently testable. Use an explicit construction and shutdown path for pools and credentials. Validate tool schemas as generated artifacts: unexpected fields, missing bounds, or a changed return shape should fail tests. Finally, test the exact transport and authorization path that will run in production. FastMCP can remove protocol boilerplate, but it cannot make an overpowered handler safe by itself.