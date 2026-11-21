# Resource Modelling and URI Design

A resource is an abstraction identified by a URI, not necessarily a database row or a file. HTTP separates the identity of the target from the representation exchanged about it: a single resource can have JSON, CSV, or other representations, and one representation can combine several internal records. Designing that public model is a domain decision. If clients must understand table names, join keys, or service boundaries, the API is exposing implementation rather than a durable interface.

## Start from domain nouns and relationships

List the concepts clients need to address independently: customers, orders, products, invoices, and perhaps an order's line items. A collection URI identifies a set, such as `/v1/orders`; an item URI identifies one member, such as `/v1/orders/ord_7f2`. Their methods then have familiar meaning: GET the collection, GET an item, POST to the collection to request creation, PUT or PATCH a known item, and DELETE an item when the domain permits it.

Nested URIs can express a relationship or scope: `/customers/c_123/orders` lists orders visible through a customer; `/orders/o_456/lines` lists order lines. Nest only while the parent supplies meaningful scope or authorization context. If an order can be addressed independently, `/orders/o_456` should remain a stable canonical URI. Deep paths such as `/companies/1/divisions/2/teams/3/users/4/tokens` encode every traversal and become brittle when relationships change. Return links or identifiers to related resources instead of requiring clients to reconstruct internal paths.

Use consistent plural collection names and stable opaque identifiers. Opaque IDs discourage clients from inferring internal structure, but “opaque” is a contract principle, not cryptography: authorization must still be checked for every requested object. IDs should not be recycled if doing so could make an old bookmark or delayed request refer to a different entity. Avoid leaking secrets or personal information into URIs because URLs commonly appear in logs, browser history, analytics, and referrer data.

## Resources versus actions

Some domain behavior is naturally an action: approving an invoice, cancelling a reservation, or previewing a deployment. Prefer modelling the resulting state or an operation resource where that yields a clear target and lifecycle. For example, `POST /invoices/i_8/approval` can create an approval record, while `POST /invoices/i_8/cancellations` can create a cancellation request with an auditable result. A purpose-specific URI such as `/orders/o_9:cancel` may be appropriate in an API that consistently treats commands as operations, but do not create an ad hoc action naming scheme at every route.

A command whose work is asynchronous can create an operation resource: `POST /exports` returns `202 Accepted`, a `Location: /operations/op_42`, and a representation with status. Clients poll that stable resource or follow an explicitly documented callback mechanism. This is more honest than returning 200 with a guessed completion time. Conversely, avoid wrapping ordinary CRUD in RPC-like endpoints (`getOrder`, `updateOrder`, `doDeleteOrder`) when HTTP methods and resource targets already express the intent.

## URI structure and query parameters

Keep path segments readable, lowercase, and consistently hyphenated where multiword names occur. URI paths are case-sensitive in general; define one canonical spelling and redirect or reject variants rather than treating several forms as distinct resources. Avoid file extensions when media type negotiation is handled by `Accept` and `Content-Type`, unless the extension has a deliberate, documented role.

Use query parameters for selection over a collection: `?status=pending`, `?sort=-created_at`, or `?limit=25`. Define whether repeated filters combine with AND or OR, how unknown parameters are handled, and how empty values differ from omitted ones. Query parameter order should not change semantics. Do not put secrets, access tokens, or sensitive fields in a query string. A search that is too complex or sensitive for URL length and logging constraints can use a documented POST search endpoint, while making clear that it performs a query and is not a state mutation.

## Representations and field design

A representation should describe the public resource, not mirror a persistence schema. Prefer stable, explicit field names and predictable types. Dates should state their format and timezone policy; money should have a currency; absent, null, and empty values need defined meanings. Use one representation shape consistently across list and item operations, or clearly distinguish summaries from full detail. Be cautious when returning expanded relationships: large nested graphs increase response size and authorization complexity. Offer explicit expansion only when clients need it, bound the work, and test that expansion does not expose fields the caller cannot read.

Content negotiation belongs in headers. `Content-Type` tells the server how to parse a request body; `Accept` expresses response media-type preferences. A server can respond `415 Unsupported Media Type` for an unsupported request representation and `406 Not Acceptable` when it cannot supply an acceptable response format. If JSON is the only supported format, say so and still set the correct media type.

## Relationship links and discoverability

A representation can include related identifiers or links. Consistent link relations help clients navigate when URI patterns evolve, but do not confuse link presence with authorization: a client may still forge a URI, and the server must authorize each request. APIs that do not implement hypermedia can still provide a useful contract through OpenAPI, stable URI templates, and explicit pagination links. Whichever style you choose, clients should not depend on undocumented route-building rules.

## Common mistakes

- Designing routes from ORM table names, then exposing every schema migration as API churn.
- Deeply nesting an independently addressable resource under all of its ancestors.
- Using a GET query parameter such as `?action=delete` for a state-changing action.
- Returning database IDs as if their format or sequence is a public guarantee.
- Treating unguessable IDs as access control; object-level authorization is still required.
- Returning giant nested documents by default and creating hidden N+1 queries.
- Using ambiguous `null`, omitted, and empty values without defining their semantics.

## Production notes

Review a resource model with sample client tasks: create an order, retrieve it from a notification, list its lines, update one field, and handle a conflict. If the client needs to know internal joins or guess URLs, improve the representation or links. Keep canonical identifiers stable across deployments. Measure response size, database query count, and authorization checks on both collection and expanded forms. URI design should make common actions obvious without making internal architecture immutable; a public resource boundary is a deliberate abstraction that can outlive the implementation behind it.

## Design review checklist

When reviewing a proposed route, ask what exact resource the URI identifies, whether that target has a useful independent lifecycle, and whether the chosen method matches the requested effect. Check whether the same entity is accidentally exposed with several competing canonical URIs. Confirm that collection filtering does not bypass the authorization applied to item reads, and that a response cannot reveal another tenant's nested fields through expansion. Exercise identifiers containing reserved URI characters through correct percent-encoding; never assume every client concatenates path segments safely. Finally, document whether deletion is permanent, soft, or asynchronous. A `204` response should not imply that a retained audit record or a delayed cleanup is already physically erased. Clear lifecycle language is part of resource semantics.
