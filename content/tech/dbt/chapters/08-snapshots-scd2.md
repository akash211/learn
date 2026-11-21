# Snapshots for SCD Type 2 History

A dbt snapshot records changes in a mutable source relation over time. It is a practical way to preserve historical versions of entities—often called slowly changing dimension type 2 (SCD2)—when the source table exposes current state but not a complete change log. A snapshot does not turn a bad source cadence into a perfect audit log: it captures what dbt observes each time the snapshot runs.

## The SCD2 idea

A type 1 dimension overwrites an old attribute value with the latest value. A type 2 dimension retains multiple versions of an entity and marks their validity intervals. For a customer whose region changes from west to north, a type 2 record can keep the earlier row with `dbt_valid_to` set and create a new current row with `dbt_valid_from` set. An as-of query can then answer what the region was at a prior point.

Snapshots implement this history capture using a configured unique key and a change-detection strategy. They write rows to a snapshot relation containing the source columns plus metadata such as validity timestamps and a generated row identifier. Exact metadata columns and null conventions can depend on dbt version and configuration. Downstream models should use the snapshot as a temporal input and define their own current-row or as-of logic explicitly.

## Configure a snapshot

A timestamp strategy uses a source `updated_at` field to detect change. A check strategy compares selected columns or uses a check-all policy when a reliable modification timestamp is unavailable. Modern projects commonly define snapshots in YAML; syntax details have changed across dbt releases, so use documentation matching the pinned version. In the familiar SQL configuration form, the concepts are:

```sql
{% snapshot customer_history %}
{{ config(
    target_schema='snapshots',
    unique_key='customer_id',
    strategy='timestamp',
    updated_at='updated_at'
) }}
select customer_id, name, region, updated_at
from {{ source('crm', 'customers') }}
{% endsnapshot %}
```

Run snapshots with `dbt snapshot`; they are not ordinary models run by `dbt run`. The target schema, grants, retention and ownership need to be considered separately from a transient development schema. For current projects, prefer the supported resource configuration for the dbt version in use and test migration paths before changing snapshot definitions.

The `unique_key` identifies one logical entity across versions. It must be stable, non-null and unique in the current source query. If keys are recycled or duplicated, snapshots can associate changes with the wrong entity or fail. A composite identity may be expressed according to supported configuration, but first determine the actual business key. Deleting and recreating an entity with the same key can be indistinguishable from an update unless the source provides a generation identifier.

## Timestamp versus check strategy

With `timestamp`, dbt uses the configured update column to detect whether a source record changed. It is efficient and clear when that column is reliably updated on every relevant mutation and is never moved backwards in a way that suppresses history. If an upstream process forgets to update the timestamp, changed attributes may not be captured. If timestamps are corrected or coarse-grained, behavior needs investigation.

With `check`, dbt compares configured columns and detects changes based on their values. It can be useful where no trustworthy update timestamp exists, but comparison cost can grow with row count and selected column count. Omitting a historically important attribute from the check means its changes may not create a new version. A “check all” option can automatically include columns, but adding a technical column may cause noisy history and schema evolution has consequences.

Snapshots observe source state at run times. If a customer changes twice between daily runs and only the final state remains in the source, dbt only sees the final value and cannot reconstruct the intermediate change. If exact event-time audit history is legally or operationally required, use an authoritative change-data-capture or event log as the source of truth rather than relying only on periodic snapshots.

## Querying historical rows correctly

The validity interval enables two common queries: current records and point-in-time records. A current-row filter often checks `dbt_valid_to is null`, subject to null sentinel or configuration differences. An as-of query selects rows where the desired timestamp is at or after `dbt_valid_from` and before `dbt_valid_to`, allowing for open-ended current rows. Do not assume inclusive interval endpoints without understanding how the fields are set and how the data warehouse handles time zones and precision.

A snapshot is not automatically a dimensional model ready for business users. Build a downstream dimension with clear names, documented valid-time semantics and tests for one active row per key. Resolve late-arriving corrections in a deliberate policy; snapshot validity metadata reflects observation and configured time semantics, which may not equal the original business event's effective time.

## Operations and change management

Schedule `dbt snapshot` often enough to meet the required history resolution, but balance warehouse cost with source change volume. Monitor snapshot run results and row growth. Snapshot tables are append/history-oriented and can grow substantially; retention or archival must preserve audit and as-of requirements. Test that a repeated run with no source changes does not create unwanted versions, and that an update creates exactly the expected new version.

Changing snapshot unique keys, strategy or tracked columns can alter history behavior. Treat such changes as migrations. Validate in a clone or isolated target and understand whether dbt can reconcile existing metadata. Avoid dropping and recreating production history as a casual fix; it destroys the very history snapshots exist to preserve. Compare a sample of source records and snapshot versions after upgrades or configuration changes.

## Common mistakes

- Assuming snapshots capture every intermediate source change, even when no snapshot ran while the source changed.
- Using an unreliable `updated_at` field with timestamp strategy and missing attribute changes.
- Choosing a key that is nullable, duplicated, recycled or not a true entity identity.
- Treating snapshot `dbt_valid_from` as business-effective time without checking source semantics.
- Running `dbt run` and expecting snapshot resources to execute; use `dbt snapshot` or the appropriate build selection.

## Production notes

Document the history resolution, key definition, change strategy, timezone and retention policy. Provide downstream current and as-of models instead of forcing every consumer to understand snapshot internals. If exact auditability matters, preserve the source change log and reconcile snapshots against it. Snapshots are valuable precisely when teams understand what they observe—and what they cannot observe—between scheduled runs.

Test lifecycle cases against a disposable target: a first-seen key, an unchanged row, a changed tracked value, a changed untracked value, a hard delete and a reappearing key. The expected result depends on strategy and delete configuration, so write down the intended behavior rather than assuming defaults. Check the data type, timezone and precision of update timestamps; coarse or inconsistent timestamps can make version boundaries confusing. For a representative entity, hand-calculate the validity interval and verify that downstream as-of logic includes exactly one version at the boundary. These checks are especially important when migrating configuration, because a syntactically valid snapshot can still change the meaning of historical rows.
