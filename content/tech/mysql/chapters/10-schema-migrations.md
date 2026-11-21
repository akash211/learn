# Schema Design and Migration Safety

A good MySQL schema makes valid states easy to represent and routine queries efficient. InnoDB supplies transactions and constraints, but physical layout, key width, nullability, and migration mechanics have operational consequences. Design for the queries and change patterns the application actually needs, then evolve the schema with a plan for both old and new application versions to coexist.

## Relational design and InnoDB considerations

Use appropriate data types and constraints. A `BIGINT` primary key is not automatically better than a smaller integer if the value range is known, and wide keys multiply through secondary indexes. Choose string lengths and collations deliberately; comparison and uniqueness rules depend on collation. Store instants using a consistent time-zone convention and understand the conversion behaviour of `TIMESTAMP` versus `DATETIME`. Use `DECIMAL` for exact fixed-point amounts rather than binary floating point where exact decimal arithmetic is required.

Declare primary keys explicitly and keep them compact and stable. Normalize facts that need independent constraints, relationships, or updates; selective denormalization may still be appropriate when measured access patterns justify it. Add foreign keys when referential integrity is a requirement and the operational trade-offs are understood. InnoDB foreign keys need suitable indexes and can add checks and locking interactions on writes.

Index for real query shapes. Composite indexes, covering trade-offs, and write amplification should be reviewed as a set. Avoid redundant indexes that are prefixes of other indexes without proving they serve distinct sort, uniqueness, or workload purposes. Treat index changes as a capacity decision, not only a query decision.

## MySQL DDL algorithms and locking

MySQL 8.0 supports online DDL for many operations, but “online” does not mean lock-free or instant for all tables and changes. `ALGORITHM=INSTANT`, `INPLACE`, and `COPY` have distinct capabilities and version-dependent applicability. An operation may need a brief exclusive metadata lock at the start or end even when concurrent DML is allowed during most of its work. Unsupported requested algorithms can fail rather than silently doing what you intended; use explicit clauses where a fallback copy would be unacceptable and test the exact server version.

```sql
ALTER TABLE orders
  ADD COLUMN source VARCHAR(32) NULL,
  ALGORITHM=INSTANT;
```

The example's support depends on the operation, row format, table properties, and release. Set an appropriate session `lock_wait_timeout` before migration so metadata-lock acquisition does not wait indefinitely and queue later statements. Inspect long transactions and metadata locks before the change. An online operation can still consume I/O, CPU, disk space, and replication bandwidth; monitor replicas and capacity until completion.

## Expand, migrate, contract

For application changes that need a new column or representation, use an expand-and-contract sequence. First add the new nullable or backward-compatible structure. Deploy code that can read old and new forms, then backfill in bounded batches with checkpoints and rate limits. Switch reads and writes after validation. Only later remove the old column or constraint once all application versions and rollback windows no longer depend on it.

Backfills should be idempotent and resumable. Avoid one massive transaction that creates a long undo history, holds locks, fills the binlog, or overwhelms replicas. Track progress and lag, and stop safely when workload impact exceeds the budget. Validate counts and checksums or business invariants before switching authority to the new representation.

## gh-ost and pt-online-schema-change

For changes that require a table copy or where native DDL has unacceptable blocking or resource risk, online schema-change tools can create a shadow table, copy rows in chunks, capture concurrent modifications, and swap tables near completion. `gh-ost` uses binlog-based change capture and has topology and binlog requirements; `pt-online-schema-change` commonly uses triggers to propagate changes and has constraints around existing triggers and foreign keys. They are not interchangeable and neither makes the operation risk-free.

These tools add load and have a final cutover that requires metadata locks. Review options, foreign keys, triggers, replication topology, disk headroom, and failure recovery. Test on a production-like copy, throttle based on replica lag and load, and arrange an abort plan. Managed-service privileges or binlog access may constrain tool choice. For relatively simple operations, native instant or in-place DDL may be safer and simpler; choose based on measured impact and supported algorithm.

## MySQL or PostgreSQL?

Neither engine is categorically superior. MySQL is often a strong fit when the team has operational expertise, its ecosystem or managed offering is a requirement, and the workload aligns with InnoDB's transactional and replication model. PostgreSQL can be attractive for its broader SQL features, extensibility, and different index and concurrency options. The right comparison is workload-specific: required semantics, query patterns, extensions, migration path, cloud constraints, observability, skills, and recovery objectives.

A migration between engines is not a syntax rewrite alone. Differences in types, collations, JSON operators, constraint behaviour, isolation, locking, indexing, generated columns, DDL, and replication can change correctness and operational risk. Prototype representative workload and data, test edge cases and failure recovery, and estimate both migration and long-term operating cost. Choose based on concrete requirements, not benchmark claims detached from the target system.

## Migration preflight and validation

A migration review should answer what operation will run, on which version, and what happens at every failure point. Verify the exact algorithm on a copy with representative row count, indexes, foreign keys, triggers, and row format. Check free disk for the original table, temporary or shadow copy, indexes, and binlogs at the same time. Estimate replica apply capacity and ask whether a lagging replica can catch up before another deployment or failover.

Separate DDL from application rollout when possible. Apply backward-compatible schema first, then deploy code, then migrate and validate data, and only later remove the old representation. Keep a migration ledger and idempotent scripts so an interrupted deploy can determine what completed. After cutover, verify constraints and query plans, inspect errors and replication state, and retain the previous data path for the agreed rollback window. A database rollback may not be safe after new code writes values the old schema cannot represent; a forward fix can be safer.

## Production notes

- Use schema migration tooling with a migration ledger, explicit preconditions, and observable progress.
- Back up and test rollback or forward-fix plans before destructive operations.
- Monitor metadata locks, disk headroom, replica lag, and application error rate during DDL.
- Keep application releases compatible with the schema during rolling deploys.

## Common mistakes

- Assuming `INPLACE` means no table rebuild or `INSTANT` is supported for every change.
- Running a migration without a lock timeout, disk budget, or cutover plan.
- Treating gh-ost or pt-online-schema-change as a guarantee of zero locking or zero impact.
- Combining a large backfill with the DDL in one transaction.
- Selecting MySQL or PostgreSQL from generic popularity or invented benchmark numbers rather than requirements.
