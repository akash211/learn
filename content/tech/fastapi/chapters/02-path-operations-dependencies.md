# Path Operations and Dependency Injection

FastAPI's route declarations do more than map a URL to a function. The function signature is a request contract: it tells FastAPI which values come from the path, query, body, headers, or cookies, which values are required, and which dependencies must be resolved before the endpoint runs. Good signatures are explicit enough to document the API and small enough to review.

## Declare the operation and bind inputs

A path operation combines an HTTP method decorator with a path. Path placeholders become required parameters with matching names. Scalar parameters not present in the path are normally query parameters; Pydantic models normally represent request bodies. Use `Path`, `Query`, `Header`, `Cookie`, and `Body` to make intent and constraints explicit, especially when inference could be ambiguous.

```python
from typing import Annotated
from fastapi import FastAPI, Path, Query
from pydantic import BaseModel, Field

app = FastAPI()

class ItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: float = Field(gt=0)

@app.post("/items/{item_id}")
async def update_item(
    item_id: Annotated[int, Path(ge=1)],
    item: ItemIn,
    notify: Annotated[bool, Query()] = False,
):
    return {"id": item_id, "name": item.name, "notify": notify}
```

`Annotated` keeps the type (`int`) separate from framework metadata (`Path`). This makes the declared Python type meaningful to other tools while FastAPI reads the metadata. A path value that cannot be parsed as an integer or violates the constraint is rejected before the function runs. Query strings arrive as text and are parsed into the declared types; invalid values produce a validation response rather than a `ValueError` inside the endpoint.

Use separate request and response models when the client is allowed to send only a subset of fields. Never accept a database model wholesale as an input contract: internal fields can become writable by mistake. For simple bodies, embedding multiple models or primitive values is possible, but a named model is easier to evolve and document.

## Dependencies are callable graph nodes

A dependency is a callable requested with `Depends`. Its own parameters can be request data or other dependencies. FastAPI recursively builds the graph, evaluates dependencies, and passes results into the endpoint. This is useful for cross-cutting inputs such as a current user, a database session, pagination, or shared policy checks.

```python
from typing import Annotated
from fastapi import Depends, Header, HTTPException

async def require_tenant(
    x_tenant: Annotated[str | None, Header()] = None,
) -> str:
    if not x_tenant:
        raise HTTPException(status_code=400, detail="X-Tenant is required")
    return x_tenant

Tenant = Annotated[str, Depends(require_tenant)]

@app.get("/reports")
async def list_reports(tenant: Tenant):
    return {"tenant": tenant, "items": []}
```

Dependencies can depend on dependencies; FastAPI resolves shared dependency nodes once per request by default when the cache is enabled. This avoids parsing the same credentials or creating the same request-scoped resource repeatedly along one dependency graph. Set `use_cache=False` only when repeated evaluation is intentional. Keep dependencies focused: a function that authenticates, fetches five unrelated resources, and formats a response is hard to reuse and test.

Use `Security` rather than plain `Depends` where scopes and OpenAPI security declarations are relevant. Dependencies can raise `HTTPException` to stop the graph and return a response. They can also return values such as a principal or a session; they should not mutate global state to communicate with an endpoint.

## Lifetimes, cleanup, and scopes

Dependency lifetime is not simply “global versus local.” A callable may be run for each request, cached within a request, or yield a resource whose cleanup must happen at the correct boundary. A common pattern is a request-scoped database session:

```python
from collections.abc import Generator
from sqlalchemy.orm import Session


def get_session() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session

SessionDep = Annotated[Session, Depends(get_session)]
```

FastAPI runs the code before `yield`, injects the yielded value, and executes cleanup after the dependent work's lifecycle. For async resources, use an async generator and `async with`. Recent FastAPI versions distinguish dependency scopes for `yield` dependencies; a request-scoped cleanup runs at request completion, while a function-scoped cleanup can run when the path operation finishes. Choose deliberately when a streaming response needs the resource after the endpoint returns. Verify exact supported scope options against the installed FastAPI version: lifetime details have changed over releases.

Do not create a database session as an application singleton and inject it everywhere. A session tracks mutable identity-map and transaction state; sharing it across concurrent requests is unsafe. Application-scoped clients and pools can be placed in `app.state` during lifespan, while each request obtains its own session or transaction from those pools.

## Router-level composition

`APIRouter` lets a module define routes with common prefix, tags, response metadata, and dependencies. Dependencies can be attached at router inclusion or application level when they should run for every route, even if the endpoint does not need their returned value. This is useful for policy enforcement or request checks. If the endpoint needs the value, inject it in the signature rather than relying on implicit side effects.

A dependency is not a substitute for middleware. Middleware wraps every request and response and is suitable for transport-wide behavior. Dependencies are route-aware, participate in OpenAPI security and validation, and are usually the clearer place for endpoint authorization. Use the narrowest mechanism that expresses the requirement.

## Common mistakes

- Using a dependency as a hidden global service locator. Explicit parameters make contracts visible and overrides straightforward.
- Assuming every scalar comes from JSON. Path and query values have default inference rules; use `Body` for explicit primitive bodies.
- Returning a dependency object that is unsafe to share. A request-scoped session must not be cached globally.
- Forgetting cleanup for a yielded session or client. Use context managers and test failure paths too.
- Expecting `use_cache=False` to make a dependency run once; it does the opposite by bypassing request caching.
- Putting authorization only in a frontend or route name. Enforce it in a dependency that is applied to every protected route.

## Production notes

Treat dependency graphs as executable architecture. Name aliases such as `CurrentUser` or `SessionDep` to make signatures readable, and keep infrastructure construction in a composition module. Test important dependencies independently and use dependency overrides to isolate routes. When reviewing a change, trace from the route through each nested dependency and ask who owns the resource, what its scope is, and which exception prevents the endpoint from running. This prevents subtle transaction leaks and policy gaps more reliably than adding decorators by convention.

## Designing stable route contracts

A route declaration contributes to OpenAPI, so names and metadata have consequences beyond Python readability. Use explicit operation IDs when generated client tooling needs stable method names, and use tags to group related endpoints. Be deliberate about response status codes: a create operation might use 201, an accepted asynchronous job often uses 202, and a delete with no representation may use 204. Align the actual response body with that status; a 204 response must not carry JSON content. Specify response descriptions and known error schemas where clients need them rather than assuming that FastAPI infers every possible branch from code.

Avoid ambiguous paths where a catch-all parameter competes with a more specific route. Define static paths and constrained parameter types carefully, and test route resolution for overlapping patterns. Path operation order can matter when two routes could match the same path. A path converter or a typed path parameter can narrow accepted values, but should not be mistaken for authorization. A syntactically valid user ID still requires an access check.

Dependencies can have side effects, but such effects make ordering and reuse important. Authentication should happen before protected service work; transaction creation should not be hidden in a dependency used by routes that never write. Prefer pure computations and explicit return values. If a dependency caches a result per request, that is useful for sharing an authenticated principal, but it does not mean the underlying object is safe to reuse across concurrent requests. The application boundary still owns policy, scope, and cleanup.