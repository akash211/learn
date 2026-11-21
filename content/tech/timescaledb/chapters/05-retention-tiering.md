# Retention Policies and Tiering

Time-series retention is a lifecycle decision: how long raw observations remain available, which summaries survive longer, and whether old data moves to cheaper storage. TimescaleDB policies can drop or otherwise manage old chunks far more efficiently than deleting each row, because chunks are physical relations with time bounds. The exact policy function and behavior vary by extension release, and retention is irreversible unless an independent backup or archive exists.

## Chunk retention versus row deletion

A large `DELETE FROM sensor_readings WHERE time < ...` visits rows, writes WAL, creates dead tuples, and leaves vacuum to reclaim space. Dropping a chunk removes a whole bounded relation and its indexes, usually with far less per-row work. However, a chunk may cover a time range that straddles the desired cutoff; whole-chunk retention is inherently coarse. Choose chunk intervals that fit the retention precision, and verify whether the policy drops only chunks entirely older than the cutoff rather than deleting rows inside a partially overlapping chunk.

A classic retention policy is:

```sql
SELECT add_retention_policy('sensor_readings', INTERVAL '90 days');
```

The job runs on a schedule; the table does not lose rows exactly at the instant they reach 90 days. Policy syntax, job scheduling, and options are version-specific. Inspect the actual job and test the boundary on a non-production hypertable. Before activation, enumerate chunks that qualify and compare their ranges against the business cutoff.

## Raw, summarized, and archived data

A practical lifecycle often keeps raw measurements for weeks or months, hourly summaries for a year or two, and daily rollups or archived files for longer. Continuous aggregates can preserve useful metrics after raw chunks expire, but ordering matters: ensure summaries are complete through the deletion boundary before raw data is removed. A refresh policy with too short a lookback can leave gaps in the retained aggregate. Use explicit monitoring that checks both summary freshness and raw retention.

Tiering may mean converting older chunks to a columnar representation, moving backups or exports to object storage, or using a supported tiered-storage feature in a particular release. These are different mechanisms. Compression does not itself provide an independent backup, and a cloud object-store archive is not automatically queryable as a TimescaleDB table. Verify retrieval time, consistency, retention lock, and restore procedure for any archive tier.

A robust pipeline exports or replicates data before destructive retention if long-term audit or replay is needed. Store a manifest with time range, row count or checksums, schema version, and export timestamp. Test retrieval, not just successful upload. If compliance requires immutable records, a mutable database retention job alone is not an adequate archive strategy.

## Policy interactions

Compression and retention policies can be combined: convert chunks after they age out of the mutable window, then drop them after the longer retention period. The age offsets must be ordered sensibly. For example, compress after seven days and retain for ninety days. Ensure the compression job has completed before a retention job removes the chunk, and monitor backlogs or failed runs. Job execution order and policy specifics can differ among versions, so confirm via the job catalog and extension docs.

A late-arriving row whose timestamp falls into a chunk older than the retention threshold may be rejected, routed to a chunk that is immediately eligible for deletion, or require special handling depending on configuration and version. Define whether such events should be discarded, quarantined, or retained in a correction table. Do not silently depend on the database to preserve data that the policy is designed to remove.

Dropping chunks may interact with foreign keys, continuous aggregate refreshes, replication, and backup windows. Check dependency behavior for the installed release and avoid a retention schedule that overwhelms replicas or triggers a long-running archive export. Take care with permissions: policies run under database ownership and should be monitored as managed jobs.

## Dry runs and guardrails

Before enabling a policy, query the chunk catalog or use the available `show_chunks` helper with a cutoff to list candidates. Confirm timezone and the interpretation of timestamps. Record the expected oldest retained chunk. Then add policy, inspect its job metadata, and verify both successful execution and resulting relation sizes. For emergency holds, know how to disable or remove the policy using the version-specific API, and ensure change approval covers destructive data loss.

Backups must cover the retention policy's effect and the intended recovery point. A logical dump after chunks were dropped cannot restore them. Physical backups plus WAL can recover to a point before deletion if the required base backup and WAL remain available, but only if the organization has tested the restore. Long retention in backups is not a substitute for accessible queryable history unless restore latency is acceptable.

## Common mistakes

- Expecting chunk retention to delete rows at an exact timestamp inside a chunk.
- Dropping raw data before the continuous aggregate includes it.
- Treating compression, archive, and backup as synonyms.
- Ignoring backfilled events and policy-job backlog.
- Enabling an irreversible policy without a candidate-chunk review and restore test.

## Production notes

Publish the data lifecycle: raw, aggregate, and archive horizons; who approves changes; and how to recover. Monitor oldest retained time, policy job outcomes, and archive completeness. Retention is safest when chunk boundaries, aggregate windows, and business requirements agree.

## Retention arithmetic and auditability

Translate policy language into concrete UTC timestamps before rollout. “Keep 90 days” can mean 90×24 hours from now, three calendar months, or retain all complete calendar months; these produce different deletion boundaries. Use the precise interpretation in both policy configuration and reporting. Since jobs run periodically, include scheduling delay and chunk-boundary granularity in the stated guarantee—for example, a range may remain slightly longer than the nominal minimum, while a whole chunk cannot be dropped until its end is older than the cutoff.

For regulated or customer-audited data, record each retention execution: policy version, cutoff, chunks removed, archive reference, and job outcome. Such a ledger makes it possible to explain what was deleted and when. Ensure the ledger is stored independently enough that a database restore does not erase evidence of the retention action. If legal holds can apply to individual tenants or devices, a table-wide chunk drop may be the wrong mechanism unless data is partitioned so that held records are separable.

## Cross-system consistency

If data is archived to object storage, coordinate export completion and retention eligibility. A robust process marks a time range export-complete only after the object is durable and verified, then allows its database chunk to expire. Retries must not create ambiguous versions or delete the only copy. Document how schemas and timestamp units are encoded in the archive so a future reader can decode it without the original application.
