# ASGI, Starlette, and Where FastAPI Sits

A FastAPI endpoint is the visible surface of a layered web application. Understanding the layers explains why a framework can validate a body and generate docs but cannot make blocking code non-blocking, why Uvicorn matters, and where middleware belongs. Follow one request from the socket upward and the architecture becomes concrete.

## From HTTP connection to application

A client opens a connection and sends an HTTP request. A server such as Uvicorn handles sockets, HTTP parsing, connection management, and protocol details. It translates the incoming event stream into an ASGI scope and invokes the application. An ASGI application is an asynchronous callable with the essential shape `app(scope, receive, send)`: `scope` describes the connection or request, `receive` yields incoming events such as request-body chunks, and `send` emits response-start and response-body events.

ASGI is an interface, not a server and not a framework. It supports HTTP and WebSocket, and its lifespan protocol provides startup and shutdown events. The ASGI contract lets a server and application be developed independently. Uvicorn can run Starlette or FastAPI; the framework does not open the listening socket itself.

In the ordinary HTTP path, Uvicorn receives bytes, creates a request scope, and calls the ASGI app. FastAPI routes the request, obtains parameters, resolves dependencies, validates data, invokes the endpoint, and constructs a response. Starlette provides much of the underlying request, response, routing, middleware, exception, and lifespan machinery. The response is sent back through ASGI events and Uvicorn writes it to the client.

## WSGI versus ASGI

WSGI defines a synchronous callable interface for HTTP applications. It made Python web servers and frameworks interoperable, but does not express asynchronous request handling or WebSockets in the same way. ASGI extends the model to asynchronous callables and connection-scoped event streams. A WSGI app can be adapted and run within an ASGI deployment in some configurations, but the adapter does not turn synchronous work into non-blocking work; it uses a thread boundary.

| Concern | WSGI | ASGI |
|---|---|---|
| Application style | Synchronous callable | Async callable and event messages |
| WebSockets | Not part of core interface | Supported by the protocol |
| Long-lived connections | Awkward or extension-specific | Natural protocol use case |
| Blocking code | Expected execution model | Still blocks if run on the event loop |
| Typical server examples | Gunicorn workers | Uvicorn, Hypercorn |

ASGI is not automatically faster. It is a concurrency interface that allows a task to yield during I/O. Throughput depends on workload, libraries, worker limits, and deployment. A CPU-bound Python loop or synchronous socket call still consumes execution capacity.

## Starlette and FastAPI responsibilities

Starlette is a lightweight ASGI framework and toolkit. FastAPI builds on it, adding signature-driven parameter parsing, Pydantic validation and serialisation, dependency injection, and OpenAPI generation. Many objects exposed by FastAPI—`Request`, `Response`, middleware, routes, and the test client integration—come from or follow Starlette behavior.

This division matters when debugging. A route matching issue may be Starlette routing; malformed JSON may fail during request parsing; schema validation errors are surfaced by FastAPI's request validation path; a response may be a Starlette response class that bypasses some automatic serialization. The server handles protocol and process-level concerns, not Pydantic models.

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

The object `app` is an ASGI application accepted by Uvicorn. A development command can run it as `uvicorn package.module:app --reload`, but reload is a development convenience, not a production process manager.

## Lifespan and application resources

Some resources belong to the application lifetime rather than a request: an HTTP connection pool, model instance, or shared client. ASGI lifespan is the appropriate place to create and close them. In FastAPI, an async context manager can be supplied as `lifespan`:

```python
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=5.0)
    try:
        yield
    finally:
        await app.state.http.aclose()

app = FastAPI(lifespan=lifespan)
```

Startup should fail clearly if a required resource cannot be initialized. Shutdown should release clients, pools, and background tasks. Avoid creating network clients at module import: imports are not a lifecycle protocol, test processes may import repeatedly, and worker processes each have their own memory. Each worker usually owns its own pool, so multiplying worker count also multiplies database and upstream connections.

## Middleware, routing, and exceptions

Middleware wraps application requests and responses. Use it for cross-cutting concerns such as request IDs, timing, CORS, or trusted host enforcement. Ordering matters: middleware wraps other middleware and the router, so the outer layer sees the request first and response last. Middleware should not duplicate endpoint-specific authorization or silently consume bodies. Prefer framework-supported middleware and explicit dependencies for route-level policy.

Routers group related operations and can attach prefixes, tags, dependencies, and response metadata. They keep a large application modular without creating separate server processes. A router is included in the same application and shares its event loop and application state.

Exception handlers translate known failures into HTTP responses. Starlette's exception machinery and FastAPI's defaults provide normal behavior; custom handlers should preserve status codes and useful headers. A global catch-all that converts every failure to HTTP 200 hides incidents and breaks client semantics. Log unexpected errors once with a correlation identifier while returning a safe response.

## Common mistakes

- Treating ASGI as the server. Uvicorn or another ASGI server owns sockets and protocol handling.
- Assuming `async def` makes a synchronous library asynchronous. It does not; blocking code still blocks its thread.
- Treating FastAPI as unrelated to Starlette. Starlette behavior explains routing, responses, middleware, and many test details.
- Creating one global connection pool and forgetting that every worker is a separate process with its own pool.
- Running `--reload` in production. Reload watches files and is intended for development.

## Production notes

Know which layer owns a symptom. Connection refusal is likely listener, networking, or process management; a route returning the wrong schema is application behavior; loop stalls point to blocking work; repeated startup resource allocation points to lifecycle code. Add structured access logs and request IDs at the boundary, and export application metrics separately from server metrics. Pin compatible FastAPI, Starlette, and Pydantic versions through a lockfile and run tests on upgrades: these packages evolve independently, and behavior follows the installed versions rather than a tutorial's date.

## Request flow in a little more detail

An ASGI scope is a dictionary containing protocol-specific information: for HTTP it includes the method, path, headers, server and client addresses, and ASGI version. The request body may arrive in multiple `http.request` messages, so middleware or an application that reads it must respect the receive channel rather than assume the entire payload is already in memory. The response is similarly emitted as a start message with status and headers followed by one or more body messages. Starlette's abstractions make these details pleasant to work with, but understanding the messages clarifies why streaming, disconnects, and middleware body consumption need care.

The lifespan scope is separate from an individual HTTP request. It allows the server and app to coordinate startup and shutdown, but only when the server or test harness actually participates in lifespan. This distinction explains why a route test can pass with a manually populated global while the deployed application fails on startup, or why a test transport can skip initialization. Treat readiness as a statement that required startup dependencies are available, not just that Python imported the module.

When adding an ASGI middleware, preserve the application contract and avoid buffering arbitrary bodies. A body-size limit is often more effectively enforced at a trusted proxy or server boundary, with an application check for defense in depth. WebSocket scopes differ from HTTP scopes, so an HTTP-only middleware should either pass other scope types through untouched or deliberately reject them. These details are usually hidden by framework APIs until an integration or streaming edge case exposes them.