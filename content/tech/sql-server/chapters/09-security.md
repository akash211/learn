# SQL Server Security

SQL Server security has two distinct questions: who can connect, and what that principal may do after connecting. A login is an instance-level principal; a database user maps that login into a database. Contain permissions through roles and grants rather than handing application identities broad server roles. Encryption in transit, at rest and at the column/field layer solve different threats.

## Logins, users and roles

A SQL Server login can use Windows or Microsoft Entra authentication where supported, or SQL authentication with a managed password. Inside each database, a user receives permissions through roles and direct grants. A contained database user reduces dependence on a server login for some scenarios. The `dbo` user and `sysadmin` server role have extensive privileges and should not be used by routine application accounts.

Prefer least privilege: grant only required operations on specific schemas or objects, and use custom database roles to group those permissions. Built-in roles such as `db_owner` are convenient but broad. Avoid granting permissions to `public` without understanding that every database user inherits them. Review `sys.server_principals`, `sys.database_principals`, `sys.database_role_members` and `sys.database_permissions` to audit membership and grants. Orphaned users may appear after a database move when a SID no longer matches a server login.

Applications should use distinct identities by service and environment. Integrated authentication can avoid embedding SQL passwords, but requires correct service identity and delegation design. Credentials should be rotated and stored in a secret manager, not in source code or deployment logs. Dynamic SQL must be parameterized with `sp_executesql`; concatenating user input creates injection risk even when the caller's database permissions are limited.

## Row-level security

Row-level security (RLS) uses a security predicate, typically an inline table-valued function, attached through a security policy. A filter predicate silently restricts rows visible to a principal; a block predicate rejects writes that would violate the policy. RLS can centralize tenant filtering, but its correctness depends on trustworthy identity context. If the application can set `SESSION_CONTEXT`, ensure users cannot spoof the tenant identity through an untrusted application path.

Test RLS with actual users and every access path, including views, stored procedures, bulk load and administrative accounts. Policies can change plan shape or add predicate overhead, and privileged roles may bypass them. RLS is one layer of defence, not a substitute for authorization, tenant isolation tests or auditing.

## Always Encrypted and other encryption

Always Encrypted protects selected column values from the Database Engine and database administrators by encrypting/decrypting data in a trusted client driver. Column encryption keys are protected by column master keys held outside the database, for example in a certificate store or key vault. Deterministic encryption supports equality comparisons and indexing in supported cases but leaks equality patterns; randomized encryption offers stronger confidentiality but restricts server-side operations. Secure enclaves can enable additional operations in supported configurations. Driver, SQL Server version, service, and key management support must be verified before designing the schema.

Always Encrypted is different from Transparent Data Encryption (TDE). TDE encrypts database files and backups at rest while the engine transparently processes plaintext; it does not stop a privileged database operator from querying values. TLS protects data in transit. SQL Server Audit records configured server/database events and should be sent to a protected target with retention controls. None of these controls replaces backup-key recovery procedures.

Key lifecycle deserves the same design attention as query design. Define key owners, rotation and revocation procedures, client-driver distribution, backup and escrow requirements, and what happens when an employee or service is decommissioned. Encrypting a column without a tested way to recover its key can make the data permanently unreadable. For TDE, protect the database master key and certificate outside the instance and include them in disaster-recovery exercises. Audit policies also need a retention and tamper-resistance plan; collecting events without alerting or review is not an effective control.

## Production controls

Use encrypted connections and validate certificates rather than disabling certificate checks. Protect service accounts, SQL Agent proxies, linked-server credentials and backup encryption keys. Enable auditing for high-risk actions and review actual exposure. On managed Azure SQL products, the identity model and permission boundaries differ from a self-managed instance; consult the exact service's support matrix.

## Common mistakes

- Treating a database user and an instance login as the same principal.
- Giving an application `sysadmin` or `db_owner` because it avoids permission troubleshooting.
- Assuming TDE hides data from privileged database users or is equivalent to Always Encrypted.
- Using deterministic encryption without acknowledging equality leakage and query limitations.
- Relying on a tenant predicate where callers can forge `SESSION_CONTEXT`.
- Storing SQL passwords or encryption keys in source code, scripts or the same backup location they protect.


## Permission design and auditing

Authentication establishes a principal; authorization evaluates permissions on server and database securables. Use separate identities for application services and environments, map them to narrowly scoped database roles, and grant operations at the needed schema or object boundary. Ownership chaining can allow a stored procedure to access underlying objects without granting callers direct table access, but dynamic SQL can break the chain and requires explicit permissions or carefully configured module signing. Avoid solving a permission error by granting `db_owner`; identify the exact missing operation and test with the actual runtime identity.

Audit effective permissions, not only direct grants. Role membership can be nested, and server-level privileges may dominate database-level restrictions. Catalog views such as `sys.database_role_members`, `sys.database_permissions`, `sys.server_role_members` and `sys.server_permissions` help inventory grants. Metadata visibility means a low-privilege principal may not see every object in these catalogs. Review orphaned users after restore or migration by comparing SIDs, and include service accounts, SQL Agent proxies and linked-server credentials in the threat model.

Dynamic SQL should parameterize values with `sp_executesql`; identifiers cannot be passed as ordinary parameters, so validate and quote them with `QUOTENAME` from an allowlist. Parameterization reduces injection risk and can enable plan reuse, though dynamic statements with different shapes may compile separately. Do not assume stored procedures are inherently safe if they concatenate untrusted text.

## Row-level security as a boundary

An RLS filter predicate can enforce tenant visibility in the database, but the predicate's tenant identity must come from a trustworthy source. If `SESSION_CONTEXT(N'tenant_id')` is set by application code that shares a database principal across tenants, an attacker able to issue arbitrary SQL as that principal may attempt to set another tenant's context. Establish whether callers can execute arbitrary statements, who sets context, whether pooled connections clear it, and how signed modules or separate principals constrain changes. Test both reads and writes: a filter predicate and a block predicate enforce different behavior.

Test access via direct tables, views, stored procedures, bulk paths, administrative support tools and privileged roles. RLS can affect cardinality estimates and plan shape; check performance and ensure policy changes are deployed and audited. It complements application authorization and tenant isolation tests, not a replacement for them.

## Encryption boundaries and recovery

TDE protects database files and backups at rest, while the engine sees plaintext during query execution. Always Encrypted aims to keep selected column values opaque to the Database Engine; a trusted client driver handles encryption using external keys. Deterministic encryption permits limited equality comparisons but exposes equality patterns; randomized encryption is more restrictive. Secure enclaves, drivers and service versions change capabilities. TLS protects transport, not stored files. For each control, name the threat it addresses and the privileged actor it does not protect against.

Key lifecycle is part of availability: inventory owners, access, rotation, escrow, certificate backup and restore steps. A TDE certificate or Always Encrypted key unavailable during recovery can make otherwise intact backups unusable. SQL Server Audit should write to a protected destination with retention, alerting and review. Measure policy coverage and test restoration of both data and key material; a checkbox that says “encryption enabled” is not a complete security design.
