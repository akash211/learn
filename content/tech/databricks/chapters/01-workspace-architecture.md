# Workspace Architecture, Control Plane and Compute Plane

Databricks splits into two halves, and almost every operational question — where the data lives,
what a security review will ask, what breaks when a region has a bad afternoon — is answered by
knowing which half you are talking about. The **control plane** is Databricks-managed: the web
UI, notebook storage, job definitions and run state, cluster management APIs, query history and
the metadata of Unity Catalog. The **compute plane** is where Spark actually runs and where table
data is read and written.

The split exists for a commercial reason as much as a technical one. Customers would not accept
a vendor holding their bytes, so data stays in their cloud account; but customers also do not
want to operate the scheduler, notebook server and metastore, so those stay with Databricks.

## Account, workspace, metastore

Three objects are easy to conflate:

| Object | What it is | Scope |
|---|---|---|
| Account | Billing, users and groups, Unity Catalog metastore, workspace list | Organisation-wide, one per cloud |
| Workspace | A UI deployment with its own notebooks, clusters, jobs and permissions | One per environment, usually |
| Metastore | The Unity Catalog metadata container holding catalogs and grants | One per region, attachable to many workspaces |

A workspace is a working environment, not a security boundary. Two workspaces attached to the
same metastore see the same catalogs and are governed by the same grants; a user with access to
both can read the same tables from either. Teams that create a workspace per squad and expect
isolation are usually surprised by this. Isolation comes from catalogs and grants, not from the
workspace list.

The metastore is regional. A workspace in `eu-west-1` cannot attach to a metastore in
`us-east-1`, which is why multi-region designs end up with one metastore per region and either
replicated data or Delta Sharing between them. Legacy workspaces may still have a workspace-local
`hive_metastore`; it is not governed by Unity Catalog and should be treated as migration debt.

## What the compute plane looks like

For classic compute, Databricks launches VMs inside your subscription or project, in a VPC or
VNet that it creates or that you inject. Those VMs run the Spark driver and executors, and they
reach cloud storage directly using either an instance profile (AWS), a managed identity (Azure)
or a service account (GCP), or a Unity Catalog storage credential. Table bytes never traverse the
control plane. What does travel back is metadata: cluster state, notebook output, job status,
query plans, logs and the query history entries that make the SQL editor useful.

That distinction matters in a security review. "Databricks sees my data" is false in the
byte-path sense and true in a weaker sense: notebook cell output, query results you display,
table statistics and lineage are all metadata that leaves the account. If a result set is
sensitive, the honest controls are column masks, row filters and avoiding `display()` on raw PII,
not a claim that nothing ever leaves the VPC.

```text
            ┌──────────────────────────────┐
            │  Control plane (Databricks)  │
            │  UI · notebooks · jobs       │
            │  cluster API · UC metadata   │
            └──────────────┬───────────────┘
                           │  metadata, run state, results
            ┌──────────────┴───────────────┐
            │  Compute plane               │
            │  driver + executors          │
            │  (your VPC or serverless)    │
            └──────────────┬───────────────┘
                           │  direct read/write
                    ┌──────┴──────┐
                    │ Object store│  S3 / ADLS / GCS
                    └─────────────┘
```

**Serverless compute** moves the compute plane into a Databricks-managed account in the same
region, which is why a serverless notebook or job starts in seconds rather than minutes: there is
no VM to boot and no init script to run. The price is control. Serverless restricts cluster-level
configuration, init scripts and library installation to supported mechanisms, and diagnostics
come from the run page and query profile rather than a full Spark UI you can browse. It also
changes the network story: your VPC peering rules and private endpoints do not apply to serverless
egress in the same way, so check the current networking documentation before assuming a private
path to an on-premise source.

## Networking choices that constrain the rest

Classic compute can be deployed with **no public IP** (secure cluster connectivity), where nodes
have no inbound route and reach the control plane over a relay. Private Link or private endpoint
connections can keep control-plane traffic inside the cloud backbone, and VNet injection lets you
place clusters in a subnet you control with your own route tables, DNS and firewall rules.

These are not cosmetic. A cluster that cannot reach a Kafka broker or an on-premise JDBC endpoint
usually fails for a network reason, not a Spark reason, and the error surfaces as a timeout in a
task rather than as a configuration complaint. When a pipeline works in one workspace and not
another, compare the compute plane's network path before rewriting the code.

## Where storage actually lives

Three storage surfaces are commonly confused:

- **DBFS root** — a per-workspace bucket Databricks created. Convenient scratch space, not a
  governed data location. New workspaces may restrict or disable it.
- **Mounts** (`/mnt/...`) — legacy DBFS mount points over external storage. They bypass Unity
  Catalog grants, which is why many organisations are removing them.
- **External locations and volumes** — Unity Catalog objects that bind a cloud path to a storage
  credential. Tables created there are governed; so are files written through a volume.

The practical rule: production tables belong in a Unity Catalog external location or in the
metastore's managed storage, never in the workspace's DBFS root. Managed tables are the simpler
default because Databricks owns the lifecycle and predictive optimization can maintain them;
external locations exist for data you must keep at a fixed path or share with another engine.

## Failure domains

Because the halves are separate, they fail separately. If the control plane is unavailable you
may be unable to start clusters, edit jobs or open the UI, while already-running classic clusters
keep executing work and writing to storage. A scheduled job may still fire if the scheduler's
state is intact, or may not — this is exactly the kind of assumption to test in a game day rather
than discover during an incident.

Conversely, a storage outage or an expired credential takes down compute that is otherwise
healthy, and the control plane will happily show you a running cluster whose every task fails on
`403 Forbidden`. Log the two failure classes separately in your runbooks: "cannot reach the
platform" and "platform cannot reach the data" have different escalation paths.

## Common mistakes

- **Treating a workspace as an environment boundary.** Grants and catalogs isolate; workspaces do not.
- **Putting production tables on the DBFS root.** No external location, no clean lifecycle, no portability.
- **Assuming no data leaves the account.** Results and metadata do; plan masks and filters accordingly.
- **Expecting serverless to behave like a classic cluster.** Init scripts, custom JVM flags and full Spark UI access are not part of the deal.
- **Forgetting the metastore is regional.** A disaster-recovery plan that assumes cross-region catalog attachment will not work.
- **Mixing `hive_metastore` and Unity Catalog tables in one pipeline.** Grants, lineage and optimization behave differently, and the difference is invisible until an audit.

## Production notes

Pick the region once, early, because metastore, storage and egress all anchor to it; moving later
is a data migration, not a configuration change. Use separate workspaces for development and
production if you want separate cluster policies and budget visibility, but put both on the same
metastore so grants and lineage are continuous.

Give compute a storage credential scoped to the paths it needs rather than an account-wide role,
and prefer Unity Catalog external locations over instance profiles for new work. Record which
workloads run on serverless and which on classic compute: the two have different debugging tools,
different network paths and different cost profiles, and an incident responder who does not know
which one a failing job used will look in the wrong place first.
