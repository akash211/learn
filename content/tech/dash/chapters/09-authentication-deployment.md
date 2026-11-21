# Authentication and Deployment

A Dash application is a web service, even when its audience is an internal team. Authentication determines who the user is; authorization determines what that user may see and do. Deployment determines whether requests are routed correctly and whether the app can serve concurrent users reliably. Treat all three as application architecture, not as styling or a final hosting checkbox.

## Authentication and authorization

A common deployment places Dash behind an identity-aware reverse proxy or gateway that authenticates users and forwards trusted identity claims to the app. Another option is Flask-compatible authentication integrated with the underlying Flask server. The right choice depends on the organization's identity provider and session model. In either case, verify the mechanism on the server and establish which headers or session values are trusted. A header supplied directly by an internet client is not trustworthy unless a proxy strips incoming copies and injects a verified value.

Authorization belongs in server-side data-access and action paths. A hidden button, disabled component, or omitted menu entry is only a UI affordance. A caller can invoke a callback request with modified values. Every callback that retrieves sensitive data or performs a write should enforce the user's scope using a trusted identity and a policy decision. Re-check permission when a background job runs, not only when it is queued, if authorization may change.

Avoid storing tokens, credentials, or sensitive records in `dcc.Store`, URLs, or callback output properties. Browser storage is inspectable by the user. Use secure session cookies with appropriate `HttpOnly`, `Secure`, and `SameSite` settings where applicable; terminate TLS at a trusted boundary; and review CSRF protections for state-changing operations. Session and identity integration is deployment-specific and should be validated against the actual proxy and Flask setup.

## WSGI deployment and Gunicorn

Dash exposes the underlying Flask server as `app.server`. A WSGI server such as Gunicorn imports that object and serves requests. A typical process target is `module:app.server`, adjusted for the module name and packaging. Do not run `app.run()` as the production process. Use a process manager/container command that starts Gunicorn in the foreground and handles termination signals.

Worker count is not a magic formula. Each worker has its own Python memory, connection pools, and in-process caches. More synchronous workers can increase concurrent requests until CPU, database connections, memory, or downstream services become the bottleneck. Measure callback latency and deployment resource use; set worker and thread options deliberately for the workload and the selected worker class. Increasing worker count can multiply database pool limits and worsen overload. For background callbacks, operate a separate queue worker and its broker/backend alongside the web process.

## Containers and configuration

A container image should install pinned dependencies, include app code and assets, and run as a non-root user where feasible. Keep secrets out of the image and source tree; inject configuration from the deployment environment or secret manager. Add a health check that distinguishes process liveness from meaningful readiness. Readiness can include required dependencies, but avoid making a transient database issue restart every app container in a loop.

Log to stdout/stderr in a structured form and include request/callback correlation information that does not expose sensitive payloads. Configure graceful shutdown and request timeouts in line with normal callback duration. Long jobs should not be allowed to hold web worker slots indefinitely; use a background manager and report progress/status.

## Reverse proxies and URL prefixes

A proxy may terminate TLS, serve a URL prefix, set forwarded scheme/host headers, and route requests to the application. Configure trusted proxy headers only for the known proxy hop; trusting arbitrary forwarded headers can create host or scheme spoofing. When the app is mounted under a prefix, Dash's `requests_pathname_prefix` and `routes_pathname_prefix` need to align with the proxy's forwarding behavior. Incorrect prefixes often appear as missing assets, failed callback requests, or broken deep links while the root page seems to load.

Set allowed host/origin behavior appropriate to the environment, and ensure WebSocket or long-polling requirements are accommodated if using features that depend on them. Test login redirects, static assets, callbacks, deep links, and trailing slashes through the real proxy, not only by calling the container port directly.

## Common mistakes

- Treating client-side visibility as authorization.
- Trusting identity headers from an untrusted source.
- Deploying Flask's development server in production.
- Multiplying worker count without accounting for database pools and memory.
- Baking secrets into images or logging raw callback payloads.
- Configuring a URL prefix in the proxy but not in Dash, or vice versa.

## Production notes

Use least-privilege service identities, rotate secrets, and establish a patch process for Dash, Flask, Plotly, and component dependencies. Add an authenticated smoke test that exercises a protected route through the public ingress. Define separate readiness and liveness checks, graceful shutdown behavior, and resource limits. Ensure dashboards reflect their authorization boundary consistently: filtering data in one callback but forgetting a download or export callback is a common leakage path. Review access control across every output path, not just the most visible chart.

## Release and operational controls

Deployments should make configuration explicit and auditable. Separate local, test, staging, and production settings, but keep the same application code path. Validate required environment variables at startup and fail clearly if a mandatory secret or backend URL is missing. Avoid printing environment dumps because they often contain credentials. Run database migrations as a controlled release step rather than independently in every web worker. A container's entrypoint should use `exec` so the WSGI process receives termination signals and can shut down cleanly.

Capacity planning includes web requests, background queue workers, database pools, and memory per process. A container with several workers can multiply per-process pools; a deployment scaled to several replicas multiplies them again. Record the effective configuration at startup with secrets omitted. Monitor worker restarts, request timeouts, pool wait time, queue depth, and response status. Define how the service behaves when Redis, the database, or the identity provider is unavailable. Readiness should prevent traffic from reaching an unready instance, while liveness should detect a stuck process without causing a fleet-wide restart during a downstream outage.

Security review should cover not just login but also exports, downloads, cached results, error messages, and job status endpoints. A download route that bypasses the callback's authorization check can defeat an otherwise correct dashboard. Do not include sensitive identifiers or query text in public URLs or logs unless the retention and access controls are understood. Rotate credentials and review dependency updates for Dash, Flask, Plotly, component packages, and the WSGI stack. Finally, test a graceful rollout with active users and a queued job; it reveals whether sessions, callbacks, and background work survive normal container replacement.

