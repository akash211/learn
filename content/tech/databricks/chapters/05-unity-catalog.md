# Unity Catalog, Grants and Lineage

Unity Catalog is the governance layer that turned Databricks from a set of workspaces into a
platform. Before it, every workspace had its own Hive metastore, table names were workspace-local,
and access control stopped at "can you attach to the cluster". Unity Catalog replaces that with a
single three-level namespace, storage credentials that are explicit objects, and grants that
follow the data rather than the compute.

## The object model

```text
metastore (one per region)
└── catalog            prod, dev, sandbox_ana
    └── schema         bronze, silver, gold
        ├── table      gold.orders_daily
        ├── view
        ├── volume     raw_landing (files, not tables)
        ├── function
        └── model
```

The metastore holds metadata and grants; it does not hold table data. A catalog is the main
isolation boundary — teams get a catalog, environments get a catalog, and cross-catalog queries
are possible but deliberate. A schema groups objects by zone or subject. Names are
`catalog.schema.object`, and the two-part name you may remember from Hive (`schema.table`) only
resolves inside the workspace's default catalog.

One metastore per region, attachable to many workspaces. That is the constraint that shapes
multi-region designs: a workspace cannot attach to a metastore in another region, so
cross-region sharing goes through Delta Sharing or replication, not through a shared catalog.

## Storage credentials and external locations

Unity Catalog does not use instance profiles for table access. It uses two objects:

- **Storage credential** — a cloud identity (IAM role, managed identity, service account) that
  Databricks is allowed to assume, with an external ID to prevent the confused-deputy problem.
- **External location** — a credential plus a storage path, validated at creation time for read,
  write, list and delete.

```sql
CREATE STORAGE CREDENTIAL acme_lake
  WITH AWS_IAM_ROLE 'arn:aws:iam::123456789012:role/databricks-uc';

CREATE EXTERNAL LOCATION prod_lake
  URL 's3://acme-lake/prod'
  WITH (STORAGE CREDENTIAL acme_lake);

CREATE CATALOG prod
  MANAGED LOCATION 's3://acme-lake/prod/managed';
```

The validation step matters. A role that can read but not delete produces a location that works
for `SELECT` and fails on `OPTIMIZE`, `VACUUM` and overwrite — usually weeks later, in a
maintenance job nobody watches.

## Managed versus external tables

| | Managed | External |
|---|---|---|
| Data location | Under the schema or catalog managed location | A path you registered |
| Lifecycle | `DROP TABLE` deletes the data | `DROP TABLE` removes metadata only |
| Maintenance | Predictive optimization can handle it | You schedule `OPTIMIZE` / `VACUUM` |
| Portability | Tied to the catalog | Readable by other engines at a known path |

Default to managed. Managed tables get the platform's automatic maintenance, a predictable
layout and no orphaned directories when a table is dropped. Use external tables when the path is
contractual — data landed by another system, a shared zone, a migration in progress — and accept
that you now own its maintenance and cleanup.

**Volumes** cover the non-tabular case: a governed path for CSV drops, model artefacts, images or
anything a table cannot hold. Volumes get grants like tables, which is the point; they replace the
`/mnt` mounts that bypassed governance entirely.

## Grants

Privileges are granted on securables and inherit downward: a grant on a catalog applies to its
schemas and tables, a grant on a schema applies to its objects.

```sql
GRANT USAGE ON CATALOG prod TO `data-analysts`;
GRANT USE SCHEMA ON SCHEMA prod.gold TO `data-analysts`;
GRANT SELECT ON TABLE prod.gold.orders_daily TO `data-analysts`;

GRANT MODIFY, SELECT ON SCHEMA prod.silver TO `data-engineers`;
GRANT CREATE TABLE ON SCHEMA prod.silver TO `data-engineers`;
```

The traps are in the prerequisites: `SELECT` on a table is useless without `USE SCHEMA` on its
schema and `USAGE` on its catalog, and the error you get in that case is a permission denied that
names the table, not the missing parent grant. `MODIFY` covers insert, update, delete and `MERGE`
on the target, but it does not include read — a writer also needs `SELECT`. `ALL PRIVILEGES` on a
catalog is a very large grant and should be rare.

