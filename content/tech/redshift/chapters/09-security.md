# Security: IAM, Lake Formation, and Data Controls

Redshift security spans more than database users and `GRANT` statements. A production query can touch the database, an attached IAM role, S3 objects, a catalog, a KMS key, and possibly Lake Formation policies. Each is a distinct authorization boundary. A least-privilege design makes the chain explicit and tests it as the identity that actually runs the query—not just as an administrator who can access everything.

## Database identities and privileges

Use database roles to group permissions by job function: loader, analyst, reporting service, and operator. Grant schema `USAGE`, table `SELECT`, and write privileges only where required. Prefer role membership and controlled ownership over direct grants scattered across individual users. Separate administrative roles from application principals and avoid using a superuser for routine jobs. Database-level access is necessary for querying an object, but it does not grant permission to read an S3 object through Spectrum.

For provisioned clusters, Redshift can obtain AWS credentials through an IAM role associated with the cluster; Serverless workgroups have an equivalent role-association model. The role trust policy must allow the relevant Redshift service to assume it. Its permissions should be scoped to the required S3 prefixes, Glue Data Catalog operations, and KMS keys. External tables may also depend on Lake Formation grants. Bucket policies, organization controls, and encryption policies can deny access even when the role policy appears permissive.

Do not place static AWS access keys in SQL or application configuration. Use IAM roles and supported credential mechanisms. Keep production and development roles distinct, and rotate or revoke access through the IAM control plane rather than database scripts.

## Lake Formation and data-lake access

Lake Formation can centralize authorization for cataloged data, including table- and column-oriented access patterns supported by the integration. Configure the Redshift role, catalog permissions, data location permissions, and grants to principals coherently. A common failure mode is granting a database user access to an external schema while the underlying IAM role lacks the corresponding catalog or location permission. Conversely, an overly broad role can let a user query arbitrary external paths if SQL-layer controls are weak.

Treat bucket paths and catalog entries as governed assets. If data is copied, exported, or shared into another account, its classification and access policy must follow it. Redshift data sharing controls consumer access to shared database objects but does not grant access to unrelated S3 data. Review producer and consumer permissions separately.

## Row-level security and masking

Row-level security (RLS) restricts which rows are visible under a policy based on the database user, role, or applicable session context. Use it when multiple tenants or business units share tables but need separate row visibility. Define policies explicitly, test as each target role, and watch for bypass privileges or administrative roles that are intentionally exempt. Do not depend on a client-provided tenant identifier unless it is securely established; otherwise a user may alter the context and see another tenant's rows.

Dynamic data masking (DDM) applies a masking policy to selected columns at query time, potentially with role-based conditions and different masking levels. It can reduce exposure of sensitive values while preserving useful structure for analysis. Masking is not encryption, data deletion, or a universal protection against all inference. Test joins, predicates, exports, views, and privileged access to ensure policy behavior matches the threat model. Avoid storing sensitive data in query labels or logs where it may be more widely visible than the underlying columns.

## Audit, system views, and encryption

Use encryption at rest and in transit according to organizational policy, and control access to customer-managed KMS keys carefully. Query history itself may contain sensitive literals and SQL text. `STL_QUERY` and `STL_QUERYTEXT` can expose user-submitted statements; system-log permissions such as unrestricted visibility should be granted sparingly. Audit access to operational views and export only the minimum history needed for longer retention.

Security testing should include a positive case and a negative case: the intended role can read its allowed rows and columns, and cannot read a disallowed object, S3 prefix, or masked value. Test after role changes, view recreation, schema deployment, and account sharing changes. Record which identity and role are assumed during external scans so that incident responders can trace the authorization path.

## Security review and incident readiness

Map every principal to a purpose: application service, human analyst, loader, deployment automation, and operator. Document database role membership separately from the AWS role assumed by the cluster or workgroup. This separation helps an incident responder answer two different questions: which SQL objects could the user query, and which AWS resources could the workload identity reach? Review role trust policies, bucket policies, KMS key grants, and database grants together when access changes.

For sensitive data, use both positive and negative tests. Confirm that the authorized analyst can run a required report and that an unauthorized role cannot query the source table, reach a disallowed S3 prefix, or recover raw values through an alternate view or export. Verify masking and RLS after adding roles, changing ownership, or recreating objects. Include administrative break-glass paths, but require auditability and avoid routine use of them.

Prepare for query-log exposure. System views may retain full or partial SQL text, and users with broad visibility can learn about other teams' data and parameters. Restrict system-log permissions, normalize or redact sensitive literals in exported monitoring, and define retention. When diagnosing an external access incident, preserve relevant audit events and the assumed role identity before changing policies. A broad permission grant can erase evidence about the failing boundary and leave a permanent exposure. Make the smallest change, test it, and record why it was necessary.

## Security operations

Review access periodically rather than only during onboarding. Remove inactive principals, confirm service roles still need each prefix, and compare effective permissions after nested role memberships or account policy changes. Keep development data appropriately masked and avoid copying production snapshots into less controlled environments without a data-handling review. Use distinct roles for deployment and runtime so application code cannot grant itself additional access.

A security test suite should be part of release automation for sensitive datasets. Include the exact queries used by BI tools, because a policy that works in a direct table query may interact differently with views or aggregation. Validate both policy correctness and expected application behavior. If access is denied, the test should report which principal and resource failed without printing secrets or sensitive row contents into CI logs. Store audit evidence with limited retention and access.

For external data, inventory the bucket prefixes and encryption keys reachable by each Redshift role. A broad role can outlive the schema or external table that originally justified it. Remove permissions when datasets retire, and verify that object lifecycle policies do not delete files still required by active consumers. Security boundaries should match the lifecycle of the data, not merely the lifecycle of one SQL object.

## Common mistakes

- Assuming a SQL grant is sufficient for Spectrum access.
- Giving an IAM role broad bucket access to resolve one external-table error.
- Treating masking as a substitute for authorization or encryption.
- Building RLS on an untrusted user-supplied tenant value.
- Granting system-log visibility without considering sensitive SQL text.
- Forgetting that S3, Glue, KMS, Lake Formation, and database privileges must all align.
