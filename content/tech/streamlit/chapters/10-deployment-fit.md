# Deployment, Security, and Choosing the Right Tool

A Streamlit app is a Python server that serves a browser UI and maintains session execution state. Deployment therefore includes more than copying a script: dependency management, secrets, network access, identity, proxy behavior, process limits, and data lifecycle all matter. Community Cloud reduces setup for suitable repositories; a container gives more control but transfers operational responsibility to the team.

## Community Cloud or a container

Streamlit Community Cloud can deploy an app from a GitHub repository and is convenient for demos, educational apps, and lightweight projects. The platform manages much of the runtime setup and offers logs and app management. It is a hosted environment with resource and operational constraints that can change; consult its current resource-limit documentation before sizing a production workload. Do not hard-code a numeric memory or CPU promise based on an old blog post.

A container deployment packages Python, dependencies, and app code into a reproducible image. It can run on a VM, Kubernetes, or a managed container service. This gives control over networking, scaling, secrets, and observability, but the operator must configure health checks, restart behavior, resource requests/limits, TLS termination, updates, and logging. Use a pinned dependency set and build the same artifact for testing and production. Do not run as root unnecessarily, and keep secrets out of image layers.

The Streamlit process maintains session state in memory. Scaling horizontally or restarting workers can interrupt in-memory sessions unless the routing and platform behavior support the app's session requirements; do not assume a durable workflow survives. Persist important records and jobs outside the app process. Size concurrency and database pools together rather than scaling the frontend until the database is overloaded.

## Reverse proxies and networking

Streamlit uses a persistent browser connection and its own server protocol. A reverse proxy or ingress must support the required WebSocket upgrade and route the app's HTTP and WebSocket traffic correctly. Set the public base path and forwarded headers only when the deployment topology requires it, and verify the actual configured host/proxy behavior. Configure proxy idle/read timeouts to accommodate the intended session, but do not use excessive timeouts to disguise a blocked app. Restrict direct access to the backend port if traffic should enter only through the proxy.

Test login, page navigation, uploads, downloads, reconnects, and long-lived idle sessions through the production proxy. A page that works on localhost may fail behind a path prefix or load balancer. Terminate TLS at a trusted edge and ensure forwarded headers cannot be spoofed by untrusted clients.

## Authentication and authorization

A Streamlit app can be shared publicly or placed behind identity-aware infrastructure; the right approach depends on its audience and data. Community Cloud provides platform sharing controls, but app-level authorization requirements still need to be designed. For a container, integrate a trusted identity provider or an identity-aware proxy. Streamlit's hidden pages and widget conditions are not authorization controls.

The app must associate requests with a verified principal and enforce access checks in every data operation. Do not trust a user ID, tenant, or role from a widget, URL parameter, or mutable Session State value. Apply least privilege to database credentials. Keep secrets in the platform's secret store and restrict who can view or edit them. Use CSRF and session protections provided by the actual proxy/auth solution; do not invent a home-grown login form that stores plaintext passwords in Session State.

## Configuration and dependencies

Pin dependencies in a lockfile or rigorously maintained requirements file. Streamlit integrations and APIs evolve; test against the same version you deploy. Store app-specific settings in `.streamlit/config.toml` where suitable, but distinguish nonsecret configuration from secrets. Provide a reproducible setup command and check that the entrypoint runs from the packaged working directory.

`streamlit run app.py` is the usual local command. A container should execute the app as its foreground process so signals and exit status are handled correctly. Configure health checks to distinguish process readiness from a functioning upstream dependency. Capture logs to stdout/stderr where the platform expects them, and avoid logging credentials or private query results.

## Limits and resilience

Every deployment has limits: memory, CPU, connection count, request size, idle timeouts, and platform-specific quotas. They are not universal Streamlit constants. Read the current docs for the chosen host, then set explicit app and infrastructure limits. `st.file_uploader` has a configurable server limit and a per-widget option in current API; the proxy may impose its own maximum. Align all layers and tell users the actual supported limit. Apply query timeouts and cap concurrent work.

A Streamlit server process is not a durable job scheduler. For tasks that must continue after a browser closes, use a queue/worker and external status store. Keep the UI responsive and poll responsibly. Plan graceful shutdown and idempotent job retry behavior. For apps with long-lived sessions, test how deploys and autoscaling affect users.

## When Streamlit is the wrong tool

Streamlit is a strong fit when Python logic and data exploration dominate, the app can follow rerun semantics, and a small team values a short path to an internal tool. It is a weaker fit when the product needs highly custom responsive interactions, a large anonymous public audience with complex auth, extensive client-side offline behavior, fine-grained page rendering, rich collaborative editing, or stringent request/latency guarantees. It also should not be the only place to run durable workflows, expose a stable public API, or enforce business-critical authorization.

Alternatives solve different needs. Dash provides an explicit component/callback model for dashboards. FastAPI can serve a typed API, with a dedicated frontend for custom UX. A notebook may be enough for a trusted analyst workflow; a BI platform may be better for governed self-service reporting. The decision is not a popularity contest: compare UI complexity, access control, concurrency, deployment operations, and data scale.

## Common mistakes

- Treating Community Cloud resource limits as permanent numeric guarantees.
- Assuming a reverse proxy works without WebSocket support and correct path configuration.
- Using hidden pages or widget conditions instead of authorization checks.
- Keeping important job or approval state only in session memory.
- Scaling Streamlit workers without considering database pool and session implications.
- Choosing Streamlit for a public product whose core needs a custom, highly interactive client.

## Production notes

Threat-model the app as a server with access to its configured credentials and data. Pin dependencies, review updates, enforce network boundaries, and test through the deployed proxy and identity layer. Monitor errors, latency, active resource use, and upstream dependencies. Choose managed simplicity when the workload fits its documented constraints; choose containers when operational control is necessary and the team is ready to own it. Revisit the tool choice as the product—not just the prototype—takes shape.