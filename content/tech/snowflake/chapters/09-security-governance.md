# Security and Governance: RBAC, Policies and Shares

Snowflake's access model is role-based, hierarchical, and enforced in the cloud services layer before a warehouse is involved. That last part matters: authorisation is not a filter applied to results, it is a decision made at planning time about which objects a statement may even reference. Understanding the model is mostly understanding three things — how privileges propagate, where policies attach, and what a share actually shares.

## Roles, not users

Privileges are granted to roles; roles are granted to other roles and to users. A session runs as exactly one role at a time, and `USE ROLE` changes it. The system roles form a shallow hierarchy:

| Role | Purpose |
| --- | --- |
| `ACCOUNTADMIN` | Account-level settings, billing, integrations. Should be almost unused. |
| `SECURITYADMIN` | Creates users and roles, manages grants |
| `USERADMIN` | User and role creation only |
| `SYSADMIN` | Owns warehouses and databases created for general use |
| `PUBLIC` | Granted to every user; should hold nothing |

Privileges follow the containment hierarchy: to select from `db.schema.table`, a role needs `USAGE` on the database, `USAGE` on the schema, and `SELECT` on the table. Missing the middle one produces "does not exist or not authorized", which is deliberately ambiguous to avoid leaking existence.

The practical structure is two layers: **access roles** that hold privileges on objects (`read_finance`, `write_raw`), and **functional roles** that represent jobs (`analyst_finance`, `engineer_ingest`) and are granted access roles. Users get functional roles. Nobody gets `SYSADMIN` because it was convenient.

```sql
CREATE ROLE access_finance_read;
GRANT USAGE ON DATABASE finance TO ROLE access_finance_read;
GRANT USAGE ON SCHEMA finance.marts TO ROLE access_finance_read;
GRANT SELECT ON ALL TABLES IN SCHEMA finance.marts TO ROLE access_finance_read;
GRANT SELECT ON FUTURE TABLES IN SCHEMA finance.marts TO ROLE access_finance_read;

CREATE ROLE analyst_finance;
GRANT ROLE access_finance_read TO ROLE analyst_finance;
GRANT ROLE analyst_finance TO USER jdoe;
```

`FUTURE TABLES` is not optional in practice. Without it, every dbt run that creates a new table produces an object nobody but its creator can read, and the fix is applied by hand, weekly.

Managed access schemas change who may grant. In a managed access schema, only the schema owner (or a role with `MANAGE GRANTS`) can grant privileges on objects in it; object owners cannot hand out access. That is usually what you want for a governed schema, and it is why a data engineer who owns a table still cannot grant it to a colleague.

## Masking policies

Column-level masking rewrites a value at query time based on the role:

```sql
CREATE MASKING POLICY pii_email AS (val STRING) RETURNS STRING ->
  CASE
    WHEN IS_ROLE_IN_SESSION('access_pii_full') THEN val
    ELSE REGEXP_REPLACE(val, '.+@', '***@')
  END;

ALTER TABLE raw.customers
  MODIFY COLUMN email SET MASKING POLICY pii_email;
```

The policy is attached to the column, not to the view, so every consumer — a view, a share, a BI tool, an ad-hoc query — sees the masked value unless their role qualifies. `IS_ROLE_IN_SESSION` checks the whole active role hierarchy rather than just `CURRENT_ROLE()`, which is why it is preferred. The column's data type does not change; only the value returned.

Masking requires Enterprise edition. So do row access policies, which filter rows rather than values:

```sql
CREATE ROW ACCESS POLICY rap_region AS (region STRING) RETURNS BOOLEAN ->
  EXISTS (
    SELECT 1 FROM governance.region_entitlements e
    WHERE e.region = region
      AND IS_ROLE_IN_SESSION(e.role_name)
  );

ALTER TABLE finance.orders ADD ROW ACCESS POLICY rap_region ON (region);
```

The mapping table is the whole design: entitlements are data, so granting a new region to a team is an `INSERT`, not a DDL change. Two operational caveats. A row access policy is evaluated per query and can prevent pruning, because the policy's predicate is not known at compile time in the same way a literal is — on a large table this can turn a pruned scan into a full one. And a policy attached to a column used in a join can change which rows join, so test with realistic roles.

## Secure views and shares

A normal view exposes its definition to anyone who can see the view; a secure view does not, and it also disables optimisations that could leak information about the underlying data through error messages or execution plans. Use secure views at every boundary where a consumer should see results but not logic.

Data sharing goes further: a share is a live, read-only projection of selected objects into another account, with no data copied and no storage cost to the consumer.

```sql
CREATE SHARE sales_share;
GRANT USAGE ON DATABASE sales TO SHARE sales_share;
GRANT SELECT ON TABLE sales.marts.orders_v TO SHARE sales_share;
ALTER SHARE sales_share ADD ACCOUNTS = partner_account;

-- In the consumer account:
CREATE DATABASE sales_shared FROM SHARE provider_account.sales_share;
```

What the consumer gets is a database they can query, on their own warehouses, at their own cost. What they do not get is the underlying tables, the view definitions, or any ability to write. Revoking the grant removes the data on the next query, which is a materially different property from sending a CSV.

Shares are the reason secure views matter: share the view, not the table, so that a later schema change or a new column does not become visible to a partner by accident.

## The rest of the perimeter

Authentication supports password with MFA, SSO through SAML, key-pair authentication for service users, and OAuth for integrations. Network policies restrict which IP ranges may connect, at account or user level. `ACCESS_HISTORY` records which columns each query read, which is the only practical way to answer "who has actually seen this column" — and is also how you find the query that exfiltrated data.

Object tagging (`CREATE TAG pii`, `ALTER TABLE ... SET TAG pii = 'true'`) underpins classification, tag-based masking policies, and cost attribution. Tags are metadata, so they are cheap; the discipline of applying them is not.

## Common mistakes

- Granting `ACCOUNTADMIN` to humans because role hierarchy is confusing. Every task that needs it should have a narrower custom role.
- Granting `SELECT` on `ALL TABLES` without `FUTURE TABLES`, so pipelines create objects nobody can read.
- Attaching a masking policy to a view instead of the base column, then adding a second view that bypasses it.
- Assuming a row access policy is free. It can disable pruning and change join behaviour.
- Sharing a table directly instead of a secure view, which makes the schema part of the contract.
- Using `CURRENT_ROLE()` in a policy where `IS_ROLE_IN_SESSION()` was intended, so a user with the right role in their hierarchy but not active sees masked data.

## Production notes

Model roles as code and deploy them with the same review as tables; drift in grants is invisible until an audit. Keep one schema that holds only governance objects — policies, entitlement tables, tags — owned by a role no analyst holds. Review `ACCESS_HISTORY` and `GRANTS_TO_ROLES` quarterly for privileges granted "temporarily". And test every policy against a low-privilege role before shipping: the failure mode of a masking policy is not an error, it is a value that looks plausible and is wrong.
