# Async Testing with pytest-asyncio and AnyIO

Async tests must run coroutines inside an event loop and make their asynchronous dependencies behave like production. Pytest core does not decide every async test's event-loop policy: plugins do. Choose one framework and configuration deliberately, because mixing plugins can cause competing loop ownership, fixture semantics, or unexpected test collection.

## pytest-asyncio

With `pytest-asyncio` installed, async test functions can be marked with `@pytest.mark.asyncio`. Strict mode is a useful explicit policy: only marked async tests are managed as asyncio tests, so an accidental coroutine function does not silently run under plugin-specific auto detection.

```python
import pytest

@pytest.mark.asyncio
async def test_client_retries_once(client):
    result = await client.fetch("/items/1")
    assert result.status == 200
```

The plugin's event-loop fixture and scope behavior have changed across versions; use the documentation matching the pinned version. By default, function-level loops isolate tests well. Broader loop scopes can reuse loop-bound clients or servers, but sharing an event loop expands the chance of pending tasks and state leaking between tests. Do not depend on a fixture's loop scope being inferred identically across plugin versions.

Configure `asyncio_mode = "strict"` or `"auto"` intentionally. Strict mode distinguishes tests and fixtures explicitly marked for asyncio; auto mode treats async tests automatically and can be convenient in a repository committed to one async framework. If a project uses multiple async libraries, strict mode and explicit markers can avoid ambiguous ownership. Never configure two plugins to manage the same test without a clear supported integration.

Async fixtures have lifecycle subtleties. `pytest-asyncio` supports async fixtures, but fixture decorator and loop-scope requirements depend on its version. Follow the installed plugin's supported pattern rather than assuming that `@pytest.fixture` on `async def` will be handled. A fixture must create and close loop-bound resources on a compatible loop; otherwise teardown may raise "attached to a different loop" or leave tasks behind.

## AnyIO and framework-neutral async tests

AnyIO provides an async test runner that can execute tests against supported backends, including asyncio and Trio where available. Mark tests with `@pytest.mark.anyio`; the `anyio_backend` fixture chooses the backend. This is useful for libraries intended to be backend-neutral, but testing multiple backends is only meaningful if dependencies support both. A service intentionally coupled to asyncio should not pretend otherwise.

```python
import pytest

@pytest.mark.anyio
async def test_service_returns_value():
    result = await service_call()
    assert result == "ready"
```

AnyIO's pytest plugin and pytest-asyncio can coexist in a repository when their tests and fixtures are explicitly assigned, but avoid overlapping automatic modes. A shared async fixture should be compatible with the runner that consumes it. Prefer a clear test convention per directory or module, and pin the versions that define plugin behavior.

For FastAPI endpoint tests, synchronous `TestClient` tests are often enough for HTTP contract behavior. If the test itself must await application or client APIs, use an async HTTPX client with an ASGI transport and the chosen async plugin. Keep the event loop lifecycle under one owner, and ensure application lifespan startup and shutdown actually run when that is part of the behavior under test.

## Await what you start; close what you create

An async test should await the operation whose result it asserts. Creating a coroutine without awaiting it emits warnings and does not execute its body. Background tasks must be awaited, cancelled and joined, or managed with structured concurrency such as `asyncio.TaskGroup`. A test that returns while tasks remain can produce warnings, contaminate later tests, or hide failures.

Use explicit timeouts for potentially hanging operations. `asyncio.wait_for` can bound a specific awaitable, but timeout behavior and cancellation are part of the contract: a coroutine may need cleanup in `finally`. Prefer a fake clock or controlled synchronization primitive over sleeping for arbitrary durations. When concurrency ordering matters, use `asyncio.Event`, queues, or barriers rather than `await asyncio.sleep(0.1)` and hope the scheduler runs as expected.

Async mocks must match async call semantics. `AsyncMock` can represent an awaitable dependency; configure `side_effect` for successive outcomes and assert it was awaited with expected arguments. Do not use a regular mock that returns a coroutine-shaped object by accident. For HTTP calls, keep transport behavior explicit with HTTPX's mock transport or a suitable ASGI test client.

## Common mistakes

- Mixing auto modes or multiple event-loop managers without understanding fixture ownership.
- Reusing loop-bound objects across loops or closing them from another loop.
- Starting tasks without awaiting, cancelling, or joining them.
- Using sleeps for synchronization, which causes timing-dependent flakes.
- Treating async syntax as evidence of concurrent behavior; a single awaited call may be entirely sequential.

## Production notes

Pin the async plugin and test its configuration in CI. Run a narrow async test under warnings-as-errors during development to catch unawaited coroutines and pending tasks. Keep loop and resource scope aligned: the client, server, and loop should share a deliberate lifetime. Test cancellation and timeout paths if callers depend on them. A robust async test controls the scheduler-facing events instead of relying on wall-clock luck.

## Event-loop boundaries and cancellation

An event loop is a resource with ownership. A client or task created on one loop may not be safe
on another, even if both tests execute in the same Python process. Keep fixture scope compatible
with loop scope, and close clients before their loop is shut down. If a fixture's teardown awaits
cleanup, make sure the plugin's fixture mechanism runs that teardown inside the expected loop.
Version-specific configuration matters; consult and pin the plugin version actually installed
rather than copying an example for a different release.

Cancellation is cooperative. When a timeout cancels a coroutine, it receives cancellation at an
await point and should release resources in `finally`. A test can verify cancellation by setting
an event in cleanup and asserting that event after the timeout. Avoid swallowing cancellation
exceptions and then continuing to use a resource that the caller expects to be stopped. For
structured child tasks, let the parent scope own their completion; a task that outlives the test
can make subsequent tests fail for unrelated reasons.

Async generators and streaming responses also need explicit closure. Exhausting the iterator may
finish it naturally; early termination should use the appropriate async context manager or call
`aclose()` when the API requires it. Test both full consumption and early disconnect if cleanup
behavior is part of the service contract. For web applications, invoke lifespan hooks in tests
that claim to validate startup-created pools, scheduler tasks, or shutdown cleanup. An HTTP request
that succeeds without lifespan execution is not evidence that production startup is correct.

## Backend choice as a compatibility test

AnyIO's backend fixture can run a compatible test against more than one async backend. This is
valuable when the package promises backend neutrality: a hidden dependency on an asyncio-only
primitive may pass under asyncio and fail under Trio. Keep backend parametrization explicit and
ensure every dependency used by the test supports the selected backends. If the application is
intentionally asyncio-specific, testing an unsupported backend creates noise rather than coverage.

Do not make each unit test spin up a full web server. For route-level behavior, an in-process ASGI
transport can exercise routing, dependency injection, and response serialization without opening a
listening socket. Add a smaller number of actual server or deployment checks when socket binding,
proxy handling, or lifespan integration is the contract. This layered approach keeps tests fast
while still validating the places where loop and transport behavior differ.
