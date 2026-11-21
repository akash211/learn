# FastAPI Mounting and API Clients

Gradio can provide a browser UI while an existing FastAPI application owns the broader service: health checks, API routes, middleware and shared deployment. It also exposes callable interface functions that another program can invoke through HTTP or the Gradio Python client. These are related integrations, but they serve different purposes: mounting composes applications; the client calls an app remotely.

## Mount a Blocks app into FastAPI

Create the Gradio app without launching its own server, then mount it using the integration helper exposed by the installed Gradio release. A common Gradio 4/5 pattern is `gr.mount_gradio_app`:

```python
import gradio as gr
from fastapi import FastAPI

with gr.Blocks() as demo:
    prompt = gr.Textbox()
    answer = gr.Textbox()
    gr.Button("Run").click(fn=generate, inputs=prompt, outputs=answer)

api = FastAPI()
api = gr.mount_gradio_app(api, demo, path="/demo")
```

This uses one ASGI application and a path prefix for the interface. Exact options and lifecycle hooks should be checked against the installed version. Keep the root FastAPI routes and Gradio mount distinct; test docs routes, static assets, redirects and API endpoints under the real prefix. Avoid separately calling `demo.launch()` when the mounted ASGI server is responsible for serving it.

Mounting does not automatically transfer every security decision from the parent app. Review the Gradio mount's authentication options, FastAPI middleware coverage, reverse proxy behavior and path-based access control. Confirm whether middleware runs for mounted routes in the way your deployment assumes. If a UI route and API endpoint expose the same model operation, protect both. Do not rely on a navigation link being hidden or a UI control being disabled.

Model lifecycle matters in a composed service. A module-level model can be shared by callbacks within a process, but multiple ASGI workers may each import the module and load another copy. For GPU models, worker count and preload strategy can exhaust VRAM. Consider a dedicated inference service or a single model worker behind the web tier when scaling the API and UI independently.

## Discover the endpoint contract

Gradio can expose the functions behind event listeners as API endpoints. The app's generated API page and `view_api()` support, where available, help inspect endpoint names, parameters and examples. Endpoint names are not necessarily identical to button labels; use the generated documentation for the running app and treat it as a contract to verify. Event functions can also be marked or configured not to appear as API endpoints in versions that support that behavior.

An API call still goes through the component's preprocessing and callback pipeline. Inputs may be serialized in a component-specific way; file inputs may require upload handling; outputs may be represented by a structured response or file reference. Do not assume the HTTP payload is simply the Python callback's raw type. Write an integration test using the same path a client will call.

## Call with gradio_client

The `gradio_client` package provides a Python `Client` that connects to a running Gradio app. `predict()` invokes an endpoint by its API name or supported index; `submit()` provides a job-like interface for calls that may run asynchronously, with result handling as documented for the package version.

```python
from gradio_client import Client

client = Client("http://localhost:7860")
result = client.predict("hello", api_name="/predict")
```

Use an explicit API name rather than a positional function index in maintained integrations, since endpoints can be added or reordered. Pin compatible client/server versions where possible, and inspect endpoint schemas during deployment. For protected apps, use the documented authentication configuration and store credentials in a secret manager or environment injection—not in source code or logs.

The client can handle Gradio's protocol and file transfer more conveniently than hand-writing HTTP requests. That convenience does not remove the need for timeouts, retries, idempotency and version compatibility. A retry after a network timeout may re-run an expensive or side-effecting callback if the server completed work but the response was lost. Make operations idempotent or use a request identifier where the application controls it.

## API exposure and compatibility

A public Gradio endpoint is an API surface even if it was created for a UI. Review which listeners are exposed, validate payloads, add authentication where necessary and consider rate limits. Do not expose administrative callbacks, arbitrary code paths, filesystem operations or internal model controls unintentionally. Generated API docs can reveal function structure and should be treated as public documentation unless protected.

If you need a stable contract for external consumers, consider a dedicated FastAPI route with a versioned schema and map it to shared inference logic. Gradio's generated endpoint is ideal for prototypes, internal automation and cases where clients can move with the app. A durable public API may need stronger compatibility guarantees, error schemas, observability and independent deprecation policy than a UI event provides.

## Common mistakes

- Calling `launch()` on an app that should be mounted into a FastAPI ASGI server.
- Assuming the UI's authentication or hidden controls protect every generated endpoint.
- Hard-coding endpoint indices instead of names and checking the API page/schema.
- Treating a timed-out client call as proof the server did not complete the job.
- Adding ASGI workers without accounting for one model load per process.

## Production notes

Test the mounted app under the actual root path and proxy prefix, including static assets, authentication redirects, file downloads and API calls. Pin or test the `gradio_client` version alongside the server. Separate the shared model/inference function from both the Gradio callback and FastAPI route so transport layers do not duplicate business logic. Use Gradio endpoints for convenient invocation; define a dedicated API when stability and policy demand it.

## Keep shared logic below both transports

Avoid making a FastAPI route call the Gradio endpoint inside the same process, or making a Gradio callback issue an HTTP request back to its own service. Those patterns add serialization and authentication complexity without creating a meaningful boundary. Instead, put validation, inference orchestration and domain operations in a shared Python service function. The Gradio callback adapts component values to that function; a FastAPI route adapts a versioned request model to the same function.

This separation also enables focused tests. Unit tests exercise domain behavior without an ASGI server, while integration tests verify the UI event and HTTP schema. Keep transport errors distinct from model failures and map them to useful responses. If two transports require different permissions, pass an authenticated principal or service context explicitly rather than duplicating business rules. The result is easier to migrate if the UI or API strategy changes.

For authentication, avoid forwarding a browser cookie or token to a model service unless that service is designed to validate it. Prefer the service's established identity propagation or a narrowly scoped service credential stored outside Gradio's component values. Log a correlation identifier and outcome, not a bearer token. This avoids accidentally turning an internal integration into a credential-exfiltration path.
