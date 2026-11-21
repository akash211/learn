# Authentication and Authorization

An API security design must answer two distinct questions on every protected request: who or what is making the call, and is that principal permitted to perform this operation on this resource? Authentication (AuthN) establishes or verifies an identity; authorization (AuthZ) evaluates an action against policy. A request can be authenticated and still forbidden. Keeping those decisions separate prevents the common mistake of treating possession of a syntactically valid token as blanket access.

## OAuth 2.0 is an authorization framework

OAuth 2.0, specified by RFC 6749, lets a client obtain an access token representing delegated or application authorization to protected resources. It defines roles such as resource owner, client, authorization server, and resource server, along with authorization grants and token issuance. It does not define a general identity assertion protocol for signing users into an application. OAuth's authorization endpoint authenticates the resource owner as part of a flow, but that authentication mechanism is outside the scope of OAuth itself. For standardized identity claims and sign-in, OpenID Connect adds an identity layer on top of OAuth 2.0.

A common user-delegated web flow is Authorization Code with PKCE. The client directs the user-agent to the authorization server, receives a short-lived code at a registered redirect URI, and exchanges the code at the token endpoint. PKCE binds the code exchange to a verifier created by the client, reducing the value of an intercepted code for public clients. A backend service acting on its own behalf can use Client Credentials when the authorization server policy permits it. Do not build new clients around the legacy implicit or resource-owner-password grants: current OAuth security guidance (RFC 9700) recommends avoiding them in favor of safer flows.

OAuth's access token is a credential for access, not necessarily an identity document. RFC 6749 permits tokens to be opaque or self-contained. A resource server must validate according to the chosen token format and trust model, including issuer, audience, expiry, and signature where applicable. A JWT is a token representation defined by JWT specifications; merely decoding its base64url segments does not verify its signature. Audience restriction prevents a token intended for one API from being replayed to another.

## Bearer tokens and API keys

Bearer access tokens are commonly sent in the `Authorization: Bearer ...` header as specified by RFC 6750. Anyone who obtains a bearer token may be able to use it until it expires or is revoked, so protect it in transit with TLS, keep it out of URLs and logs, scope it narrowly, and use an appropriate lifetime and revocation strategy. Never treat a token as safe just because it is a JWT.

An API key typically identifies a project, integration, or calling application and is often used for service access, metering, or low-risk public APIs. It is not automatically a user identity or proof of a specific human. Keys copied into browser or mobile code are extractable and must not be treated as secrets. A key may be combined with user authentication or network controls, but the server should authorize the actual requested resource independently. Provide rotation and revocation, store only a verifier where feasible, and avoid placing keys in query strings.

## Scopes and object-level decisions

OAuth scopes are coarse permissions granted to a client, for example `orders:read` and `orders:write`. They help constrain what a token can do, but they rarely answer whether this user may read order `o_123`. The API must also enforce tenant, ownership, relationship, and business-state rules for the target object. Apply authorization on every item and nested-resource access; collection filtering must not be the only security boundary. Check both the requested action and the resource's current state, and avoid leaking whether a forbidden object exists if the threat model calls for indistinguishable 404 responses.

Use least privilege. Separate read, write, and administrative capabilities; do not issue all clients a broad “api” scope simply to reduce configuration work. A denied request normally uses `403 Forbidden` when identity is known but policy refuses it, and `401 Unauthorized` when valid authentication is missing or unacceptable; a 401 response includes `WWW-Authenticate`. Apply a consistent policy for expired tokens and refresh behavior, and do not send a caller's access token to a downstream service unless that audience and delegation are intended.

## Key handling and threat boundaries

TLS protects credentials in transit but not after they reach logs, traces, browser storage, crash reports, or support tickets. Redact authorization headers at every hop. Keep signing keys in managed secret storage, rotate with a period where old and new keys can both be validated, and make the trusted issuer and algorithms explicit. Do not accept an arbitrary algorithm or key URL from an untrusted token header. Rate-limit credential endpoints and monitor unusual token failures without recording the secret itself.

## Common mistakes

- Saying “OAuth authenticates users” when the protocol primarily delegates authorization.
- Confusing an ID token from OpenID Connect with an OAuth access token for an API.
- Accepting any JWT that parses, without verifying signature, issuer, audience, expiry, and policy.
- Assuming `orders:read` authorizes access to every order ID in the database.
- Treating a client ID or public API key as a confidential secret.
- Using long-lived bearer tokens with broad scopes and no revocation plan.
- Putting credentials in query strings that are copied into logs and histories.

## Production notes

Write an authorization matrix that maps principal types, actions, resources, and state conditions; turn it into tests for both allowed and denied paths. Test cross-tenant IDs explicitly. Document token audience, scopes, expiry behavior, key rotation, and which party owns refresh. For public clients, store tokens using platform-appropriate secure mechanisms and avoid shipping client secrets. Security architecture varies by client and threat model; do not copy a flow diagram without verifying redirect handling, PKCE support, issuer validation, and resource-server checks end to end.

## Authentication is not only a token check

A token check answers whether a credential is acceptable according to an issuer and policy; it does not prove that the caller is a human or that every claim is true for the requested action. User sessions, workload identities, mutual TLS, and signed assertions address different trust relationships. Choose the mechanism appropriate to the client: an interactive application needs a user delegation flow, while a scheduled service may use a workload identity. Avoid passing a user's browser token through every service merely for convenience. Where a downstream call must act on behalf of a user, use an explicit delegation or token-exchange design with an audience and scope limited to that destination.

Authentication and authorization failures should be auditable without logging secrets. Record a stable principal identifier only where permitted, the policy decision, resource class, and correlation ID. Keep audit logs distinct from diagnostic logs and control access to them. Test revoked credentials, key rotation overlap, clock skew around expiry, malformed claims, disabled accounts, and permissions changed while a long-lived token remains valid. Token revocation and authorization freshness are related but different: a short-lived token may reduce stale claims, while sensitive permissions may need an online policy check on each request.
