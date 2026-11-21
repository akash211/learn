# Connecting to Databases and APIs Safely

A Streamlit app often reads from a database or calls an HTTP API to render the next view. Because widget interactions rerun the script, external I/O can happen more often than expected. Use explicit timeouts, bounded connection pools, parameterized queries, and a clear cache policy. Keep credentials out of source code and UI state, and enforce authorization in the data access layer—not merely by hiding a widget.

## Secrets and configuration

Use Streamlit's secrets mechanism or environment-based configuration appropriate to the deployment. Do not commit `secrets.toml`, tokens, passwords, or production connection strings to the repository. Restrict who can edit deployment secrets and rotate credentials when exposure is suspected. Separate development and production credentials, and grant the app only the least privileges it needs.

Configuration should distinguish public settings (service URL, feature flags) from secrets. Never render a secret through `st.write`, include it in an exception displayed to users, or put it into a widget key. In containers, inject secrets through the platform's secret mechanism rather than baking them into image layers. Make startup fail clearly when required configuration is missing, without printing the value.

## Database connections and queries

Cache a connection pool or engine as a resource, then create and close a short-lived connection/transaction for each operation:

```python
@st.cache_resource
def get_engine():
    return create_engine(st.secrets["database"]["url"], pool_pre_ping=True)

def load_orders(customer_id, start_date):
    with get_engine().connect() as conn:
        return read_orders(conn, customer_id, start_date)
```

The exact connection API depends on the driver. The important boundary is that the reusable engine/pool is not itself a user transaction. Avoid caching cursors or an open transaction across sessions. Use context managers so exceptions still return connections to the pool. Configure pool size, timeout, and server-side statement limits in line with the database and deployment concurrency; do not open an unbounded connection for every rerun.

Use parameterized SQL. Never concatenate a widget value into query text:

```python
# Good: the driver binds the value.
rows = conn.execute(text("SELECT id, total FROM orders WHERE region = :region"),
                    {"region": selected_region})
```

Identifiers such as table names usually cannot be bound as values; map a user choice to an allow-listed identifier rather than interpolating arbitrary text. Validate date ranges and row limits, and select only needed columns. SQL parameters prevent injection, but they do not establish whether a user is allowed to read a tenant's rows.

## HTTP clients and external services

Reuse an appropriately configured HTTP client resource when its library supports safe sharing; otherwise create it with a clear lifetime. Set connect/read/overall timeouts, cap retries, and retry only transient errors for idempotent operations. Respect upstream rate limits and use backoff with jitter if appropriate. A widget rerun should not launch an uncontrolled burst of requests.

Check status codes and validate response shape before rendering. External APIs can be slow, unavailable, or return malformed data. Present a recoverable error and preserve the last known result if that is useful, while labeling its age. Avoid showing raw response bodies to users; they may contain internal details or personal information. Never disable TLS verification as a shortcut for certificate problems.

Use `st.cache_data` for read results only when the freshness and security model permit it. Include all meaningful parameters—including tenant and data version where applicable—in the cached function arguments. A TTL controls reuse duration but does not guarantee immediate visibility of a write. Clear the relevant cache after successful changes if stale reads are unacceptable. If a cached result is user-specific, ensure the trusted user identity is represented correctly and still authorize access before serving it.

## Writes, forms, and reruns

Put mutations behind a clear submit or action event, validate the submitted values, and make the server-side operation idempotent if duplicate requests are harmful. A button's click event does not provide exactly-once delivery: network retries, page refreshes, and user double clicks are possible. For a database write, use a transaction with appropriate constraints and return a result the UI can safely display on later reruns. Persist operation status if users need to see it again.

A form lets users set several values before one submission, but it is a UI batching mechanism, not database isolation. The database transaction controls atomicity and consistency. Validate again in the service function; do not trust that widget constraints or a hidden field enforce business rules.

## Authorization and multi-tenancy

Obtain identity from a trusted authentication integration, reverse proxy, or identity-aware gateway. A dropdown for `tenant_id` is not authentication. Derive the permitted tenant from the authenticated context and enforce row-level authorization on every query or service call. If admins can choose a tenant, verify that the principal is authorized for that tenant on the server side.

Session State and widget keys are not access control. Cached functions shared between sessions can leak results if cache keys omit principal or tenant boundaries. Keep personal or regulated data out of broad caches unless access isolation and retention are designed and tested. Logs should include useful correlation identifiers but not credentials or raw sensitive data.

## Common mistakes

- Opening a new database connection on every rerun without pooling or cleanup.
- Caching a transaction, cursor, or user-specific client as a globally shared resource.
- Building SQL by concatenating a widget value into a query string.
- Omitting timeouts and retries, leaving sessions stuck on a slow upstream service.
- Treating a form, hidden page, or session variable as an authorization control.
- Assuming a cached read becomes fresh immediately after a write.

## Production notes

Treat the Streamlit process as an application server with network credentials and access to data. Use least privilege, TLS, secret rotation, query limits, and observability around latency and errors. Test duplicate submissions and upstream timeouts. If the app becomes the sole home for complex business rules or public endpoints, extract those rules into a service with an explicit API and use Streamlit as the presentation layer.

## Operational observability

Record latency and outcome at each boundary: cache lookup or query, upstream HTTP call, transformation, and user-triggered write. Metrics should use bounded labels; avoid putting raw user IDs, SQL values, or request content into labels that grow without limit. Attach a correlation identifier to an operation so support staff can connect an error message to a redacted server-side trace. Distinguish expected no-results from timeouts and validation errors.

For database pools, observe active and waiting connections and compare them with configured limits. A Streamlit app can have many active sessions, and each can initiate work; a pool sized only for one developer's laptop can exhaust database capacity. Set upstream timeouts and pool bounds, then load-test interaction patterns such as changing filters quickly. If a user can start multiple operations, define whether they are queued, cancelled, or allowed to overlap. These measurements inform safe capacity planning and help identify whether the bottleneck is the UI, a query, or a dependency.