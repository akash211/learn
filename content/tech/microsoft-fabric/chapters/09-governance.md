# Governance, Domains and Deployment

Fabric governance has a reputation problem: there are many controls, they overlap, and each
one protects a different boundary. The useful mental model is layers — tenant, domain,
workspace, item, data — and a clear answer to "which layer enforces this requirement?"

## Layer 1: the tenant

Tenant settings decide what exists at all: whether Fabric can be enabled on P capacities,
whether users can create workspaces, whether external sharing is allowed, whether Copilot
processes data outside the region, whether service principals can call APIs. Fabric admins and
capacity admins are separate roles — a capacity admin can resize and pause, but does not
automatically govern content.

Most governance failures at this layer are omissions, not mistakes: nobody decided whether
users may create workspaces, so everybody did, and six months later there are 400 workspaces
with no owner.

## Layer 2: domains

A **domain** is a business boundary — Finance, Supply Chain, Marketing — that groups
workspaces. Domains give you:

- **Delegated administration.** A domain admin manages workspaces in their domain without
  tenant-wide rights. This is how you scale governance beyond a central team.
- **Discovery.** Users browse the OneLake catalog by domain instead of guessing workspace names.
- **Defaults.** A domain can carry a default sensitivity label that new items inherit, which is
  the cheapest way to stop unlabelled content accumulating.

Domains do not move or copy data, and they do not by themselves restrict access. They are an
organising and delegation layer. If you need isolation, that is still capacity and workspace
permissions.

## Layer 3: workspaces and roles

Workspace roles are the workhorse:

| Role | Can do |
|---|---|
| Admin | Everything, including adding/removing members and deleting the workspace |
| Member | Publish, edit, share, and manage permissions on items |
| Contributor | Create and edit content, cannot manage access |
| Viewer | Read content |

Two Fabric-specific traps. First, a Viewer can read data through a shortcut or a semantic model
even if they have no direct lake permissions — access follows the item, not the files. Second,
item-level sharing can grant access to a single report or model without workspace membership,
which is convenient and easy to lose track of. Audit both.

For automated processes, use a **workspace identity** or a dedicated service principal rather
than a person's account, and give it Contributor at most.

## Layer 4: the data

This is where the real granularity lives, and where the options differ by item type:

- **Warehouse / SQL endpoint** — T-SQL `GRANT`/`DENY` on objects, row-level security,
  column-level security, dynamic data masking (check which of these are GA in your region;
  masking and some security features have moved through preview).
- **Lakehouse** — workspace roles plus **OneLake security** roles for row/column/file-level
  enforcement at the storage layer (this has been rolling out in preview; verify status before
  designing a regulated solution around it).
- **Semantic model** — RLS and OLS in DAX, plus a fixed identity for Direct Lake data access.
- **Sensitivity labels** — Microsoft Purview information-protection labels applied to items.
  Labels propagate downstream: a report inherits the label of the model it queries, and export
  restrictions (PDF, Excel, PowerPoint) follow the label. They do not propagate through external
  shortcuts, and they do not encrypt the Parquet files themselves.

The honest summary: SQL security protects SQL access, OneLake security protects file access,
model security protects DAX access. If you only implement one, you have three holes.

## Lineage and cataloguing

Lineage in Fabric comes in two flavours. **Workspace lineage view** shows item-to-item
dependencies inside a workspace; the **OneLake catalog** and item lineage extend discovery
across workspaces. For cross-system lineage — ADF, Databricks, on-prem SQL — you need Microsoft
Purview, which also hosts the enterprise catalog and can scan Fabric items.

Endorsement is the cheap social layer: **Promoted** means "the team thinks this is good",
**Certified** means an authorised reviewer checked it. Certified items are what you point
executives at. Neither is a security control.

## Layer 5: deployment

Fabric gives you two promotion mechanisms, and they solve different problems:

| | Git integration | Deployment pipelines |
|---|---|---|
| Purpose | Version control, branching, code review | Promotion across dev/test/prod |
| Unit | Workspace ↔ branch | Pipeline stages, one workspace each |
| Handles | Item definitions as files | Item metadata plus deployment rules |
| Does not handle | Environment-specific parameters | Branching and merge review |

In practice you use both: Git for source control and pull requests, deployment pipelines for
promotion. Deployment pipelines support **deployment rules** that swap data source connections
and parameter values per stage, **selective deployment** of chosen items, and a **compare** view
that shows what differs between stages. Two constraints to design around: the number of stages
is fixed at creation, and not every item type is supported — the supported list changes
frequently, so check it before you promise a fully automated release.

The new deployment-pipeline UI has been in preview; the underlying behaviour is the same, so
automate against the REST APIs rather than against a specific portal layout.

## Common mistakes

- Governing only by workspace, so one over-broad Member role gives away the estate.
- Assuming a sensitivity label encrypts data at rest in OneLake. It governs handling and export,
  not storage.
- Deploying by clicking through the portal because "the pipeline doesn't support that item type".
- No owner on workspaces; orphaned content is the most common audit finding.
- Treating a domain as a security boundary.
- Certification handed out to everything, which makes it meaningless.

## Production notes

Write down the control matrix: requirement → layer → control → who audits it. Keep one
workspace per layer per domain (`finance-bronze`, `finance-gold`), name items predictably, and
use deployment pipelines to promote rather than recreate. Enable Purview scanning if you need
cross-platform lineage, and review workspace membership quarterly — group-based access is
better than named individuals, but only if the groups are maintained.
