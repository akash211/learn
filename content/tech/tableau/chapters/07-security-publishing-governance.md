# Row-Level Security, Publishing, and Governance

## Security begins with the data path

Row-level security (RLS) means a user can query only the rows they are authorized to see. In Tableau, security can be enforced at the database or warehouse, in a governed data source or virtual-connection policy where available, or through workbook calculations and user filters. These approaches have different trust boundaries and operational properties. Prefer a centralized control that applies to all access paths when the platform and source support it. A filter on a dashboard is not RLS: it can be removed, omitted from another worksheet, or bypassed by a different workbook or direct source connection.

Database-native policies can use the authenticated identity or a controlled service identity with a secure mapping from the Tableau user to entitlements. When Tableau connects with a shared account, the database may see that shared identity rather than the individual viewer; delegated authentication or another supported identity propagation design may be required. Validate what identity the source actually receives. A workbook that displays `USERNAME()` does not prove that the database enforces the same user's authorization.

A Tableau data source can also implement user filtering. A common pattern maps users or groups to permitted dimension values and uses a calculation based on the current viewer's identity. Functions such as `USERNAME()` and `ISMEMBEROF()` are useful in appropriate designs, but group membership is not always equivalent to a complete row-entitlement model. Validate the function's behavior in Desktop, Server, Cloud, and embedded contexts. A user filter can be made difficult to alter through publishing and permissions, but you must test every route to the data, including downloads, web authoring, subscriptions, and connected workbooks permitted by the deployment.

Some Tableau deployments offer centralized data policies through virtual connections or related governance features; availability depends on product, licensing, and configuration. These can make access logic reusable across consumers. Confirm the policy is attached to the actual published connection and that permissions prevent users from bypassing it through an ungoverned source. A policy's presence in one project does not secure a separate extract or workbook containing a copy of the data.

## Entitlements and least privilege

A robust entitlement model starts with a clear mapping: user or group, allowed business entity, effective dates, and source key. Use stable identifiers rather than display labels that can be renamed or duplicated. Decide what happens when a user has no mapping, has several mappings, leaves the organization, or changes role. The safe default is typically deny access rather than show all rows; test that behavior explicitly.

Keep the entitlement table maintained by an authoritative process, assign an owner, and monitor stale or conflicting records. If users can belong to overlapping groups, define whether access is additive and how exceptions are handled. Join cardinality matters: duplicated entitlement rows can duplicate fact rows or broaden access unexpectedly. Test with synthetic users representing least privilege, broad access, no access, and edge cases. Compare actual visible keys with an independently computed expected set.

RLS is only one part of protection. Project and content permissions control who can view, edit, download, publish, or administer assets. Database grants control what a connection can query. Credential storage controls how scheduled refreshes authenticate. Row filters do not prevent a user with broad download or data-source permissions from exposing data through allowed export paths. Align permissions, source grants, extract content, and retention with the data classification.

## Publishing and promotion

Publishing moves a workbook or data source from an authoring context to a shared environment. Tableau Server and Tableau Cloud organize content through sites, projects, groups, roles, and permissions; exact administration varies. Separate development, test, and production areas or use an equivalent controlled workflow. Publish to a clearly owned project with a description, support contact, and business purpose. Decide whether to publish a workbook connected to a reusable data source or package a copy, and inspect what data and credentials are included.

Permissions should be assigned through groups where possible, with least privilege and intentional inheritance. Avoid granting broad capabilities merely to make a failed workflow convenient. Review project-level defaults and exceptions after migration or reorganization. A user who can edit a workbook may change filters, calculations, or connections; a user who can download data may have access beyond what the visible chart suggests. Test as a representative consumer, not as a site administrator.

Promotion should be repeatable. Keep workbook files and source definitions under suitable version control when the team's tooling permits. Record dependencies, data-source versions, and required credentials. Before replacing a production workbook, test calculations, actions, filters, rendering, mobile layouts, and refresh behavior in the target environment. Treat field rename/removal as a breaking change for dependent workbooks. If the platform supports content migration tooling, confirm its limits and preserve the permissions and connection mappings deliberately.

## Governance and lifecycle

A governed analytics catalog helps users distinguish trusted, supported content from personal exploration. Give certified or endorsed data sources a named owner, description, definitions, lineage, and freshness expectations. Certification is a discovery signal, not proof that every workbook is correct forever. Establish review cadence, change ownership, and a way to report discrepancies. Track duplicate workbooks and stale extracts and retire them with owners' approval.

Metric definitions need shared ownership. “Revenue,” “active customer,” and “margin” should state grain, exclusions, currency and time treatment, and whether values are estimated or final. Put reusable definitions in the layer best suited to govern them, such as a warehouse model or shared published source, and avoid proliferating subtly different local calculations. If a calculation must remain workbook-specific, label and document it as such.

Operational governance includes refresh monitoring, credential rotation, capacity and query monitoring, incident communication, and retention. A dashboard should state its last successful refresh when freshness matters and direct users to a support path. Plan for failed refreshes, source schema changes, owner departure, and emergency access changes. Periodically review who can publish, download, and administer content.

## Test security, not just the happy path

Create a security test matrix with allowed and denied identities, multiple entitlements, no entitlement, and unusual identifiers. Check both what a user sees and what they can download or access through other authorized routes. Test published content with real authentication and the actual connection mode. Verify that a change in group membership or entitlement is reflected within the expected delay. Retain evidence of expected row sets and permissions for important assets.

## Common mistakes

- Treating a dashboard filter or hidden worksheet as an authorization boundary.
- Assuming the database sees the individual Tableau viewer when using embedded credentials.
- Using a default-to-all rule when an entitlement mapping is missing.
- Ignoring download, web edit, extract, and alternate data-source paths.
- Publishing a packaged workbook with sensitive data or reusable credentials unintentionally.
- Treating certification as a substitute for ownership and ongoing review.

## Production notes

Security should be designed across identity, source access, published content, and data copies. Choose the enforcement point that covers the intended access paths, use least privilege, and explicitly deny unknown users. Validate by impersonating representative roles in a non-production environment and reconcile visible rows against expected entitlements. Record the design, exceptions, owner, and review date so that future authors do not weaken it accidentally.
