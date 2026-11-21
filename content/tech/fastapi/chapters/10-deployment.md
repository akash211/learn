# Deployment, Workers, Timeouts, and OpenAPI

A FastAPI application becomes a service only when its ASGI process is supervised, configured, observable, and bounded. Uvicorn handles the ASGI server role; a container platform or process manager handles placement and restarts. FastAPI's automatic docs and OpenAPI schema are useful deployment artifacts, but they are not substitutes for versioning, access policy, or operational limits.

## Uvicorn and worker processes

A simple process can run `uvicorn myapp.main:app --host 0.0.0.0 --port 8000`. For local development, `--reload` watches files and restarts the server; never combine development reload behavior with production assumptions. Production commonly runs multiple worker processes through Uvicorn's worker support or a process manager such as Gunicorn with an appropriate Uvicorn worker implementation. Exact commands and worker-class package names vary by installed Uvicorn/Gunicorn versions; follow current project documentation and test the command in the built image.

Each worker is an independent process with its own event loop, application lifespan, in-memory caches, and database pool. Increasing workers may improve use of multiple CPU cores, but it multiplies memory and downstream connection demand. A global Python variable is not shared state across workers. Use an external database, cache, or broker when state must be shared. Worker count should be constrained by CPU, memory, connection budgets, and workload measurements, not by a universal formula.

Containers should run one clearly supervised server process per container in many orchestrated deployments, leaving replica scaling to the platform. Run as a non-root user, use a small trusted base image, pin dependencies, and keep secrets in the environment or secret manager rather than the image. Add a health check that distinguishes process liveness from readiness to serve traffic. A process being alive does not prove the database is available or the application has completed startup.

## Timeouts and graceful shutdown

Timeouts exist at multiple layers: client connect/read, application deadline, reverse proxy, load balancer, server keep-alive, database statement, and orchestration termination grace period. Align them intentionally. If the proxy gives up before the application, upstream work may continue wasting resources. Set finite timeouts for outbound HTTP and database operations; a client disconnect does not automatically interrupt every blocking function.

Graceful shutdown should stop accepting new work, allow in-flight requests and lifespan cleanup to finish within the platform's termination window, and then exit. Long-lived SSE or streaming connections complicate draining; define whether to close them, how clients reconnect, and how the proxy handles them. Uvicorn options evolve, so verify actual worker timeout and graceful-shutdown behavior with the selected process manager instead of borrowing flags from a different version.

## Reverse proxy and containers

Terminate TLS at a trusted proxy or at the application server according to the deployment design. Configure forwarded headers only from trusted proxy addresses; blindly trusting client-supplied `X-Forwarded-For` or scheme headers allows spoofed client identity and incorrect HTTPS redirects. Configure proxy body-size limits and buffering for upload or streaming endpoints. Preserve request IDs while ensuring clients cannot impersonate a trusted internal identifier without validation.

Log to stdout/stderr in structured form for container collection. Emit request method, route template, status, duration, and correlation ID; avoid raw sensitive query values and credentials. Metrics should include latency distributions, error rates, saturation, event-loop lag, pool waits, and worker restarts. Avoid high-cardinality labels such as user IDs or raw paths.

## OpenAPI, docs, and versioning

FastAPI generates OpenAPI from route declarations, models, security metadata, and response descriptions. The default docs pages (Swagger UI and ReDoc) are served by the app unless configured otherwise. Disable them or protect them when the schema is sensitive; documentation endpoints are not the API's security boundary. `openapi_url`, `docs_url`, and `redoc_url` can be configured, but hiding a route is not authorization.

Version APIs deliberately. URI versions such as `/v1` are obvious and easy to route; header or media-type versions can avoid path changes but are less visible and need careful client tooling. Do not change a response field's meaning in place without compatibility planning. Generate and review the OpenAPI document in CI, and treat schema diffs as API changes. Keep deprecation windows, migration notes, and removal dates explicit. FastAPI's generated schema is only as accurate as declarations; direct `Response` objects and undocumented error paths need manual metadata.

## Common mistakes

- Using `--reload` in production or assuming a dev command is a process manager.
- Multiplying workers without accounting for each worker's DB pool and memory.
- Trusting forwarded headers from arbitrary clients.
- Leaving outbound calls without timeouts or assuming a client disconnect cancels blocking I/O.
- Exposing interactive docs and schemas without deciding whether that is intended.
- Treating an OpenAPI path version as sufficient compatibility policy.

## Production notes

Build an immutable image, run it with explicit resource requests and limits, and test the exact container entrypoint. Apply migrations once through a controlled job with rollback planning, not as a race among web workers. Tune worker count, pool sizes, and timeouts under representative load while observing saturation; do not invent universal benchmark numbers. Validate readiness, graceful termination, logs, metrics, and docs in staging. Pin a compatible framework stack and include the deployment command, environment variables, proxy trust settings, and OpenAPI review in the release checklist.

## Readiness, configuration, and failure budgets

Readiness should indicate that a process can accept useful traffic. A startup check can verify critical configuration and required dependencies, but avoid making every liveness probe depend on a database: a database outage should not cause a fleet-wide restart loop if the application can remain healthy and recover. Keep liveness focused on process progress, and readiness focused on whether routing traffic is safe. Probe timeouts and thresholds should tolerate ordinary startup without hiding a hung service. During rollout, ensure a new process becomes ready before old replicas are removed and account for temporary overlap in database connections.

Parse and validate configuration at startup. Missing signing keys, invalid database URLs, or unsupported environment values should fail clearly rather than leaving a server that accepts requests but fails later. Keep environment-specific values out of the image and avoid logging secrets when printing configuration. Use a secrets manager or orchestrator secret facility and define rotation behavior. Configuration should include outbound connect/read timeouts, pool limits, trusted proxy CIDRs, and log level, with safe production defaults.

A service-level objective can guide deployment tuning better than a raw throughput target. Track latency percentiles, error rates, saturation, and dependency availability over a defined window. When a downstream service degrades, bounded concurrency, queue limits, timeouts, and graceful rejection protect the rest of the application. Adding replicas can worsen an overloaded dependency if every new worker opens more connections or retries more aggressively. Perform load tests with realistic request mixes and failure injection, then record the tested configuration; do not generalize one run into a universal worker formula.

Before release, inspect the built image and verify it runs as the intended user, exposes only the necessary port, receives termination signals correctly, and has access only to required secrets. Test the same command and environment contract in CI and staging. This reduces the gap between an application that passes unit tests and a service that actually starts, drains, and recovers in production.