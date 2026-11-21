# Caching and Invalidation

Streamlit scripts rerun frequently, so caching is often essential. Current Streamlit code should distinguish two lifetimes: `st.cache_data` for results that behave like data, and `st.cache_resource` for shared objects whose identity matters, such as a connection pool or loaded model. The older catch-all `st.cache` is not the API to start with. Choosing the wrong decorator can create stale results, memory growth, mutation bugs, or cross-user data exposure.

## Cache computed data with `st.cache_data`

`st.cache_data` stores the result of a function based on its code and inputs. It is intended for serializable data values: dataframes, query results, lists, dictionaries, and similar outputs. A cache hit avoids re-running the body. Data results are serialized and returned as copies, which helps isolate callers from mutating the cached stored value.

```python
import streamlit as st
import pandas as pd

@st.cache_data(ttl=300, max_entries=64)
def load_sales(start_date, end_date, region):
    return query_sales(start_date, end_date, region)

sales = load_sales(start_date, end_date, region)
st.dataframe(sales)
```

The function should express its real dependencies as arguments. If it reads a file based on a global path, changing the file contents does not necessarily change the function's argument key. Pass a version, modification marker, or content-derived identifier when that is appropriate, or explicitly clear the cache after an update. Do not hide important inputs in mutable globals and expect Streamlit to infer them.

A time-to-live is an upper bound on how long an entry may be reused; it is not a synchronization guarantee for upstream writes. `max_entries` bounds entry count, not total bytes. A few huge results can still consume substantial memory. Choose limits based on data size and usage, and monitor process memory.

## Cache shared resources with `st.cache_resource`

`st.cache_resource` caches a resource object itself and returns the shared instance. Typical examples are a database connection pool, API client, tokenizer, or machine-learning model:

```python
@st.cache_resource
def get_engine():
    return create_database_engine(read_database_url())
```

The resource can be shared across sessions and reruns. That is useful for expensive initialization, but it means the object is not automatically isolated per user. A cached mutable resource must be safe for concurrent use; database engines and properly designed pools are generally shared, while a mutable cursor or user-specific client may not be. Do not cache a transaction-scoped connection globally and reuse it as if each user had a private transaction. Create short-lived connections from a cached pool inside the operation.

If initialization depends on a tenant, credential, region, or model version, those dependencies must be represented in the cache key or resource scope, and access boundaries must remain correct. Do not put credentials in visible UI or use a process-wide singleton to bypass authorization.

## Cache keys, hashing, and hidden inputs

Streamlit identifies a cached call using function code and hashable parameters. Parameters with leading underscores are excluded from hashing, which is useful for an unhashable object when another argument provides a stable identity—but dangerous if the excluded object changes results. Use `hash_funcs` for a custom type only when you can define a stable, correct identity. A bad hash function silently turns distinct inputs into one cache entry.

Common invalidation traps include:

1. **External data changed, function arguments did not.** A query with identical parameters may return an old cached result until TTL or clearing.
2. **A global setting changed.** If the function reads it implicitly, it may not participate in the cache key.
3. **A function changed but imported helper behavior changed.** Cached code hashing is not a substitute for explicit data versioning, especially across deployment boundaries.
4. **A user or tenant is omitted.** Identical query parameters can return another user's cached result.
5. **Mutable input is modified in place.** A key based on a value whose identity/content semantics are unclear can produce surprising reuse. Prefer immutable arguments and explicit version tokens.

`load_data.clear()` clears entries for that cached function; `st.cache_data.clear()` clears data-cache entries globally. Use the narrowest invalidation that meets the need, and place clearing after a successful write, not before it. Clearing is a performance operation and can create a thundering herd if many sessions must recompute simultaneously.

## Data copies, mutation, and concurrency

`st.cache_data` returns copies rather than handing each caller the same mutable return object. That reduces cross-session mutation hazards, but large copies cost memory and CPU. Avoid modifying an expensive cached dataframe just to add a display column; either derive a separate view, or include the transformation in a cached function when its inputs are explicit. `st.cache_resource` does not copy its object: mutations affect the shared resource and concurrent callers may observe them.

Neither decorator makes arbitrary functions thread-safe. `st.cache_resource` can be accessed by simultaneous sessions, and fragments configured for parallel execution can add concurrency. Check the underlying client or model's thread-safety contract. If it is not safe, protect access with a lock, use per-session resources, or serialize work elsewhere. Do not assume a cached database connection is safe just because the decorator accepts it.

Async caching support and compatibility can vary by Streamlit version and the async library involved. Prefer synchronous cached wrappers or deliberate integration tested against the version you deploy rather than assuming every async resource survives reruns.

## Cache scope and privacy

By default, cache entries can be reused by all sessions in the app process. Recent Streamlit versions also support session-scoped cache behavior for selected use cases, but session state is often the simpler choice for a per-user temporary value. Regardless of scope, data authorization must occur at the point of retrieval. A cache key is not an access-control policy.

A safe tenant-aware query may use an explicit tenant identifier as an argument, but the server must obtain that identifier from a trusted authenticated context, not a free-form widget. Never cache secrets or user-specific results under a key that omits the user/tenant distinction. Consider whether serialized cache contents could reveal sensitive data through process memory or diagnostics.

## Choosing the decorator

| Question | Use `st.cache_data` | Use `st.cache_resource` |
|---|---|---|
| Is the return value a computed data result? | Yes | Usually no |
| Should callers get isolated copies? | Usually yes | No; same object is reused |
| Is it a connection pool, model, or client? | Not usually | Often |
| Can concurrent sessions safely use one instance? | Not applicable to returned copy | Must be verified |
| Is invalidation by input/TTL meaningful? | Often | Sometimes, based on resource configuration |

## Common mistakes

- Using a resource cache for a dataframe and then mutating shared data across users.
- Using a data cache for an unpicklable or identity-sensitive resource.
- Forgetting a tenant, locale, feature flag, or external data version in cache inputs.
- Treating TTL as a transactional freshness guarantee.
- Assuming `max_entries` limits cache bytes.
- Clearing all caches on every interaction and causing repeated expensive work.

## Production notes

Start with pure, deterministic functions and explicit arguments. Select a TTL and capacity based on freshness and memory requirements, then observe hit rates and process memory. Ensure cached results cannot cross a security boundary, and test invalidation after writes and configuration changes. The best cache is not the one with the most hits: it is the one whose reuse conditions are correct, bounded, and understandable.