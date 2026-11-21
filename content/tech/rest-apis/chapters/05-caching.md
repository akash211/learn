# HTTP Caching and Conditional Requests

Caching reduces latency, origin work, and transferred bytes, but only when the response is reusable for the requester and representation. HTTP cache behavior is defined primarily in RFC 9111, with validators and conditional request semantics in RFC 9110. API teams should treat cache headers as a security and correctness contract: a response that is fresh but belongs to a different user is not a performance win.

## Freshness and Cache-Control

A response can be fresh for a period, allowing a cache to satisfy later requests without contacting the origin. `Cache-Control: max-age=60` says a response is fresh for 60 seconds from generation under the HTTP age model. `s-maxage` supplies freshness for shared caches and takes precedence over `max-age` there. `Expires` is an older absolute-time mechanism. `Age` indicates an estimate of the time since the response was generated or successfully validated.

Common directives express different policies:

- `public`: shared caches may store the response when other rules permit.
- `private`: a shared cache must not store it as a shared response; a private cache may.
- `no-store`: caches must not store the response. Use for data that must not persist in caches, while recognizing this is not a substitute for secure application handling.
- `no-cache`: storage is allowed, but reuse requires successful validation before each use. The name does not mean “do not store.”
- `must-revalidate`: once stale, a cache must not reuse the response without successful validation, subject to HTTP rules.

A browser's private cache and a shared CDN cache have different audiences. Responses containing personalized or tenant-specific data should generally be private or non-cacheable unless the shared-cache key and authorization policy have been carefully designed. RFC 9111 limits shared caching of responses to requests with `Authorization` unless explicit response directives allow it. Do not assume that a CDN will infer the right user boundary from cookies or authorization headers.

## Validators: ETag and Last-Modified

An `ETag` is an opaque validator for a selected representation. A strong entity tag changes whenever representation data changes in a way that matters for byte-for-byte equivalence; a weak tag prefixed `W/` can indicate semantic equivalence where exact bytes differ. The client need not understand the tag's contents. It may be based on a revision number, a hash, or another reliable representation version. Include variation dimensions where they affect the selected representation.

`Last-Modified` expresses a modification time and may be useful as a validator, but its time granularity can be too coarse to distinguish rapid updates. An ETag is often more precise. Both can be sent if they can be maintained consistently.

For revalidation, a client sends `If-None-Match: "rev-42"` with GET or HEAD. If the selected representation still matches, the server returns `304 Not Modified` without a body; the cache reuses its stored body and updates metadata as appropriate. If it changed, the server sends the new representation, commonly with `200 OK` and a new ETag. `If-Modified-Since` offers a date-based alternative. RFC 9110 defines precondition evaluation and validator comparison rules; use established server libraries instead of approximating the precedence rules.

Conditional requests also protect writes. A client can send `If-Match` with the ETag it received earlier when performing PUT or DELETE. The server must not apply the method if the condition fails and should return `412 Precondition Failed`. This is optimistic concurrency control: it prevents a stale editor from silently overwriting a newer representation. A weak ETag is unsuitable where strong comparison is required for `If-Match`.

## Vary and cache keys

A cache selects stored responses by a cache key that includes at least the request method and target URI. `Vary` names request headers that influenced representation selection, such as `Accept-Language` or `Accept-Encoding`; compliant caches use those values to distinguish variants. If response content changes by a header but the response omits the appropriate `Vary`, one caller may receive another caller's variant. Do not vary on arbitrary high-cardinality headers without understanding cache fragmentation and privacy effects.

## Example interaction

```http
GET /catalog/items/42 HTTP/1.1
Accept: application/json
```

```http
HTTP/1.1 200 OK
ETag: "item-42-r8"
Cache-Control: public, max-age=30
Content-Type: application/json
```

After the freshness period, the client can revalidate:

```http
GET /catalog/items/42 HTTP/1.1
If-None-Match: "item-42-r8"
```

A `304` saves body transfer but is not a fresh copy of the representation by itself. Clients must retain and combine it with the stored response according to HTTP caching rules.

## Common mistakes

- Setting `public` on personalized data without accounting for credentials and cache key variation.
- Confusing `no-cache` with `no-store` and assuming the response cannot be persisted.
- Returning an ETag that does not change when the representation changes.
- Omitting `Vary` when language, media type, or another header changes the body.
- Sending a body with 304 or expecting a client to read content from it.
- Treating an ETag as an authorization secret or globally unique resource identifier.

## Production notes

Test cache policy through the actual browser, proxy, and CDN path, not just the application unit test. Verify `Age`, `Vary`, revalidation, invalidation after mutation, and behavior when a user signs out or changes tenant. Decide whether successful writes invalidate dependent cached collections and how quickly stale data is acceptable. Cache invalidation is application-specific; conditional GET can reduce origin load but does not automatically purge every intermediary. For sensitive data, prefer a conservative policy and document the intended cache audience explicitly.

## Cache policy by data class

A practical policy starts by classifying representations. Public immutable reference data can often have a long freshness lifetime, while a rapidly changing inventory listing may need a short lifetime or revalidation. A private user profile should not be stored by a shared cache. A response containing regulated or highly sensitive data may require `no-store`, but that directive cannot erase copies already written by application logs, browser extensions, or an intermediary that ignored policy. For a personalized response, `private, no-cache` can permit a browser to store a copy but require validation before reuse; whether this is suitable depends on the client's threat model and logout behavior. Document the acceptable staleness, invalidation path, and cache audience for each representation class.

A mutation can affect more than the item URI: updating an order may change a customer summary and a filtered collection. HTTP does not automatically invalidate every cached URI that includes this resource. Options include short freshness, revalidation, explicit purge at controlled intermediaries, or a representation design that limits cross-resource duplication. Test a changed representation after the actual write path, including races where a cache receives a stale response after invalidation. Never rely only on a developer's browser cache as evidence that policy works.

Keep a short record of each representation’s audience, freshness tolerance, validator strategy, and invalidation behavior. This makes cache review concrete and helps prevent an otherwise invisible shared-cache mistake.
