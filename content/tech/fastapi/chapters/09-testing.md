# Testing FastAPI Applications

FastAPI's testing surface is HTTP-shaped, but confidence comes from testing more than status codes. Verify the contract the client sees, isolate policy and infrastructure where appropriate, and use a real database or ASGI lifespan only when the test's purpose requires it. Pytest fixtures, `TestClient`, HTTPX's ASGI transport, and dependency overrides cover most application-level cases.

## TestClient and synchronous tests

Starlette's `TestClient` provides a synchronous interface to an ASGI app. It is convenient in ordinary `def` tests and exercises routing, dependency resolution, request parsing, and response serialization without opening a network port.

```python
from fastapi.testclient import TestClient
from myapp.main import app

client = TestClient(app)

def test_read_item():
    response = client.get("/items/7")
    assert response.status_code == 200
    assert response.json() == {"id": 7, "name": "widget"}
```

Use `with TestClient(app) as client:` when the test should run application lifespan startup and shutdown. A bare client may not execute lifespan in the way an application expects; use the context manager for resources initialized there. TestClient behavior depends on compatible Starlette and HTTPX versions, so keep the dependency set pinned and update it together when needed.

Test validation and error contracts too: invalid path/query values, malformed JSON, missing credentials, forbidden access, absent resources, and response-model filtering. Assert stable status and documented fields rather than brittle internal exception strings. A response-model test that verifies a secret field is absent is a security regression test, not just serialization coverage.

## Async tests and HTTPX

Use an async test when the test itself awaits async fixtures or database operations. HTTPX's `AsyncClient` can send requests through `ASGITransport` without a live server:

```python
import pytest
from httpx import ASGITransport, AsyncClient

@pytest.mark.anyio
async def test_health(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
```

`ASGITransport` does not itself guarantee application lifespan handling; pair it with a lifespan manager when startup/shutdown is required, or provide a fixture that starts lifespan explicitly. Choose one async test backend consistently. Mixing event loops or sharing loop-bound resources across fixtures can cause errors that look unrelated to the endpoint. Use the test framework's async fixture conventions instead of calling `asyncio.run` inside an active async test.

## Dependency overrides and fixture scope

`app.dependency_overrides` maps the original dependency callable to a replacement, which is useful for fake authentication, deterministic external APIs, and test database sessions.

```python
from fastapi.testclient import TestClient
from myapp.dependencies import get_current_user

app.dependency_overrides[get_current_user] = lambda: User(id=1, role="admin")
try:
    with TestClient(app) as client:
        response = client.get("/admin")
finally:
    app.dependency_overrides.clear()
```

In a real test suite, put setup and cleanup in a fixture so a failing test cannot leak overrides into the next one. Avoid using a global app with mutable overrides across parallel tests. An app factory makes isolated app instances easier. For database integration, create a dedicated test database or transaction strategy; overriding a session dependency is only safe if the override's connection and transaction semantics match what the route expects.

Keep fixtures narrow. A session-scoped database engine can be shared, but each test should usually get an isolated transaction or schema state. Seed records explicitly. A mock verifies interaction assumptions but not SQL behavior, constraints, migrations, or transaction semantics; retain integration tests for those guarantees. Never point destructive tests at production credentials.

## Unit, integration, and contract layers

Unit-test pure services and policies without HTTP. Integration-test FastAPI routes with dependencies replaced only at expensive external boundaries. Database integration tests should exercise the real driver and schema when their purpose is persistence correctness. A contract test can inspect `/openapi.json` for required paths, response schemas, and security declarations. Generated documentation can regress independently of runtime route behavior, so inspect it when clients rely on OpenAPI.

Test concurrency-sensitive behavior at the appropriate layer. A TestClient request verifies application logic but does not prove production socket, reverse proxy, worker, TLS, or load-balancer behavior. For timeout, streaming, and disconnect semantics, run a small deployment-like test with the real ASGI server and proxy configuration.

## Common mistakes

- Forgetting lifespan in tests for applications that initialize resources there.
- Leaving dependency overrides on a shared app after a test fails.
- Using a mock as the only evidence that database transactions and constraints work.
- Running async tests with resources created on a different event loop.
- Asserting exact error text that can change between library versions.
- Assuming in-process ASGI tests validate TLS, worker processes, proxy buffering, or network timeouts.

## Production notes

Run a focused test suite on supported Python and dependency versions, especially during FastAPI, Starlette, Pydantic, and HTTPX upgrades. Use factories and deterministic fixtures; avoid order-dependent tests. Include negative and adversarial cases: malformed tokens, cross-tenant identifiers, oversized fields, duplicate requests, and unexpected upstream statuses. Make sure test settings cannot silently resolve production secrets. A useful suite has fast unit tests, route-level integration tests, a smaller real-database set, and a deployment smoke test that checks health and one representative request.

## Test the boundaries clients depend on

A test that asserts only status 200 can miss a breaking response rename, a leaked field, or an undocumented content type. Assert representative JSON bodies, response headers, and status codes, especially for create, delete, and authentication flows. For list endpoints, test pagination boundaries, stable ordering, empty results, and invalid cursors. For write endpoints, verify duplicate submissions and transaction rollback after a failure between related changes. These tests document semantics more clearly than endpoint implementation details.

Use parametrization for security boundaries: missing token, malformed token, expired token, wrong audience, insufficient scope, and cross-tenant object access. A single happy-path authentication test proves very little. Avoid using a fake current user for every route test; include a smaller number of tests that exercise the real token-validation component with test keys and the actual authorization policy. Never place production signing keys in a test fixture.

Property-based testing can complement examples for validators and serializers, especially when the input space is large. Set request size limits and verify too-large payload handling at the server or proxy layer, since an application-level model test does not exercise upload buffering. For streaming APIs, consume only a few chunks and then close the client to test cancellation and cleanup; also test generator failure after headers have been sent. Isolate state so randomized order or parallel execution does not change outcomes. A flake that depends on test order is evidence of shared mutable state, not a reason to disable parallelism permanently.

Use coverage as a navigation aid rather than a target to maximize blindly. Untested branches often reveal missing policy cases, but a line executed once may still be weakly asserted. Mutation testing can show whether tests notice a changed condition or removed authorization check, especially in small security-sensitive helpers. Keep tests fast enough to run on every change, then run database and deployment suites in appropriate CI stages. When a dependency upgrade changes error details or lifecycle behavior, first verify whether the behavior is part of the documented contract; update tests only when the contract intentionally changes. Maintain a small set of integration tests against the locked dependency set so transitive incompatibilities surface before a production rollout.