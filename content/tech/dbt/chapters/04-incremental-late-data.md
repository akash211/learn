# Incremental Strategies and Late-Arriving Data

Incremental materialization trades a complete rebuild for a smaller, repeated update. The SQL and the strategy together define what “changed” means. To trust the result, reason about inserts, updates, deletes, duplicates, late events and repair—not merely the speed of the happy path.

## A correct incremental model begins with a baseline

A model can use `is_incremental()` to select different SQL for an already-existing incremental target while retaining a full-history query for its initial build or full refresh:

```sql
{{ config(
    materialized='incremental',
    unique_key='event_id',
    incremental_strategy='merge'
) }}

select event_id, account_id, event_time, amount
from {{ source('app', 'events') }}
{% if is_incremental() %}
where event_time >= (
    select dateadd(day, -3, max(event_time)) from {{ this }}
)
{% endif %}
```

The three-day lookback deliberately re-reads a recent window to catch late or corrected events. Whether that is enough depends on observed arrival delay and correction behavior. `{{ this }}` refers to the target relation. On a first run, the incremental target may not yet exist, so `is_incremental()` protects expressions that query it. `--full-refresh` requests a rebuild rather than the incremental path; use it deliberately because it can consume significant compute and may replace production history.

A timestamp watermark is only one possible strategy. If an upstream system provides a reliable monotonically increasing ingestion sequence or change-log cursor, that can be safer than event time. Event time can arrive out of order, be corrected, or be backdated. The cutoff column must reflect the source's actual update semantics.

## Strategies encode different replacement rules

Adapter support differs, so check the relevant adapter documentation and generated SQL. Common strategy names include `append`, `merge`, `delete+insert`, `insert_overwrite` and, on supported versions/adapters, `microbatch`.

`append` inserts the selected records and does not inherently deduplicate or update old rows. It is appropriate only when the source is append-only and reprocessing a record cannot create an unwanted duplicate. `merge` uses a configured `unique_key` to update matching target rows and insert new ones on platforms that support it. A key must be genuinely unique after the model's transformations; null or duplicate keys can make results ambiguous or adapter-specific.

`delete+insert` replaces target records matching keys before inserting the selected result and can help where merge support or semantics are unsuitable. It can be expensive and can have concurrency implications. `insert_overwrite` replaces complete partitions and is a natural fit when output is partitioned and the model recomputes every row in each touched partition. It is unsafe if the selected input does not contain the complete partition contents. Microbatch is designed for time-series work by splitting processing across event-time windows on supported adapters; it introduces batch configuration and operational choices, not automatic protection from bad source timestamps.

Do not assume every strategy works on every warehouse or supports identical keys, predicates, partition replacement or concurrent writes. Adapter-generated SQL is the final behavior. Use `dbt compile` and warehouse query history, then test duplicates, corrections and reruns in a non-production target.

## Late arrivals, updates and deletes

A robust design specifies a lateness policy. If 99.9% of events arrive within two days, a rolling three-day lookback may be economical—but the tail beyond three days still needs a correction mechanism. Some teams periodically rebuild a broader window; others use an ingestion timestamp, source change table, explicit repair selector or a manually triggered backfill. The policy should include a way to detect and fix data older than the routine lookback.

Updates require the model to re-select changed rows and a strategy capable of replacing old values. A high-water mark that only selects `event_time > max(event_time)` misses an update to yesterday's row. Deletes are harder: if a source row disappears, a normal query cannot emit a tombstone unless the source exposes deletion events or the model reconciles a bounded key range. `merge` cannot delete a target row that never appears in its source result unless the generated operation or custom logic explicitly handles deletions.

The correct design depends on the source contract. Append-only event logs can often use a natural event identifier and a rolling lookback. Mutable business entities may need update timestamps or CDC. Slowly changing historical attributes may require snapshots rather than overwriting the latest state. A full refresh is a valid simple policy when the data is small enough and consistency matters more than runtime.

## State, duplicates and recovery

Incremental tables are stateful. A developer can change SQL but still see old rows that the new query would no longer produce. Run `dbt build --full-refresh --select model_name` in an isolated environment to test a clean baseline. Compare the full result against the incremental result for a known time period, check key uniqueness, and verify totals across boundary dates.

A `unique_key` is not a uniqueness test. Add `unique` and `not_null` tests on the key where those expectations hold; deduplicate the source deterministically before merge. If multiple input rows share the same key, warehouses may reject the merge or choose unpredictable winners. Define ordering rules such as latest source update, then stable tie-breaker.

Recovery should be designed before an incident. Decide how to rebuild a particular date range, how to handle empty partitions, what concurrent production jobs can conflict, and who can run a full refresh. A targeted rolling rebuild is often safer than dropping an entire table. Build idempotently so rerunning the same window produces the same target. Verify the repair with reconciliation queries and tests.

## Common mistakes

- Filtering solely on event time and missing backdated events or updates.
- Using `append` with retries or overlapping windows and silently creating duplicates.
- Assuming `unique_key` both validates source uniqueness and handles deletes.
- Replacing a partition with an incomplete result set and erasing valid rows.
- Treating `--full-refresh` as a harmless test command against a production-sized relation.

## Production notes

Monitor both freshness and correctness: count rows by event date, compare late-arrival rates to the lookback, track duplicate keys and watch incremental query duration. Alert when the observed maximum lateness exceeds the chosen policy. Keep a documented full-refresh or backfill procedure and test it periodically. Incremental models are most valuable when their correctness assumptions are explicit, observable and repairable; without that, they merely make stale data cheaper to produce.

A useful operating checklist records the business key, watermark column, maximum expected lateness, routine lookback, deletion behavior, merge semantics and repair owner. Measure the data, not just the query duration: compare event and arrival timestamps to calculate the lateness distribution, and alarm when it breaches the configured horizon. Reconcile recent partitions against a source count or independently aggregated control total. Keep the first successful full build's reference totals so future repairs have a baseline. These controls let an operator distinguish an expected late batch from a silent logic regression and choose a bounded repair instead of rebuilding a large table blindly.
