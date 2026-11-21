# HTTP Semantics: Methods, Status Codes, and Idempotency

HTTP gives clients and servers a shared vocabulary for intent and outcome. An API that uses the method, status, and header semantics already defined by HTTP is easier for clients, proxies, caches, and monitoring systems to understand. These semantics are not decoration: they determine when an action may be retried, whether a response can be cached, and what a generic client should do next. RFC 9110 is the current core HTTP semantics specification; its Sections 9 and 15 define methods and status codes.

## Methods carry intent

The method is the primary indication of what a request asks the target resource to do. `GET /orders/42` asks for a current representation; `DELETE /orders/42` asks to remove the identified resource. The URI identifies the target, while the method supplies standardized semantics. Do not hide a destructive action behind `GET /orders/42?delete=true`: browsers, crawlers, link previewers, and caches are permitted to use safe methods automatically.

Common method choices:

| Method | Typical API use | Safe? | Idempotent? |
|---|---|---:|---:|
| GET | Retrieve a representation | Yes | Yes |
| HEAD | GET metadata without response content | Yes | Yes |
| POST | Submit data for resource-specific processing or create subordinate resource | No | Not inherently |
| PUT | Create or replace the state at a known target URI | No | Yes |
| PATCH | Apply partial modifications under a defined patch format | No | Not inherently |
| DELETE | Remove the target resource | No | Yes |
| OPTIONS | Discover communication options | Yes | Yes |

Safe means the client does not request a state change; it does not mean that the server performs literally no side effects. Access logs and metrics may be written. Idempotent means multiple identical requests have the same intended effect as one request, not that the responses must be byte-for-byte identical. A repeated DELETE may return 404 after the first request returned 204 and still be idempotent: the requested final state, absence of the resource, is unchanged by the repeat. RFC 9110 identifies GET, HEAD, OPTIONS, and TRACE as safe; safe methods are idempotent, as are PUT and DELETE. PATCH is not automatically either: the specific patch operation determines its behavior.

PUT is replacement semantics. A client sends the desired representation for a known resource URI; omitting a field can mean it is removed or reset, according to the resource model. POST delegates processing to the target, commonly creating a server-assigned child resource or initiating a command-like operation. Do not call an operation PUT merely because it accepts JSON. If a repeated request charges a card twice, it is not idempotent merely because the route is named `/payments`.

## Status codes describe the result

Choose a status that accurately expresses the outcome and helps generic software behave correctly. A useful set covers most APIs:

- `200 OK`: successful request with a response representation, often for GET or an update that returns the resulting resource.
- `201 Created`: one or more resources were created; a `Location` header commonly identifies the primary new resource.
- `202 Accepted`: accepted for processing, but processing is not complete. Explain how the client can observe completion, such as a status resource.
- `204 No Content`: success with no response content. Do not attach a JSON body and claim generic clients should read it.
- `304 Not Modified`: conditional GET or HEAD indicates that a cached representation remains usable; it has no response content.
- `400 Bad Request`: malformed or otherwise invalid request syntax/structure; use a stable documented policy for validation failures.
- `401 Unauthorized`: valid authentication credentials are absent or unacceptable; the response must include an applicable `WWW-Authenticate` challenge. The name is historical: it concerns authentication.
- `403 Forbidden`: the server understood the request but refuses it; the client should not assume re-authentication alone will solve it.
- `404 Not Found`: no current representation is available, or the server intentionally does not disclose its existence.
- `409 Conflict`: request conflicts with current resource state, such as a uniqueness constraint or invalid state transition.
- `412 Precondition Failed`: a condition such as `If-Match` failed; useful for optimistic concurrency.
- `422 Unprocessable Content`: content type and syntax were understood but the request's instructions cannot be processed, often field validation.
- `429 Too Many Requests`: the client exceeded a rate policy; a response may explain the limit and include `Retry-After`.
- `500 Internal Server Error`: an unexpected server failure; do not disguise it as a client validation error.
- `502`, `503`, `504`: gateway/upstream failure, temporary unavailability, or upstream timeout, respectively.

Status code is not a substitute for a useful body, but it must remain correct independently of the body. Clients often branch on status before parsing JSON. RFC 9110 defines a class by the first digit: unrecognized codes are treated as the generic class, so using an invented code to encode business rules usually harms interoperability. Put domain-specific detail in a documented response representation or error contract.

## Idempotency and safe retries

A network failure can occur after the server commits an action but before the client receives its response. The client then cannot know whether the request took effect. Idempotent semantics let a client repeat PUT or DELETE without causing a second intended effect. This does not mean retries are always wise: a request can still be expensive, and a retry storm can overload a recovering dependency.

POST is not inherently idempotent. A payment-creation endpoint can offer an application-level idempotency key: client supplies a unique key for one logical operation; server atomically associates it with the authenticated principal and a request fingerprint, records the outcome, and replays that outcome for same-key/same-request retries. Reusing the key with a different payload should be rejected. The retention period, conflict behavior, and what constitutes the same request are part of the API contract, not universal HTTP rules.

## Conditional requests protect concurrent updates

When clients edit shared state, a GET can return an `ETag`; a later PUT can carry `If-Match: "revision-17"`. If someone else changed the representation, the server rejects the write with `412 Precondition Failed` instead of silently overwriting newer data. An API may use `409 Conflict` for a domain conflict that is not an HTTP precondition. Make the distinction consistent and documented.

## Common mistakes

- Treating 200, 201, and 202 as interchangeable “success”; they communicate different completion states.
- Returning 200 with an error-shaped body while clients are expected to infer failure from JSON.
- Using GET for a mutation, which exposes users to unintended actions by automated retrieval.
- Assuming PUT means “update only fields supplied”; replacement semantics normally require the full desired state.
- Retrying every POST after a timeout without a deduplication strategy.
- Confusing idempotence with identical responses or with absence of logging side effects.

## Production notes

Test semantics as observable behavior: repeated PUT/DELETE, GET without mutation, status and headers for created resources, and conditional-write races. Document which failures are safe to retry and only retry when the method or an application-level key makes duplicate effects safe. For method-not-allowed responses use `405` and an `Allow` header where applicable. These small details allow generic clients and intermediaries to do useful work instead of requiring every integration to learn private conventions.
