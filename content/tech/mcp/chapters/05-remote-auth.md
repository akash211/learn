# Authentication and Permissions for Remote Servers

A remote MCP server is a network service that may expose access to data or actions. It needs a clear model for who is connecting, what identity the server uses downstream, and how each invocation is authorized. MCP's protocol defines interoperable patterns, but the exact HTTP authorization requirements vary by specification revision and SDK. Follow the pinned version's authorization specification rather than assuming a particular OAuth flow or header is universal.

## Authentication identifies; authorization decides

Authentication establishes a principal: a user, workload, or client. Authorization decides whether that principal can list, read, or invoke a particular capability on a particular object. Passing authentication is not enough. A user who may read one tenant's issues must not be able to obtain another tenant's issues by changing a tool argument. Enforce object- and tenant-level checks on every operation, ideally in the domain service or data query and not only in a client UI.

A server that validates a bearer token should verify it through a trusted issuer or cryptographic configuration, including signature, issuer, audience, expiry, and relevant scopes or claims. Do not decode a JWT and treat its contents as trusted. Use maintained libraries and key rotation processes. A token meant for a different API should not be accepted just because it is syntactically valid. Audience binding and resource indicators are important defenses against token substitution and confused-deputy problems.

The specification's OAuth authorization model and metadata discovery have evolved. Some versions describe MCP servers as OAuth resource servers, protected-resource metadata, and authorization-server discovery. Client registration and flow requirements may also change. Recheck current normative text for the actual protocol version and deployment; avoid publishing a hand-built “MCP OAuth” shortcut based on a blog post. In all cases, the server needs to validate a token intended for that resource and bind its authorization decision to the request.

## Delegated user versus service identity

There are two common patterns. In delegated access, the remote server receives or exchanges credentials that represent the user's authority, so downstream calls are constrained to what the user can do. In service identity, the MCP server uses its own workload credential and implements its own mapping from the authenticated caller to allowed records and actions. Neither pattern is universally right, but the choice must be explicit.

Service identity is operationally convenient, but becomes a confused deputy if the server holds broad credentials and accepts a caller's request without enforcing the caller's narrower rights. Delegation can preserve downstream policy but introduces token exchange, scope management, and expiration handling. Never accept a token supplied as a normal tool argument and forward it to an arbitrary service. The host or authenticated transport should carry credentials through a trusted mechanism, and the server should avoid logging or returning them.

For multi-tenant services, derive tenant identity from a validated principal or trusted authorization context, not from an untrusted tool argument alone. If the request includes a tenant selector, verify the principal may act on that tenant. Apply the check to reads as well as writes; listing and search operations often leak data even when mutations are blocked.

## Transport and credential handling

Use TLS for remote connections and terminate it only at a trusted boundary that preserves authenticated identity to the server. If a proxy adds identity headers, prevent direct access that could let clients forge those headers, and authenticate the proxy-server hop. Do not expose a plaintext development listener to a public network. Store secrets in an approved secret manager or platform identity facility; avoid hardcoding them in source, container layers, launch configuration, or shared environment files.

The exact transport may support HTTP bearer tokens or an OAuth-based authorization flow, but the implementation must conform to its supported version. Validate scopes and audience, handle token expiry predictably, and avoid leaking detailed authentication errors. API keys can be useful for controlled service clients but usually offer weak user attribution and coarse revocation; if used, make them high entropy, scoped, rotated, and securely stored. Do not mistake CORS for access control; it is a browser policy, not proof of caller identity.

## Permission granularity

Permissions should map to capabilities and business data. A read-only reporting integration can use a database principal that cannot write. A billing tool might separate invoice lookup from refund issuance, each with distinct scopes and approval rules. If the host can show different users different tools, use that as a usability aid, but still enforce the rule in the server. Dynamic tool listings are not a substitute for denying forbidden calls.

Avoid broad “admin” scopes for routine tasks. Define a small set of actions, use least-privileged roles, restrict resource and tenant access, and make high-impact operations require explicit user confirmation or a separate approval workflow. For automation, use a workload identity, narrow permissions, and observable change controls. Ensure emergency revocation and credential rotation can happen without code changes.

## Errors, logs, and abuse resistance

Return generic authentication errors that do not reveal whether an account, tenant, or secret exists. Differentiate unauthenticated from authenticated-but-forbidden behavior according to the service's privacy policy. Rate-limit both by principal and by expensive operation; protect login or token exchange paths separately. Apply request-size limits and finite downstream timeouts.

Audit identity, capability name, target object or tenant where safe, decision, correlation ID, and outcome. Never log access tokens, secret arguments, or unredacted personal data by default. Logs need access controls and retention limits too. Monitor repeated denials, unusual call volumes, and cross-tenant access attempts, but avoid treating model text as a reliable security signal.

## Common mistakes

- Treating a valid token as proof the caller may access every tenant or object.
- Using a server's broad service credential without mapping caller permissions.
- Accepting tokens in tool arguments and forwarding them to arbitrary destinations.
- Trusting identity headers from an untrusted network path or assuming CORS is authentication.
- Relying on the host to hide unauthorized tools without server-side enforcement.
- Following a stale OAuth recipe without checking the chosen MCP specification revision.

## Production notes

Document whether identity is delegated or service-based, what token audience is expected, how scopes map to operations, and how user identity is propagated. Test token expiry, wrong audience, wrong tenant, revoked permissions, missing scopes, and forged headers. Perform authorization on reads, writes, and discovery results. Review logs for accidental secret capture and prove that credential rotation and revocation work. Authentication is one part of the contract; per-invocation authorization is the control that protects the data.

## Operating the identity boundary

Identity propagation should be observable end to end. Correlate the inbound principal with downstream requests without copying bearer values into traces. When a service cannot pass user identity downstream, make the mapping explicit and reviewable, and prefer narrowly scoped roles over informal allowlists. Test that a stale group membership or revoked role takes effect within the documented interval. These details matter during incident response because token issuance, gateway policy, and service caches can each delay revocation.
