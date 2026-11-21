# Data Access Without Blocking the Server

A dashboard callback is a web request, so data access patterns determine both user experience and service capacity. A callback that waits on a warehouse, performs an unbounded query, and serializes every row occupies a web worker for the full duration. Design callbacks as short orchestration steps: validate the request, fetch a bounded result, transform it, and return a small response. For long-running work, queue it and report status instead of holding the request open.

## Query on the server, not in the browser

Keep database credentials and SQL execution on the server. Accept filters such as date ranges, category IDs, and sort fields as untrusted values. Validate type, range, and allowable values, then pass values as bound parameters. Dynamic table or column names generally cannot be bound as values, so choose them from a strict allowlist. Never construct SQL by concatenating user input.

Use connection pooling and timeouts appropriate to the database driver. A callback should acquire a connection, execute a bounded query, materialize only the needed columns/rows, then release resources even if an exception occurs. Database connection pools are per process: if Gunicorn runs several workers, pool size multiplied by worker count is the potential database connection pressure. Size both sides together.

```python
def load_summary(start_date, end_date, region):
    start, end = validate_date_range(start_date, end_date)
    if region not in ALLOWED_REGIONS:
        raise ValueError("Unknown region")
    with engine.connect() as connection:
        rows = connection.execute(
            SUMMARY_SQL,
            {"start": start, "end": end, "region": region},
        ).mappings().all()
    return [dict(row) for row in rows]
```

The SQL and `engine` details depend on the library; the principles do not. Put data retrieval in a service function so callbacks are small and unit tests can replace the repository. Return an explicit empty result for no matches rather than making the presentation layer infer that `None` means both “not loaded” and “no data.”

## Caching with a freshness contract

Cache repeated expensive queries when the freshness requirements permit it. Choose a key that includes normalized filters, tenant or access scope, and relevant dataset version. Add a TTL or explicit invalidation. A cache key that omits a tenant identifier can disclose one user's data to another. If access policy is complex, cache a lower-level public aggregate or cache per authorized scope rather than trying to encode every permission in ad hoc logic.

Process-local caches do not coordinate across workers. A Redis or other shared cache can provide common results, but introduces its own availability and invalidation decisions. If the cache is down, decide whether requests fail, fall back to the database, or return stale data; a silent unbounded fallback can overload the database. Instrument cache hit rates, stale age, and misses.

## Polling and refresh

`dcc.Interval` can periodically trigger a callback by changing `n_intervals`. It is suitable for modest refresh intervals and lightweight checks, not as a general job scheduler. If 200 browser tabs poll every second, even a cheap query multiplies quickly. Use a reasonable interval, stop polling when a page is hidden if the design supports it, and return data only when it changed. Coalesce updates through a shared cache or background producer when many clients need the same source.

Avoid overlapping polls: a slow callback may still be executing when another tick arrives. Use a last-updated timestamp, lock, distributed job schedule, or background task to ensure expensive refresh work is not duplicated. Polling should read the latest known result, while a separate process fetches/aggregates it when the source operation is costly. For live push requirements, consider a transport designed for server-sent or websocket updates rather than aggressively shrinking the interval.

## Pagination and bounded results

For tables, use server-side pagination and sorting for large datasets. The browser should request a page, not load an entire table and hide most of it. Clamp page size, validate sort columns, and provide stable ordering with a unique tie-breaker so rows do not jump between pages. If the underlying data changes frequently, keyset pagination or a snapshot/version token may produce more consistent browsing than offsets.

Aggregate before returning a chart. Include only required fields; don't pass database row objects or credentials into the browser. When repeated requests should share a result, cache the server-side payload and return a compact key or the bounded result itself. Any key exposed to the browser must be opaque and re-authorized on use.

## Common mistakes

- Concatenating filters or identifiers into SQL.
- Returning the entire warehouse table to `dcc.Store` to avoid a second query.
- Treating a per-process Python cache as shared across Gunicorn workers.
- Polling expensive SQL at very short intervals from every browser session.
- Forgetting connection-pool multiplication across workers.
- Using cache keys that omit user, tenant, or permission scope.

## Production notes

Give every external call a timeout; bound result rows and query duration; and surface safe errors without leaking SQL or secrets. Monitor query latency, pool saturation, connection failures, and callback queue time separately. Apply concurrency limits to expensive endpoints and consider a background queue for reports that outlast the normal request budget. A healthy dashboard degrades clearly: if data is stale or unavailable, show the last successful update time and an honest status, not a blank chart that looks like zero activity.

## Concurrency limits and data freshness

A synchronous database driver inside a normal Dash callback waits while the worker handles that request. A bounded number of web workers makes this manageable for ordinary short queries, but sustained slow queries can consume every slot. Put timeouts at both the driver and database level, and apply a per-user or per-tenant concurrency limit to expensive report operations. If an operation may exceed the request budget, queue it instead of increasing proxy timeouts indefinitely. A very long request still occupies memory and worker capacity and can be interrupted by deployments or network failure.

Freshness is a product requirement, not merely a cache setting. State whether the view represents live data, a recent snapshot, or a finalized reporting period. Return a `last_updated` timestamp with the result and show it in the UI. For a `dcc.Interval` refresh, avoid recomputing when the underlying source version has not changed. A shared refresh process can fetch once and publish a versioned result for many sessions, reducing duplicate load. Make the reader tolerate a brief period where the new result is not yet available; do not expose a partially written cache entry.

Pagination requires deterministic ordering. Sorting by a non-unique field alone can cause records to repeat or disappear between pages as rows are inserted. Add a stable unique tie-breaker, clamp page sizes, and validate sort direction and field names. For rapidly changing datasets, a snapshot token or keyset pagination can give a more stable browsing experience than offset pages. For exports that must contain a complete consistent snapshot, use a background report job with an explicit snapshot boundary rather than retrieving pages from changing data over time.

