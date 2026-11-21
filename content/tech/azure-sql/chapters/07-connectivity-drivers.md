# Connectivity, Drivers and Resilience

Applications experience Azure SQL Database through a network path, a TDS client driver and an authentication context. Database availability is only one part of successful connectivity: DNS must resolve correctly, firewalls and private routing must permit traffic, a token or credential must be valid, and the driver must handle redirects, transient faults and pooled sessions. Production readiness therefore includes connection configuration and failure semantics as much as query tuning.

## Connectivity architecture and connection policy

Azure SQL Database exposes a fully qualified DNS endpoint under the Azure SQL service domain. The logical server name identifies the service endpoint, not a fixed machine. Clients connect using Tabular Data Stream (TDS) over TLS. Service infrastructure can move connections among nodes, and DNS behavior is part of the supported architecture; configure applications with the endpoint name, never a discovered IP address.

Azure SQL connectivity policy determines how clients are routed after the initial connection. In the common default redirect behavior, the client initially reaches a gateway, then receives information to connect to the database node. Redirect can provide a more direct data path, but requires outbound access to the relevant service ports and network ranges. Proxy keeps the client path through the gateway, which can be easier where outbound rules are restrictive, with a different latency and throughput profile. Exact port requirements and behaviors depend on public/private endpoint configuration, policy and current platform guidance. Configure the connection policy consciously, then use Microsoft's current service tags and networking documentation to define firewall rules. Do not open a broad outbound range based on an old example.

With a private endpoint, clients reach a private IP through Azure Private Link. Private DNS must map the service FQDN correctly from the client network. A private endpoint is not a replacement for driver TLS validation, database authorization or public network access policy. Test name resolution and a real authenticated connection from every application subnet and operational path. A successful connection from a developer workstation does not prove that the production subnet uses the same DNS, route or identity.

## Drivers and authentication

Use a supported Microsoft data access driver for the application's language, such as Microsoft.Data.SqlClient for .NET, Microsoft JDBC Driver for Java, or the supported ODBC driver for native and other clients. Select an actively maintained release and verify compatibility with Microsoft Entra authentication, encryption requirements and Azure SQL features used. Older driver versions can have different TLS, token, retry and encryption defaults. Pin and patch drivers deliberately rather than relying on whatever dependency happens to arrive transitively.

For Microsoft Entra authentication, a driver can obtain a token using an interactive user, service principal, managed identity or another supported credential flow. In production, managed identity is usually preferable when hosted on an Azure resource because it avoids storing a password or client secret. Verify the identity's database user and grants separately. Token lifetimes are finite; use a driver integration that refreshes credentials and do not cache a token beyond its valid period. Avoid placing tokens or sensitive connection properties in logs.

Connection strings should set the server, database, authentication mode, encryption and connection timeout deliberately. Require TLS encryption and certificate validation. Do not set `TrustServerCertificate=True` as a generic fix for a certificate error. Do not store SQL passwords in source control, container images or plain deployment variables. Use a secret store for unavoidable credentials and control rotation. Separate application and administrative connection settings so routine services do not inherit elevated permissions.

## Connection pooling

Most data drivers pool connections. Pooling reuses physical database sessions to avoid repeated TLS negotiation and authentication overhead, but it makes session state important. Return connections promptly, dispose them reliably, and avoid holding a connection during user think time or unrelated network calls. A pool per distinct connection string can multiply connections; dynamic connection-string values can accidentally create many small pools. Bound maximum pool size based on service limits and concurrency, and tune it together with application worker counts.

At high application replica counts, each process may independently create a pool. The sum of pool maxima can overwhelm a database even if any one instance looks reasonable. Calculate worst-case connections across all app replicas, background workers and deployment slots. Use admission control, a shared or managed proxy only where appropriate, and sensible pool sizing. Azure SQL Database is not a connectionless service; pool management is part of capacity planning.

Session state can leak through pooled connections. If using `SESSION_CONTEXT`, set the required context on every checkout and clear or overwrite it before returning the connection. Avoid relying on temporary session settings that survive a transaction boundary. Row-level security based on session context especially requires robust tenant context assignment and reset. Test reuse across tenants and exceptional code paths.

## Retry logic and transient faults

Azure SQL Database can have transient failures during maintenance, failover, scaling or brief network disruptions. A resilient client uses bounded retries with exponential backoff and jitter for errors classified as transient. Use supported driver retry capabilities where appropriate and configure maximum attempts and overall timeout to match the request budget. Infinite retry loops turn a short outage into a resource exhaustion event. Combine retries with circuit breaking or request shedding at the application layer when sustained failures occur.

Retry only operations whose semantics are safe. A connection failure after sending a transaction may leave commit outcome uncertain. Blindly replaying a non-idempotent payment or inventory update can duplicate effects. Use application idempotency keys, unique constraints, transaction identifiers or a state check to make replay safe. Retry the whole logical transaction only when it is valid to rerun from the beginning; do not resume halfway through a failed transaction with stale assumptions.

Classify connection-open errors, throttling, deadlocks and command timeouts separately. A timeout may mean the query is still executing or the client stopped waiting; cancel if supported and investigate server-side activity. Capture error numbers, correlation IDs, retry counts and operation identifiers without logging secrets or full sensitive parameters. Retry settings should not hide a resource saturation problem indefinitely.

## Testing failure behavior

Test from the deployed runtime with representative identity and network policy. Validate successful connection, token expiry refresh, pool reuse, DNS changes, controlled failover, service-tier scaling and a temporary denied connection. Observe how in-flight reads and writes behave. Use a test environment to simulate connection interruption and verify that the application returns controlled errors rather than a flood of reconnect attempts. Exercise the maximum concurrency and confirm that the combined pools remain within the capacity plan.

### Common mistakes

- Pinning a service IP or disabling certificate validation to work around DNS/TLS configuration.
- Assuming a private endpoint provides database authorization or disables public access automatically.
- Setting a large connection pool per process without multiplying by replicas and workers.
- Retrying every SQL exception or replaying non-idempotent writes after ambiguous commit outcomes.
- Reusing pooled connections without resetting tenant-specific session context.

### Production notes

Use a central connection-string configuration policy and document driver versions. Log connection acquisition time separately from command duration. Set explicit connect and command timeouts, bounded retries and pool limits. On incidents, inspect DNS resolution, identity token acquisition, firewall/route decisions and SQL authorization independently; “cannot connect” is not one failure mode.