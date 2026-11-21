# Packaging, Deployment, Registries, and Versioning

MCP deployment depends on whether a server is a local subprocess or a remote service. Packaging must make the executable, dependencies, configuration, credentials, protocol version, and operational expectations reproducible. A server that works from a developer shell can still fail when a desktop host launches it with a different working directory or when a proxy buffers its HTTP response.

## Package for a known runtime

For Python, define the supported interpreter range, lock dependencies, and expose a clear entry point. Pin a compatible SDK release, and review its current major-version migration notes. Build wheels or container images reproducibly, scan dependencies, and produce a software bill of materials where required. Sign release artifacts or use trusted package channels according to organizational policy. A fast-changing SDK should not be pulled from an unconstrained “latest” version at startup.

A local stdio server is commonly installed or launched by a host. Provide a stable executable or module command, document required configuration, and keep stdout reserved for protocol messages. Avoid shell command strings assembled from user-controlled input. The process should use a restricted OS identity, minimal environment, explicit working directory, and only necessary filesystem access. Desktop host configuration can itself contain command arguments and secrets; review how updates are distributed and how users confirm trust.

For remote deployment, a container or managed service can provide consistent dependencies and scaling. Use a minimal base image, non-root user, read-only filesystem where possible, health checks, and bounded CPU/memory. Do not bake secrets into image layers. Inject credentials from a secret manager at runtime or use workload identity. Separate build-time and runtime settings and verify that logs do not include request secrets.

## Configure transport deliberately

Set the transport explicitly, rather than relying on an SDK default that may change. A remote service needs a known bind address, port, TLS termination arrangement, authentication middleware or supported authorization layer, and route configuration. If a gateway terminates TLS, restrict direct access to the application and validate forwarded identity headers from that gateway. Set proxy read timeouts compatible with streaming behavior and avoid response buffering where the protocol requires streaming.

Provide graceful startup and shutdown. Create database pools and HTTP clients in the server lifespan and close them reliably. Use finite timeouts and concurrency controls. Readiness should mean dependencies required to serve calls are usable; liveness should indicate the process can continue, not merely that a database is healthy. Avoid making a health endpoint expose secrets or private service information.

## Registries and discovery

MCP registries can help users discover server packages or remote integrations, but inclusion is not a guarantee of security or quality. Registry metadata and publication processes vary. Before installing a server, verify its publisher, source, release history, permissions, dependencies, transport, and requested credentials. For internal catalogs, define who may publish, how versions are approved, and how compromised integrations are revoked. Pin an artifact digest or version where possible, and establish a provenance record.

A registry listing is distinct from protocol capability discovery. A package registry helps find a server; protocol-level discovery tells a connected client what a running implementation supports. Do not conflate one with the other or treat protocol-reported identity as cryptographic proof of publisher identity. Trust comes from distribution and deployment controls, authenticated endpoints, and review.

## Versioning and compatibility

There are at least three version dimensions: the MCP specification revision, the SDK implementation version, and the server's own application/API version. A host's version adds another compatibility dimension. Document them separately. A server SDK may support several spec revisions or expose a high-level abstraction that hides some differences. A working compile is not proof that a target host supports every capability or transport.

Version changes can affect lifecycle handshakes, HTTP transport names, authorization, structured content, error shapes, or SDK import paths. Some details are genuinely version-dependent. Pin a known-compatible SDK and define a support policy, such as a tested minimum host set and a migration window. Avoid relying on experimental extensions without fallback behavior. Before an upgrade, compare versioned specifications and SDK migration notes, regenerate schemas, and run protocol and transport tests.

For breaking changes to your tool contract, use a staged rollout: introduce a new tool or versioned schema, support a transition where feasible, notify hosts, and remove the old surface only after usage is understood. Renaming a tool can alter model behavior even if the underlying API is unchanged. Treat descriptions as part of the compatibility surface.

## Operations and rollout

Use staged deployments and canaries for remote servers. Monitor request volume, latency, error categories, backend saturation, auth denials, and per-tenant quotas. Do not log full prompt context or token values. Add rollback procedures that account for schema and authorization changes, not just container images. For local servers, release notes and host-specific installation tests are the equivalent of a canary: hosts may cache command paths or be slower to upgrade.

If a server is compromised or a credential exposed, operators need a fast disable path: revoke tokens, remove a registry entry or block its digest, deny the endpoint at a gateway, and alert affected users. Document ownership and escalation. Keeping an integration in an internal package index does not remove the need for a kill switch.

## Common mistakes

- Leaving the SDK unpinned and assuming the latest major release is compatible.
- Publishing a package without provenance, version policy, or permission documentation.
- Baking credentials into a container or providing excessive environment variables to stdio children.
- Treating a registry listing as a security review or as live capability discovery.
- Deploying behind a proxy that buffers streams or strips required headers.
- Changing tool names or schemas without testing the hosts and model behavior that depend on them.

## Production notes

Every release should identify artifact digest, SDK version, supported spec revisions, transports, required scopes, data classification, and owner. Automate smoke tests against a real client in the deployment path and validate that rollback restores both code and policy. Define the process to rotate secrets, revoke a server, or respond to a compromised dependency. Keep deployment manifests and host configuration under review. Packaging is part of the security boundary: it determines which code runs, with which privileges, and how quickly the organization can respond when trust changes.

## Change management

A release should have a named approver for both software and data permissions. Keep a record of which artifact digest is deployed in each environment and compare it to the reviewed build. Make configuration drift detectable, especially for credential scopes, proxy trust, and tool enablement. Where local host configuration is user-managed, publish supported examples and warn about deprecated fields rather than silently changing privilege. A staged rollout is useful only if operators can see errors and revert promptly.
