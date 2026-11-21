# Performance, State, and Background Work

Dash performance is governed by more than Python execution time. Each interaction may serialize values in the browser, cross the network, enter a worker queue, execute Python, and serialize outputs again. The right optimization depends on which part is slow. Measure callback duration, input/output size, database latency, and browser render cost before adding concurrency or cache layers.

## Keep payloads and callbacks small

Return only the data the page needs. A callback that sends a multi-megabyte dataframe through `dcc.Store` and then into another callback may be slower than a second server-side query. `dcc.Store` is client-side storage, usually browser memory or browser storage depending on its `storage_type`; it is not a shared server cache. Keep stored values compact, serializable, and non-sensitive. Browser data can be inspected and modified by its owner, so do not store secrets or rely on a stored role flag as authorization.

For large data, keep records in a database, object store, or server cache and place a compact query token or filter state in the browser. Re-check permissions when the token is used. Pagination and aggregation should happen close to the data source. A browser can efficiently display only a bounded view, not millions of detailed records.

## Memoisation and cache scope

Caching avoids repeating pure or safely reusable work. Python's `functools.lru_cache` is process-local and works best for deterministic functions with hashable arguments. It is not automatically safe for user-specific results: include all relevant dimensions such as tenant, access scope, filters, and data version in the cache key, or do not cache that result. An unbounded cache can grow indefinitely. Set an explicit maximum, expiration, or invalidation policy.

With multiple Gunicorn workers, each worker has its own Python memory. A module-level dictionary or `lru_cache` is not a shared cache and may return stale results in one worker while another has refreshed. For shared caching or job state, use a system designed for it, such as Redis, with clear TTL and failure behavior. Dash's optional `flask_caching` integration is commonly used to connect callbacks or helper functions to a configured backend; caching correctness remains an application responsibility.

## Client-side callbacks

A clientside callback executes JavaScript in the browser and can avoid a server round trip for lightweight presentation-only transformations. It is useful for simple calculations on data already present in the browser, local formatting, or toggling a UI state. It is not a way to conceal data or execute trusted business logic. Large browser computations still consume the user's device and can block interaction; use profiling and keep the function small. Python callbacks remain the more natural choice for database access, permissions, and domain calculations.

## Background callbacks

Long-running work should not occupy a web worker until a request timeout. Dash supports background callbacks with `background=True`, using a configured manager such as Diskcache for local development or Celery with a broker/backend for distributed production deployments (the exact configuration API depends on the Dash release). A background callback can provide progress and cancel behavior where configured, while the web request returns promptly and later receives the result.

```python
from dash import Input, Output, callback

@callback(
    Output("report-status", "children"),
    Input("build-report", "n_clicks"),
    background=True,
    prevent_initial_call=True,
)
def build_report(_clicks):
    return run_report_job()
```

Configure the background callback manager on the Dash app according to the installed version's docs; `background=True` is not a complete queue setup on its own. Diskcache is convenient for a local setup, not a substitute for a durable distributed queue under production load. A job that sends email or writes records needs idempotency, authorization checks, a clear retry policy, and safe handling of partial completion. Do not assume cancel means an already-running external operation is rolled back.

## Loading states and callback scheduling

Use loading indicators such as `dcc.Loading` or component-level disabled states to communicate that work is underway. Dash's callback options, including `running` in supported versions, can set properties while a callback executes. These improve feedback but do not increase capacity. Also plan for repeated clicks, timeouts, and concurrent users; avoid spawning unbounded work from button events.

A clientside callback can reduce round trips for tiny interactions, and partial property updates can reduce transfer when only a small property subtree changes. Neither replaces measuring. Enable compression and use a reverse proxy's supported settings when appropriate, but don't compensate for inefficient queries by merely enlarging request limits.

## Common mistakes

- Treating `dcc.Store` as a server-side, cross-worker cache or a secure vault.
- Using `lru_cache` for user-specific data without a complete authorization-aware cache key.
- Assuming worker memory is shared under Gunicorn.
- Setting `background=True` without configuring and operating a callback manager.
- Launching a background job on every keypress or polling tick.
- Caching data without an invalidation, expiry, or data-version policy.

## Production notes

Track callback latency distributions by callback identity, database time, queue wait, and failure type. Set deadlines and resource limits on expensive work. Give background jobs IDs and observable status, and expire stored results according to their sensitivity and retention needs. Use a shared backend if users may hit different workers. For every cache, document what is cached, who may see it, how it becomes stale, and what happens if the cache is unavailable. Performance work is complete only when the interaction remains correct under simultaneous users and a cold cache.

## Choosing where state lives

State placement should follow its scope and lifetime. A current checkbox selection can live in a component property. A small collection of filters that should survive page navigation may be mirrored into a `dcc.Store` or URL. A computed result shared by users belongs in a server-side cache with an explicit freshness and authorization policy. A durable report job belongs in a queue and persistent job store. These are different jobs; placing them all in one browser Store creates size, security, and consistency problems. Document how each state is initialized, updated, expired, and recovered after refresh.

Memoization is correct only when the function behaves like a function of its key. If it reads current time, ambient identity, a mutable dataframe, or a changing external table without including those inputs in the key, the cached result can be wrong. Normalize dates and filters before key creation so equivalent requests map consistently. Use a tenant-aware cache key where required, and avoid raw sensitive values in cache logs. Invalidation can be event-driven after writes or time-based through a TTL; often both are useful. A stale-but-labeled aggregate may be acceptable, while a stale permission result is not.

Background work introduces a second lifecycle in addition to the browser request. Define when a job is queued, how the user can see its state, what happens after a worker restart, and how results expire. If the queue is unavailable, return a safe failure instead of silently running the same expensive work inline. Track queue depth and oldest job age: a callback may appear responsive while work is accumulating faster than workers can finish it. Rate limits per user or tenant prevent one dashboard from monopolizing shared capacity.

