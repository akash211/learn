# Identity, Network and Data Security

Security in Azure SQL Database is a chain of controls, not a single firewall switch. A secure design establishes who can reach the endpoint, how the client authenticates, what the authenticated principal may do, how sensitive values are protected, and how data at rest is encrypted. The database team must configure these controls and validate them together. A private network path does not grant database permissions, and encryption at rest does not stop an authorized identity from reading a table.

## Microsoft Entra authentication and authorization

Microsoft Entra authentication (formerly Azure Active Directory authentication) allows users and workloads to obtain tokens from an identity provider rather than relying solely on SQL logins and passwords. Configure a Microsoft Entra administrator for the logical server. That principal can bootstrap database users and grant access. Use database-scoped users mapped to Entra users, groups or applications, then apply least-privilege database roles and object grants. Group-based grants simplify lifecycle management; removing a user from the centrally managed group can revoke access consistently.

Applications can use a managed identity, avoiding a long-lived database password in configuration. A system-assigned identity follows the Azure resource lifecycle, while a user-assigned identity can be shared across selected resources and survive replacement of one compute resource. Grant the identity a database principal and only the permissions needed. Managed identity solves secret distribution, not authorization: an overprivileged identity remains overprivileged. Test token acquisition from the actual hosting environment, and ensure driver support and token renewal behavior are understood.

Azure SQL Database also supports SQL authentication in relevant configurations. Where it remains necessary for compatibility, protect credentials in a secret store, rotate them, restrict their use and avoid embedding them in code or deployment logs. Do not conflate Azure RBAC on the resource with SQL permissions. Azure RBAC controls Azure resource management operations; database authorization controls access to data and database objects. A role that can alter a resource is not equivalent to `db_datareader`, and vice versa.

Use contained database users where appropriate and create grants intentionally. Avoid broad fixed roles simply to make an application connect. Review principals and permissions periodically, especially after migrations and role changes. Enable auditing to capture relevant security events and route the audit destination to a protected, monitored store with retention suited to the policy.

## Firewall, private endpoints and connectivity boundaries

Azure SQL Database has a logical-server firewall that can allow or deny network source ranges for public endpoint access. Server-level firewall rules apply across databases under that logical server, so treat them as a shared exposure boundary. Database-level firewall rules can further allow specific sources where supported. “Allow Azure services and resources to access this server” is a broad exception, not a private network connection; it can allow connections from Azure-originated resources outside the intended application boundary. Use it only with an understood threat model.

For private access, Azure Private Link and a private endpoint associate the SQL service with a private IP in a virtual network. DNS is essential: clients should resolve the documented service name to the private endpoint address on the intended network path. Configure private DNS zones and links correctly, and test from application subnets and operational workstations. A private endpoint does not automatically turn off public network access; explicitly set the public access policy to match the design and verify effective connectivity from both allowed and disallowed networks.

Network security groups and routing govern reachability to the endpoint and adjacent services. Keep outbound rules and DNS behavior in view. Operational access via VPN, ExpressRoute or a controlled jump environment may have different source addresses from application traffic. Document each path and avoid opening wide IP ranges to resolve a connectivity problem without determining the actual source. Use connection policy and redirection behavior appropriate to the application's network; see the connectivity chapter.

## Encryption: TDE and Always Encrypted

Transparent Data Encryption (TDE) protects database files, transaction logs and backups at rest. It is generally enabled by default for Azure SQL Database, but verify the actual resource configuration and key-management policy. Platform-managed keys reduce operational key-handling work; customer-managed keys in Azure Key Vault or Managed HSM can provide control over key lifecycle and separation of duties. When using customer-managed keys, plan permissions, key rotation, soft delete, purge protection, recovery and availability. Revoking or losing key access can make the database unavailable. TDE does not encrypt traffic by itself and does not prevent an authorized query from returning plaintext.

Always Encrypted protects selected sensitive column values from the database engine by encrypting and decrypting in a trusted client driver. The server stores ciphertext and cannot ordinarily inspect plaintext for protected values. Always Encrypted with secure enclaves can enable a broader set of operations on protected data in supported configurations. This feature changes schema, parameterization, query capabilities and key management, so test the exact driver, enclave configuration and operations required. The column master key and column encryption key have distinct roles; protect and back them up according to the selected key store. A client authorized to decrypt data can still expose it through compromised code or logs.

Transport encryption uses TLS between client and service. Use current supported driver versions, validate certificates, and avoid options that trust any server certificate. Encryption settings should be explicit in connection configuration where possible. Rotate client certificates or keys under a process that avoids an unplanned outage.

## Row-level security and auditing

Row-level security (RLS) uses a security predicate to filter or block rows based on execution context. It can centralize tenant isolation, but it is only as sound as the predicate, identity context and privileged-path controls. Build a schema-bound inline table-valued predicate function and security policy, then test reads, inserts, updates, deletes, joins, background jobs and admin workflows under realistic principals. Use `SESSION_CONTEXT` only when the application securely establishes and validates the tenant context; a client-controlled session value is not a trustworthy identity on its own. Consider connection pooling: session context must be set on every checkout and not leak across tenants.

Auditing can record database events to Azure Storage, Log Analytics or Event Hubs, depending on configuration. Define which events matter, who can change audit policy, how logs are protected, and how alerting and retention work. Auditing is evidence, not a preventative control. Combine it with Microsoft Defender for SQL capabilities if licensed and enabled for the subscription, while treating recommendations and alerts as signals to investigate rather than proof of exploitability.

### Common mistakes

- Confusing Azure RBAC permissions with SQL database roles.
- Treating a firewall allow rule or private endpoint as an authorization grant.
- Assuming TDE hides data from query users or encrypts client traffic.
- Adding RLS without testing tenant context reset, elevated identities, and write paths.
- Using a managed identity but granting it broad database ownership unnecessarily.

### Production notes

Write a threat model that lists identities, network paths, key custodians and sensitive data. Automate configuration checks for public network access, firewall ranges, Entra-only authentication policy where applicable, auditing and key settings. Rehearse identity revocation, key recovery and incident response without exposing production secrets.