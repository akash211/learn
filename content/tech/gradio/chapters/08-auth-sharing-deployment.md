# Authentication, Share Links and Deployment

A Gradio app can be private, shared temporarily or deployed as a long-lived service. These are different security postures. The fact that an interface is easy to publish does not mean the default launch settings are suitable for sensitive data or production traffic. Choose the exposure model first, then configure authentication, network boundaries, file access and operational controls around it.

## Local development and temporary sharing

`demo.launch()` starts the app for local use. The options available include host, port, authentication and sharing behavior; check the installed release's documentation rather than copying flags from an old snippet. A share link creates a route for external users to reach an app running in your environment through a tunnel or relay mechanism. It is convenient for a review or demonstration, but it is not a production hosting plan, an uptime promise, or a substitute for access control.

Do not enable a public share link for an app that can access private files, credentials, internal services or untrusted model actions unless the exposure is intentional and controlled. Keep secrets out of examples, callback output, logs and frontend configuration. A public user may submit malicious input or repeatedly invoke an expensive function. Restrict access and resource use according to the actual risk.

## Authentication is not authorization

Gradio supports simple launch-time authentication configurations for basic access gating, with details dependent on version. This can be useful for a small demo, but a static username/password pair is not a complete user-management system. It does not by itself provide roles, organization membership, per-record ownership or a policy for revocation and audit. For a real product, integrate with an identity-aware gateway or application authentication design, and enforce authorization in the server-side code that touches protected data.

Authentication must cover all relevant entry points: browser UI, generated API endpoints, file access paths and any custom FastAPI routes. Test unauthenticated requests directly rather than only opening the page in a browser. If mounted under FastAPI, understand how middleware and Gradio's own auth options interact. Avoid assuming that a reverse proxy rule protects a route when alternate paths or direct service access exist.

Passwords and tokens belong in a secret manager or deployment environment, not in source control. Use TLS at the public boundary. Set secure cookie and proxy behavior according to the chosen deployment stack. Do not log credentials, session cookies, raw prompts or uploaded content by default.

## Deployment shapes

A simple deployment runs Gradio as a Python web process in a container or managed hosting service. A more integrated deployment mounts Blocks into FastAPI. A production model workload may use a dedicated inference server behind a lightweight Gradio front end. Each shape changes process lifetime, scaling, GPU allocation and state behavior. Choose based on how the app will be operated, not only on how quickly it can be launched.

Set the bind host and port as the platform expects; a service bound only to loopback may not be reachable through a container ingress. Expose only the necessary port. Use the platform's health checks and readiness behavior, and account for slow model initialization. A process that has opened a socket may not yet be ready to serve inference. The deployment should fail visibly if required weights or configuration are unavailable rather than silently running a broken demo.

Pin Gradio and model dependencies, build reproducible images, and avoid downloading unpinned model code at startup. Keep model artifacts separate from application secrets. If a GPU is required, verify driver/runtime compatibility and schedule the process onto a suitable device. Do not increase web worker count blindly; each worker may allocate its own model and GPU memory.

## Files, network and abuse controls

Review allowed file paths and outputs so the app serves only intended artifacts. A model checkpoint, source directory or environment file should never become downloadable just because a broad path was added to solve a file preview issue. Temporary generated files need cleanup. If user uploads are persisted, isolate users' namespaces and enforce authorization on retrieval.

An accessible app can be abused through large or repeated uploads, computationally expensive requests, prompt injection against connected tools, or malformed media. Apply input validation, rate limiting at an appropriate edge, concurrency control, timeouts and quotas. A UI button disabled during a job is not a rate limiter. If a callback can reach internal URLs or execute tools, add strict allowlists and isolate that capability; user-provided prompts are untrusted instructions.

## Observability and updates

Capture request-level duration, errors, queue wait and resource use without storing sensitive payloads unnecessarily. Expose health and readiness through the deployment's intended route. Plan how to roll back a bad dependency or model update and whether active sessions will be interrupted. Persist important user work outside process memory. Check that logs and crash reports do not include authentication data or temporary filesystem paths that reveal internals.

## Common mistakes

- Treating `share=True` as a secure deployment or a stable public hosting service.
- Using a basic username/password gate as a replacement for per-user authorization.
- Protecting the page but leaving API endpoints or file paths accessible.
- Binding to an interface or port that the hosting platform cannot route to.
- Scaling worker processes without accounting for duplicate model memory and GPU contention.

## Production notes

Before launch, decide who can reach the app, what data it can access, what the maximum workload is and where artifacts live. Test from outside the trusted network, including API calls and file downloads. Separate demonstration conveniences from production controls. Gradio makes exposure easy; responsible deployment still depends on networking, identity, validation, monitoring and resource policies chosen for the application.

## Define the trust boundary before mounting tools

An app that can call internal APIs, query a database or execute model tools has capabilities beyond rendering a form. Treat user-entered prompts and uploaded documents as untrusted data, even if the audience is an internal team. If a model can choose a tool or URL, enforce server-side allowlists and permissions; do not let a prompt determine arbitrary network destinations or file paths. Use a least-privilege service identity and limit the data it can reach.

For a team demo, write down what the app can access and who can trigger those actions. For production, review that list whenever new callback events are added, because every listener can become another invocation path. Authentication identifies the caller; the callback must still enforce which operations that caller may perform. This simple capability inventory often catches a more serious risk than a styling or deployment setting.

Keep development and production configurations visibly distinct. A debug setting, open share link or permissive CORS rule that helped a teammate test locally should not silently follow the app into a public environment. Use deployment-specific configuration and review the effective settings after startup, including proxy and environment-variable overrides. A concise runbook should identify how to revoke access, disable a problematic event and roll back a release.
