# Errors, Exception Handlers, and Response Models

An API error is part of the contract. A useful response tells the client what happened and gives it a status code that reflects the outcome, while avoiding stack traces, database details, and secrets. FastAPI and Starlette provide standard exception handling; application code decides which failures are expected and how they map to HTTP.

## Raise for expected HTTP failures

Raise `HTTPException` when processing must stop with a deliberate HTTP status. It is an exception, not a response value, so it can be raised inside an endpoint or dependency and immediately short-circuit the remaining dependency graph.

```python
from fastapi import HTTPException

async def read_order(order_id: int):
    order = await repository.get(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return order
```

The `detail` value is encoded in the response body; it can be structured JSON, but maintain a stable schema if clients depend on it. Supply headers when protocol behavior requires them, for example `WWW-Authenticate` on an authentication challenge or `Retry-After` when retry guidance is meaningful. Do not turn every internal exception into a 404; distinguish absent resources, invalid state, denied access, and dependency failures.

Request parsing and Pydantic validation failures use FastAPI's `RequestValidationError` handling (normally 422). A response model mismatch is a server-side defect, not bad client input; FastAPI treats response validation as an internal failure. This distinction matters: returning 422 for a response bug suggests the caller can fix the server's invalid output.

## Custom exception types and handlers

Define domain exceptions in the service layer and translate them at the HTTP boundary. A handler can be registered with `@app.exception_handler` and returns a Starlette `Response` such as `JSONResponse`.

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

class InventoryUnavailable(Exception):
    pass

@app.exception_handler(InventoryUnavailable)
async def inventory_unavailable(request: Request, exc: InventoryUnavailable):
    return JSONResponse(
        status_code=503,
        content={"code": "inventory_unavailable", "message": "Try again later"},
        headers={"Retry-After": "5"},
    )
```

Register a handler only for a failure whose meaning is understood. A domain exception can be raised from a dependency or service and still be handled by the application. For framework exceptions, Starlette's `HTTPException` is a base used by FastAPI; when overriding its handler, register against `starlette.exceptions.HTTPException` if the handler should also catch Starlette-originated errors. Preserve headers such as `WWW-Authenticate` and `Allow` when adapting the body.

Custom validation handlers can normalize error shapes, but validation details may include submitted values. Avoid echoing secrets or large payloads into logs and responses. If you alter the default schema, document it and test locations, error codes, and status. Keep `debug` off in production; debug tracebacks can expose implementation details.

## Response models as output allowlists

A response model is a data contract and a useful field allowlist. It can prevent internal fields from leaking and documents what the caller may rely on. Use explicit DTOs for public responses rather than returning database entities with whatever columns currently exist.

```python
from pydantic import BaseModel

class AccountOut(BaseModel):
    id: int
    email: str

@app.get("/accounts/{account_id}", response_model=AccountOut)
async def account(account_id: int):
    return {"id": account_id, "email": "a@example.test", "password_hash": "private"}
```

FastAPI will filter serialized output through the declared response model in the normal return path. If the endpoint returns a `Response` instance directly, the body is already constructed and standard response-model filtering does not apply. This is appropriate for streaming, files, custom headers, and pre-encoded output, but it transfers responsibility for content type, encoding, and validation to the application.

Use `status_code` on the operation for its normal success status and `responses` metadata for documented alternate outcomes. Runtime exceptions are not automatically documented just because they might occur. Include stable schemas for common error responses where client generation matters. A `204 No Content` response must not send a JSON body; ensure both response metadata and actual behavior agree.

## Logging, tracing, and retries

Log unexpected exceptions with a request or trace identifier, exception type, and relevant safe context. Avoid logging authorization headers, raw credentials, or full bodies by default. A single error should not be logged independently by every layer; decide where the exception is converted and logged to prevent duplicated noisy stack traces.

Do not retry every failure automatically. A timeout can mean the upstream completed an operation but the response was lost. Retrying a non-idempotent write may duplicate effects unless the operation uses an idempotency key or transaction guarantee. Map upstream failures thoughtfully: a service dependency outage may justify 503, while a malformed upstream response can be an internal error. Preserve causal context for operators without exposing it to clients.

## Common mistakes

- Returning status 200 with an `{error: ...}` body for a failed operation.
- Catching `Exception` in every route and hiding programming errors as client errors.
- Revealing exception messages, SQL details, stack traces, or credentials in public output.
- Overriding HTTP exception handling and accidentally dropping protocol headers.
- Assuming a `response_model` validates a body created by a direct `Response` return.
- Documenting only the happy path when generated clients need known failure shapes.

## Production notes

Treat status codes and error schemas as compatibility surface. Write tests for authorization failures, missing resources, validation errors, and unexpected response-model violations. Keep a clear separation between domain exceptions and HTTP representation, and make error IDs correlate with logs and traces. When an upstream is unavailable, set bounded timeouts and use circuit-breaking or retry policy at the appropriate integration layer; an exception handler only shapes the response and does not provide resilience by itself.

## Error semantics across layers

A route may fail at several boundaries: request decoding, schema validation, authentication, domain rules, persistence, an upstream dependency, or response serialization. Keep those categories distinguishable in logs and metrics even when the client-facing body has a small common shape. For example, a stable error envelope can contain a machine-readable code and a request ID, while a validation error may additionally list safe field locations. Do not expose raw Python exception class names as a permanent API protocol; they couple clients to implementation details.

Status codes are useful only when chosen consistently. Use 400 for malformed or invalid requests when that is the established contract, 401 for missing/invalid authentication, 403 for an authenticated but forbidden action, 404 for absence or deliberate concealment, and 409 for a genuine conflict. 429 can communicate rate limiting and may include `Retry-After`. A 503 can indicate temporary unavailability, but returning it does not itself prevent a retry storm. Clients need idempotency guarantees and bounded retry policies. Avoid mapping every upstream timeout to 504 unless the service is acting as a gateway and that meaning matches its contract.

If an exception handler returns a custom response, set content type and headers correctly and ensure it behaves for requests from dependencies as well as path operations. A handler should not accidentally swallow cancellation or process-control exceptions. For asynchronous integrations, cancellation commonly propagates during shutdown; let cleanup run and then re-raise. Test error handlers using the actual ASGI app so framework exception routing and middleware order are included. A direct unit test of the handler function cannot prove the response is registered as expected.