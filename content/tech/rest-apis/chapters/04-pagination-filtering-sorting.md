# Pagination, Filtering, and Sorting

A collection endpoint needs a defined answer to three questions: which records belong in this result, in what order, and how does a client request the next manageable portion? These are API contract decisions, not database details. A robust collection remains predictable as the dataset grows and changes, and it avoids forcing clients to download millions of records just to find one matching item.

## Filtering and sorting

Filters should be explicit, composable, and bounded. A simple collection might support `GET /orders?status=shipped&created_after=2026-01-01`. Document accepted fields, operators, data formats, timezone rules, and whether multiple predicates are combined with AND. If OR logic, ranges, or nested filters are needed, use a clear grammar rather than proliferating ambiguous parameter names. Reject malformed filter syntax with a stable client error; silently ignoring a misspelled filter can look like a successful but incorrect result.

Define sorting as a whitelist of public fields. For example, `sort=-created_at,order_id` means descending creation time, then ascending stable ID. Every sort order used for paging must be deterministic: include a unique tiebreaker even if the caller did not specify one. Without it, equal timestamps can move unpredictably between pages. Define null placement and collation behavior if they affect results. Do not expose arbitrary database expressions, raw SQL fragments, or internal field names as sort parameters.

Filtering and authorization are separate. First constrain results to records the caller may access; then apply requested filters and pagination. Never treat a client-supplied `owner_id` or tenant filter as proof of permission. Also avoid returning total counts by default when counting is expensive or leaks information. A `total` field can be optional, approximate, omitted, or available through a separately bounded mechanism, as long as the contract explains what it means.

## Offset pagination

Offset pagination uses parameters such as `limit=50&offset=100`. It is easy to understand and supports jumping to an approximate page number. It works well for small, relatively stable lists. A deterministic `ORDER BY` is essential; otherwise rows can appear in arbitrary order. Deep offsets can be expensive because the database may still scan and discard preceding rows.

Concurrent writes also create drift. If records are inserted before offset 100 between two requests, an item from the prior page may appear again; deletes can cause an item to be skipped. Snapshot isolation can address consistency for a bounded export, but it requires state and a transaction boundary. Offset is not wrong; it has clear limitations that should match the use case.

## Cursor pagination

Cursor pagination carries a position in a stable sort, for example `?after=eyJjcmVhdGVkX2F0Ijoi...` rather than an exposed row number. For descending `(created_at, id)`, the next-page predicate is conceptually `(created_at, id) < (:last_created_at, :last_id)` with a matching index and order. The unique ID breaks ties. Cursor traversal is efficient for large collections and behaves better under insertions ahead of the cursor, though changes or deletions to the underlying records still affect what exists on later pages.

Treat cursors as opaque, versioned continuation tokens. They can encode the last key values, direction, and a fingerprint of relevant filters. Sign or otherwise protect them if tampering could change query scope; do not put secrets or personal information in readable tokens. Bind a cursor to the original filters and sort so a client cannot reuse it against a different query. Return `next` and optionally `previous` links or cursor values; an empty next link can signal completion. Document expiry or invalidation behavior. A cursor is not authorization: re-check current access on every request.

## Page size and response shape

Choose a conservative default and a hard maximum based on response size, database work, and latency budgets. These values are service policy, not protocol constants. Return a consistent envelope, for example:

```json
{
  "items": [{"id": "o_123", "status": "shipped"}],
  "next": "opaque-token-or-null"
}
```

Use explicit names for count and continuation semantics. If the response includes pagination links, use absolute or relative URI conventions consistently and avoid building links from untrusted host headers. A single item response is usually a resource representation; a list response is a collection representation with its own pagination metadata.

## Pagination in distributed systems

A large export may need stronger consistency than normal interactive browsing. One approach is to create an export job that snapshots the requested scope and produces a downloadable artifact. Another is to issue a short-lived cursor tied to a snapshot or high-water mark. These approaches trade freshness, storage, and operational complexity; do not imply snapshot consistency unless you actually provide it. For event feeds, a monotonic sequence or change token can be more appropriate than sorting by mutable display fields.

When a client encounters a transient failure on page N, it should be able to retry that page without changing its cursor. Ensure a cursor represents position, not a one-shot capability unless one-time use is a deliberate security requirement. Keep each page request stateless where possible; avoid holding a server-side database cursor open across long client pauses.

## Common mistakes

- Sorting on a non-unique timestamp and producing duplicates or missing items across pages.
- Accepting unlimited `limit` values, enabling accidental or intentional resource exhaustion.
- Reporting exact totals on enormous collections when the count dominates the query.
- Treating a cursor as permission to access records without repeating authorization checks.
- Changing filters between pages while reusing an old cursor.
- Building offsets from an unordered query and assuming a database returns stable row order.
- Returning a `next` URL derived from an untrusted forwarded host value.

## Production notes

Test boundaries explicitly: zero, negative, maximum, over-maximum, empty results, equal sort keys, deleted rows, newly inserted rows, and invalid cursors. Examine query plans for the exact filter-plus-sort combination; an index for a filter alone may not support the requested order. Track page size, response bytes, query latency, and cursor rejection rates. Document that pagination is not necessarily a transactionally consistent snapshot. For exports or financial reports, design a separate consistency model rather than assuming ordinary page traversal produces a point-in-time view.

## Choosing a strategy from access patterns

The right scheme follows how clients traverse data, not which one is fashionable. Administrative screens that need a small page number and datasets with infrequent edits can use offset and limit with a stable index. An infinite-scroll feed, event log, or large tenant collection usually benefits from a keyset cursor. If a consumer needs arbitrary page jumps, cursor pagination alone may not meet the product requirement; consider whether a search index or export job is the right interface. State explicitly whether the first page can change while the client reads later pages. A `next` token that is opaque but has no documented expiry or invalidation behavior can leave consumers unable to recover when a deployment changes its encoding. Version cursor encodings internally and return a clear client error for a token the service no longer accepts. Do not return the underlying query plan or database cursor state as a token. Pagination should bound both the number of records and the amount of expensive work per request; a tiny page can still cause a costly aggregation if filters are unindexed.
