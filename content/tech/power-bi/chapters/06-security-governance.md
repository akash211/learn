# Row-Level Security and Workspace Governance

Security in Power BI spans identity, source access, semantic-model permissions, row-level security (RLS), workspace roles, app audiences and tenant policy. These controls are related but not interchangeable. RLS filters rows for viewers of a semantic model; it does not encrypt data from workspace administrators, model owners or someone who can download and inspect an unrestricted copy. Design access from the data classification and threat model, then test each audience with its actual identity.

## Static and dynamic RLS

Roles define DAX filter expressions over model tables. A static role can filter a region dimension, for example `Region[Code] = "NW"`. To support many users without one role per person, dynamic RLS can map the signed-in identity to an entitlement table:

```DAX
UserAccess[UPN] = USERPRINCIPALNAME()
```

The entitlement table should contain normalized identities and allowed keys, and its relationships must propagate the intended filter to facts. Test users with one, several and zero assignments, plus case and identity-format variations. Use “View as” in Desktop for development, then test role membership and effective identity in the service. Service behavior and identity claims can differ from local testing.

Assign security groups to roles where practical and manage membership through the identity lifecycle. RLS applies to viewers (including app consumers) but does not constrain workspace Admin, Member or Contributor roles in the same way as a read-only audience. Build a negative test: verify that a user cannot see another region through a measure, drill-through, export or alternate report. Object-level security can restrict tables or columns in supported configurations, but it is not a substitute for correct role design.

## Security beyond report visuals

Security testing should include paths beyond a normal report page. Build permission may enable Analyze in Excel or other clients, and export settings can alter where data flows. Verify whether users can download a PBIX, create a new report from the model, use an API, or reshare content under the organization's settings. Disable capabilities that are not required for a sensitive audience, and document what remains possible. Sensitivity labels and tenant controls can add guardrails, but administrators must validate their effect in practice.

Dynamic security models need an identity lifecycle. Decide how aliases, renamed accounts, guests and multiple email addresses map to a canonical principal. Entitlement data should be updated when a user changes teams or leaves, and stale grants should be removed promptly. If the entitlement table is imported, its own refresh lag becomes a security latency. If access is assigned through nested groups, validate how group membership is resolved in the relevant service feature. Include negative tests for missing identities and conflicting assignments; defaulting an unknown principal to unrestricted data is dangerous.

Separate the right to see a report from the right to edit its underlying model. A consumer can receive an app view while authors work in a development workspace. If self-service Build is needed, provide a governed semantic model, clear guidance on metric reuse and an appropriate workspace for authored reports. This lets teams explore without granting production artifact modification. Audit unused permissions and stale workspaces on a schedule, and make a business owner accountable for each production item.

## Workspaces and least privilege

A workspace is a collaboration and deployment boundary, not automatically a security boundary for every item. Use separate development, test and production workspaces or another explicit release design. Give contributor access only to authors who need to edit content. Consumers should normally use an app or view permissions rather than broad workspace roles. Semantic-model Build permission enables additional uses such as creating reports or querying the model; grant it intentionally. Reshare and reshare/build permissions should also be reviewed.

Publish an app for stable audience-facing distribution, organize content for user tasks, and control app audience access. Sensitivity labels, tenant settings, audit logs and data-loss prevention can complement workspace design, depending on organizational configuration. Document who owns the model, refresh, gateway, capacity and incident response. Assign backup owners so a departing author does not strand a production artifact.

## Deployment pipelines, endorsements and release control

Deployment pipelines support promotion across development, test and production stages in eligible environments. They can compare content and apply deployment rules for supported settings, but do not replace source control, release review or environment testing. Verify parameters, credentials, data source bindings, refresh schedules, RLS role assignments and app publication after deployment. A successful artifact deployment does not prove the production model refreshes or that consumers retain the correct access.

Endorsement labels help users find trusted content. Promoted status and certified status have different governance implications; certification is generally controlled by designated tenant processes. An endorsement is a trust signal, not a technical guarantee that a KPI is correct. Define criteria: owner, documentation, lineage, reconciliation tests, security review, refresh SLO and support contact. Review it periodically as source and business definitions change.

### Common mistakes

Governance is strongest when it is built into ordinary release work. Add access review, RLS tests and model-owner confirmation to the deployment checklist instead of performing them only after an incident. Document the business definition of sensitive columns, acceptable sharing, export rules and data retention. When external guests or embedded users are involved, test those identities and their actual token claims; do not assume internal account behavior transfers. Keep app audience membership and role membership synchronized through managed groups where possible. A role can be correct but ineffective if no one is assigned, or overly broad if a group contains unexpected users. Review audit information and usage to find orphaned reports, stale workspaces and excessive grants. Removal should be coordinated with the owner and downstream dependencies. Make approval proportionate to risk: a routine wording change need not follow the same process as a new cross-tenant entitlement path, but both should have traceable ownership.

Security reviews should check the least-privilege principle at the data source as well as the BI service. If a model refresh uses a broad shared credential, a report-level RLS role cannot make that credential safe for unrelated consumers. Use dedicated identities and grant only the source permissions required for the model's intended queries. Keep credentials out of M expressions and report files, and monitor changes to connection ownership. A well-scoped source identity reduces impact if a model is misconfigured or an artifact is shared unexpectedly.

- Assuming RLS protects data from workspace editors or model owners.
- Giving every analyst Contributor access when they only need to consume a report.
- Testing roles only with a Desktop “View as” simulation.
- Treating deployment pipelines as a substitute for validating credentials, refresh and audience membership.
- Confusing endorsement with proof of correctness or certification with a report's visual polish.

### Production notes

Maintain a permissions matrix listing identity group, workspace role, app audience, Build access, RLS role and data classification. Reconcile it periodically and after team changes. Keep deployment approvals and test evidence with the release. For sensitive data, verify not only report visuals but also export, Analyze in Excel, Build, APIs and other permitted access paths under the intended license and tenant policy.
