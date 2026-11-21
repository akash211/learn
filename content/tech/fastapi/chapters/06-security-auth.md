# Security and Authentication Dependencies

Authentication answers “who is making this request?” Authorization answers “may that principal perform this action?” FastAPI helps express both through dependencies and OpenAPI security schemes, but it does not provide a complete identity system, token issuer, password store, or authorization policy. Those boundaries must be designed and tested explicitly.

## OAuth2 password flow and bearer tokens

FastAPI's `OAuth2PasswordBearer` describes a bearer-token security scheme and extracts the `Authorization: Bearer ...` value. Despite its name and the token URL metadata, it does not implement a token endpoint, authenticate users, hash passwords, sign JWTs, or validate token claims. OAuth2's Resource Owner Password Credentials grant is deprecated by current OAuth security guidance and should not be chosen for new user-facing systems. Existing examples may use it for first-party or educational flows; prefer an authorization-code flow with PKCE for interactive users, or a client-credentials flow for machine identities, using an established identity provider.

A protected API still needs a well-defined token validation component. If accepting JWTs, verify the signature with an explicitly allowed algorithm and trusted key source; validate issuer, audience, expiry, not-before, and any required subject or scopes. Do not trust a decoded token before cryptographic verification, allow the token header to select an arbitrary algorithm, or fetch keys from an untrusted URL. Handle key rotation and short-lived access tokens deliberately.

```python
from typing import Annotated
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

bearer = OAuth2PasswordBearer(tokenUrl="/token")

async def current_principal(token: Annotated[str, Depends(bearer)]):
    claims = verify_access_token(token)  # application/provider-specific verification
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Principal(id=claims.subject, scopes=claims.scopes)
```

The `verify_access_token` placeholder is intentionally not an implementation: cryptographic and identity-provider details should use a vetted library and configured issuer keys. Return 401 for missing or invalid authentication with an appropriate challenge; use 403 when an authenticated principal lacks permission. `OAuth2PasswordBearer` normally returns 401 when the bearer credential is absent unless configured to be optional.

## API keys and other credentials

API keys can be carried in headers, query parameters, or cookies, but a header is generally preferable because URLs are commonly recorded in browser history, proxy logs, and analytics. FastAPI's `APIKeyHeader`, `APIKeyCookie`, and related utilities extract credentials and describe the scheme in OpenAPI; they do not make keys secure on their own. Store only a hash of long-lived keys where feasible, compare safely, support revocation and rotation, and associate keys with an owner, scope, and rate policy. Never commit real credentials or place them in source-control examples.

All credentials require TLS in transit. Avoid logging authorization headers and redact secrets from error reporting. Use constant-time comparison for secrets where applicable, but do not treat constant-time comparison as a substitute for TLS, storage discipline, or rate limiting. Short-lived credentials, restricted scopes, and a revocation strategy reduce exposure when a key is leaked.

## Authentication dependencies and authorization

A `current_principal` dependency centralizes token parsing and identity lookup. A separate policy dependency can check scopes or resource ownership. Keep authentication and authorization distinct: having a valid token does not imply access to every tenant, record, or operation. Check object-level authorization on every request that uses a caller-supplied identifier; otherwise an attacker may change `/documents/123` to `/documents/124` and read another user's object.

```python
from fastapi import Security
from fastapi.security import SecurityScopes

async def require_scopes(
    security_scopes: SecurityScopes,
    principal: Annotated[Principal, Depends(current_principal)],
):
    missing = set(security_scopes.scopes) - principal.scopes
    if missing:
        raise HTTPException(status_code=403, detail="Insufficient scope")
    return principal

@app.get("/reports")
async def reports(
    principal: Annotated[Principal, Security(require_scopes, scopes=["reports:read"])],
):
    return await service.reports_for(principal)
```

This illustrates scope wiring; the principal and verification logic are application-defined. Security scopes can be represented in OpenAPI, but documentation is not enforcement unless a dependency checks the required scopes. Add tenant and ownership checks in the data-access or service path that has the relevant resource context.

## Passwords, sessions, and browser clients

If an application manages passwords, use a deliberately slow password-hashing scheme from a maintained security library with unique salts and operationally appropriate parameters. Never encrypt passwords reversibly or store plaintext. Rate-limit login and recovery flows, avoid account-enumeration differences, and provide secure password reset and credential revocation. For browser-based sessions, consider secure, HttpOnly, appropriately SameSite cookies and CSRF defenses for state-changing requests; bearer tokens stored in browser-accessible storage have different XSS exposure.

Use an identity provider where possible instead of implementing OAuth protocol endpoints from scratch. If FastAPI serves an OAuth redirect or token exchange, review the exact flow, redirect URI validation, state, PKCE, token audience, and storage model. The tutorial-style password form in framework documentation demonstrates dependency wiring, not a recommendation to deploy that grant for modern interactive authentication.

## Common mistakes

- Thinking `OAuth2PasswordBearer` verifies a JWT or implements a token endpoint.
- Decoding a JWT and trusting its claims without verifying signature and issuer.
- Returning 401 for an authenticated user who lacks permission; that is normally a 403.
- Checking only route access and not tenant/object ownership.
- Sending API keys in query strings, logging bearer tokens, or storing passwords directly.
- Treating OpenAPI scopes as runtime enforcement without a policy dependency.

## Production notes

Threat-model credential issuance, validation, storage, transport, rotation, and revocation. Set token issuer, audience, algorithms, and key source in configuration rather than trusting token-controlled metadata. Test absent, malformed, expired, wrong-audience, wrong-issuer, insufficient-scope, and cross-tenant cases. Review dependencies when upgrading security libraries and identity providers. Authentication is an externally exposed boundary: security review and current OAuth guidance take precedence over convenience examples.

## Token lifecycle and browser considerations

An access token is a bearer credential: anyone who obtains it may be able to act as its subject until expiry or revocation. Keep access tokens short-lived enough to limit exposure, while avoiding refresh-token designs that cannot be revoked or protected. Store signing keys in a secret manager or managed identity service, restrict which services can access them, and plan key rotation before an incident. When using a JWKS endpoint, cache keys safely, refresh on an unknown key identifier under bounded conditions, and do not allow a token to redirect the verifier to arbitrary key material. Token claims should be minimal; putting sensitive personal data in a signed but unencrypted JWT exposes that data to anyone who can read it.

Browser threat models differ from native clients and machine identities. An HttpOnly cookie reduces direct JavaScript access to the credential but does not remove cross-site request forgery risk; SameSite settings and CSRF defenses for state-changing requests should be considered. A bearer token stored in local storage can be read by injected JavaScript, making XSS especially consequential. CORS is not authentication: it controls which browser origins may read responses and does not stop non-browser callers from making requests. Apply authorization on the server regardless of the request's Origin header.

A security dependency should fail closed when identity-provider configuration is missing or token verification fails. Do not silently skip verification in production due to a timeout retrieving keys. Cache trusted keys according to issuer guidance and expose operational metrics for verification failures without logging token contents. Maintain an emergency procedure to disable a compromised key or revoke affected credentials, and test the procedure before it is needed.