Classic `DENY` is not supported. Unity Catalog's object-privilege model is additive, so the way to
exclude someone is to not grant, to use a separate catalog, or to apply a row filter; a beta
attribute-based mechanism covers narrow administrative cases, not general subtraction. Teams
arriving from a system with deny semantics try to subtract what inheritance keeps adding back.

**Owners** are the exception to the additive model: an owner has all privileges on the object and
can grant them onward. Ownership transfer on offboarding is an operational task, not an
afterthought — a table owned by a departed contractor is a table nobody can fix.

## Masks and row filters

Fine-grained access is expressed as SQL functions attached to a table:

```sql
CREATE FUNCTION prod.gold.mask_email(email STRING)
RETURNS STRING
RETURN CASE WHEN is_account_group_member('pii_readers') THEN email ELSE '***' END;

ALTER TABLE prod.gold.customers ALTER COLUMN email SET MASK prod.gold.mask_email;

CREATE FUNCTION prod.gold.eu_only(region STRING)
RETURNS BOOLEAN
RETURN is_account_group_member('global_ops') OR region = 'EU';

ALTER TABLE prod.gold.customers SET ROW FILTER prod.gold.eu_only ON (region);
```

The filter is applied by the engine at query time, so `SELECT *` returns fewer rows rather than an
error. That is convenient and quietly dangerous: a dashboard that suddenly shows zero rows is
more likely a filter than a data outage. Record the filters and check them during triage.

A slow or non-deterministic filter becomes a platform-wide problem. Keep filters simple,
deterministic and tested.

## Lineage and audit

Lineage is captured automatically for Unity Catalog tables whenever a query, notebook, job,
pipeline or warehouse reads or writes them. Table-level lineage answers "what breaks if I drop
this", and column-level lineage answers "where did this number come from" — the question that
actually gets asked in a data-quality review.

Lineage is derived from executed queries, not from source code. A table read through a dynamic
path, a Python UDF that builds SQL, or an external engine outside the platform may not appear.
Treat lineage as high-coverage evidence, not a proof of completeness.

Audit records control-plane actions — grants, table creation, job edits, cluster starts — in audit
logs and account system tables. Whether data reads appear depends on the audit configuration and
tier, so do not promise "we log every row read" without checking. The `information_schema` in each
catalog exposes tables, columns and privileges, which is how you diff intended grants against
actual ones in CI.

## Sharing and federation

**Delta Sharing** publishes selected tables, views, volumes or schemas to a recipient without
copying data, over an open protocol. Databricks-to-Databricks sharing is the easy case; open
sharing lets a Snowflake, Power BI or pandas client read the share. Revocation is immediate
because the recipient reads through the share, not from a copy.

**Lakehouse Federation** goes the other way: a connection object lets you query PostgreSQL, MySQL,
SQL Server, Snowflake, Redshift or BigQuery tables in place, without ingesting them. Useful for
joins against a small operational table; a poor substitute for ingestion when the remote system is
slow or you need repeated large scans.

## Common mistakes

- **Granting to users instead of groups.** Offboarding becomes a manual audit of every table.
- **`ALL PRIVILEGES` on a catalog for convenience.** It is a blank cheque over every current and future object.
- **Assuming `DROP TABLE` deletes external data.** It does not, and the storage bill continues.
- **Leaving `hive_metastore` readable.** It bypasses the grants and lineage you just built.
- **Creating one workspace per team and calling it isolation.** Same metastore, same data.
- **Using mounts under `/mnt`.** No grants, no lineage, no external location validation.
- **Row filters nobody documents.** A "missing data" incident that is actually a policy working.

## Production notes

Model catalogs by environment and by domain: `prod`, `dev`, and where regulation demands it, a
separate catalog per sensitive domain so a grant mistake cannot cross the boundary. Keep one
managed location per catalog, one external location per landing zone, and a naming convention that
makes the zone obvious from the table name.

Manage grants as code with Terraform or the Databricks CLI, reviewed like any other change, and
reconcile drift with `information_schema.table_privileges`. Give service principals their own
grants rather than borrowing a human's identity.

Finally, decide your retention story before you need it: lineage and audit history are what you
will be asked for after an incident, and they have finite retention. If the answer must cover a
year, export the system tables to storage you control.
