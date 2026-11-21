# Error Contracts and Problem Details

An API error contract is a public interface just like a success schema. Clients need to know whether they can correct the request, refresh credentials, retry later, or stop. A reliable response uses the HTTP status for the broad outcome and a stable representation for machine-readable detail. Do not make clients parse a human sentence or infer errors from a success-shaped payload.

## Choose status codes consistently

Start with the status code's HTTP meaning. Use 400 for malformed request syntax or a request that cannot be understood under the API's rules; 401 for missing or invalid authentication; 403 for a request understood but refused; 404 when a target is absent or intentionally concealed; 409 for a conflict with current state; 412 when an HTTP precondition failed; 422 for syntactically valid content whose instructions fail semantic validation; 429 for rate control; and 5xx for server-side failures. Pick a stable convention between 400 and 422 for field validation rather than returning different codes unpredictably.

The same status code may cover several domain cases, so provide a machine-readable problem type or error code. Conversely, do not mint a new status number to express an application-specific distinction: status codes are standardized and generic intermediaries act on them. A response body can add detail without redefining HTTP semantics. A 202 means accepted but not completed; a 200 body containing `{"status":"failed"}` is not an equivalent replacement for a proper failure status.

## RFC 9457 problem details

RFC 9457 defines a standard problem-details object for HTTP APIs and the `application/problem+json` media type, obsoleting RFC 7807. Its core members are `type`, `title`, `status`, `detail`, and `instance`. `type` identifies a problem class, ideally using a stable URI under the API owner's control. `title` is a short summary of that type; `detail` explains this occurrence in terms useful to the caller. `instance` can identify a particular occurrence for support or correlation. Extensions can carry structured data such as validation errors.

Example:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
```

```json
{
  "type": "https://api.example.test/problems/validation",
  "title": "Request validation failed",
  "status": 422,
  "detail": "One or more fields are invalid.",
  "instance": "/problem-occurrences/p_81",
  "errors": [{"pointer": "#/quantity", "code": "must_be_positive"}]
}
```

The HTTP status line is authoritative for generic HTTP software. If a body contains a `status` member, RFC 9457 says generators must use the same code in the actual response; the member is advisory to consumers. Clients should branch on `type` or documented extension codes, not on localized `title` or freeform `detail`. Unknown extension members should be ignored so the contract can evolve. A problem type URI can document the class, but clients should not automatically dereference it on every failure.

RFC 9457 is not a mandate to replace every domain response with an error document. It is suited to an HTTP error where extra detail is helpful. If a request returns an ordinary domain representation that includes a business rejection as part of a workflow, keep that representation's semantics clear. Avoid embedding a stack trace, SQL error, internal hostname, credential, or personal information in public problem details; the RFC explicitly warns about security and privacy leakage.

## Validation details and stable codes

Validation responses should locate the invalid input and explain the expected correction. Use JSON Pointer or a documented path convention to locate fields, and stable machine codes such as `required`, `out_of_range`, or `unknown_field`. Human details can vary by language and should not become parsing API. Decide whether the server reports one problem or a list; return deterministic ordering if tests or clients display the list. Avoid echoing a secret value back in an error response.

For unexpected 5xx responses, return a generic public explanation and a safe occurrence or trace identifier. Log the internal exception server-side with that identifier, with appropriate access controls and redaction. A support ID is useful only if operators can look it up. Do not expose different detailed messages that reveal whether a username, account, or object exists when that distinction is sensitive.

## Common mistakes

- Returning HTTP 200 for errors and asking clients to inspect a custom boolean.
- Using 401 for an authenticated principal that simply lacks permission; that is usually 403.
- Putting field names only in prose that clients must scrape.
- Treating RFC 9457 `detail` as a stable machine protocol.
- Duplicating an HTTP status in the body and allowing the two values to disagree.
- Returning raw exception text, SQL, stack traces, or sensitive input values.
- Using a generic type for unrelated failures, then asking clients to parse `title`.

## Production notes

Maintain a catalog of problem types and status mappings. Contract tests should verify media type, status, required fields, extension shape, and the absence of sensitive data. Test failures at gateways as well as application code because proxies may produce their own response format. Measure error classes by stable type and status, not by unbounded `detail` text. A consistent problem contract lets clients build actionable UX while giving operators safe correlation paths into logs and traces.

## Error behavior across layers

An API call can fail before it reaches application code: a proxy can reject an oversized request, a gateway can deny a route, a load balancer can time out, or a dependency can fail while the app is composing a response. If every layer emits a different HTML or JSON shape, clients cannot reliably recover. Define which layer owns status and problem responses, and make the edge return a documented representation where feasible. If a gateway cannot produce the full API-specific problem type, it should at least preserve a correct status and an opaque correlation identifier.

Avoid mapping every downstream failure to 500. If a dependency rejects a caller's valid request, translating that response may be appropriate; if the dependency is unavailable, a temporary 5xx may be more accurate. Do not blindly forward an upstream body because it may contain internal details or another service's contract. Normalize at the boundary while retaining the original failure in protected logs. Distinguish a caller's invalid input from an internal invariant violation: returning 422 for a database constraint bug hides a server defect and sends clients down the wrong recovery path.

Treat problem-type identifiers as long-lived public names. Renaming a URI can break clients that switch on it. Adding an optional extension is generally safer than changing the meaning or type of an existing one. Document whether an errors array can contain multiple entries and whether its order is significant. These details matter to generated clients and user interfaces that map field errors onto forms.

Clients should also tolerate an unknown problem type by falling back to the status code and a generic explanation. This forward-compatible behavior avoids turning a new server error into a client crash.
