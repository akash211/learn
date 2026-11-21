# Transactions, Isolation and Locking

SQL Server uses locks to coordinate concurrent access and its transaction log to make committed changes durable. The exact balance between blocking and concurrency depends on isolation level, row-versioning options, access patterns and transaction duration. A useful investigation starts with the transaction boundary and the blocked resource, not with an assumption that all blocking is a defect.

## Transactions and lock resources

A transaction groups changes so that they commit or roll back together. SQL Server takes locks on resources such as keys, pages, HoBTs (heaps or B-trees) and objects. Shared locks protect reads under locking isolation; exclusive locks protect modifications. Intent locks announce lower-level locks to higher levels. Locks are generally held until transaction completion when needed for correctness, and an open transaction can retain locks even while the session is idle.

Lock escalation can replace many fine-grained locks with a table or partition-level lock when thresholds or memory pressure apply. It is a concurrency trade-off, not proof that an index is missing. Diagnose actual lock waits and escalation events before attempting to disable escalation. Smaller transactions, selective access and correct indexing often reduce lock footprint more safely.

```sql
SELECT r.session_id, r.blocking_session_id, r.wait_type, r.wait_time,
       r.wait_resource, s.open_transaction_count, t.text
FROM sys.dm_exec_requests AS r
JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS t
WHERE r.blocking_session_id <> 0;
```

The head blocker may not itself show a blocking session. Check its transaction age, current statement and client. `sys.dm_tran_locks` shows granted and waiting locks; `sys.dm_os_waiting_tasks` shows current waits and can help map waiters to blockers. Capture a deadlock graph from the `system_health` Extended Events session or a dedicated session. A deadlock is a cycle, and SQL Server resolves it by choosing a victim; it is different from a long blocking chain.

## Isolation choices

`READ UNCOMMITTED` permits dirty reads and is rarely a safe general performance switch. `READ COMMITTED` is the default; without row versioning, shared locks protect reads but are released as the statement progresses. With `READ_COMMITTED_SNAPSHOT` enabled at database level, each statement reads a consistent row-versioned snapshot and readers generally do not block writers. Writers still lock one another.

`SNAPSHOT` isolation gives a transaction-level snapshot, if `ALLOW_SNAPSHOT_ISOLATION` is enabled. It reduces read/write blocking but updates can fail with an update conflict if another transaction changed a row after the snapshot began. Long-running versioned readers retain versions and can grow the version store in tempdb (or the persistent version store when Accelerated Database Recovery is enabled). Versioning shifts costs; it does not eliminate them.

`REPEATABLE READ` retains read locks to transaction end, preventing changed values in rows already read but not preventing qualifying new rows (phantoms). `SERIALIZABLE` uses key-range locks to prevent phantoms, with potentially substantial blocking. Isolation is a correctness decision: choose the anomalies the application can tolerate, then test concurrency and version-store implications.

## Deadlocks and safe retry

Common deadlocks arise from inconsistent resource order, a transaction that touches rows in different orders, or a broad scan that locks many keys. Keep transactions short, acquire resources in a consistent order, index predicates so fewer rows are visited, and avoid user interaction while a transaction is open. A deadlock victim can retry the whole transaction with bounded backoff if the operation is idempotent or protected by an idempotency key. Retrying only the last statement may violate the application's transaction logic.

`SET XACT_ABORT ON` helps ensure many run-time errors abort the transaction. In `CATCH`, inspect `XACT_STATE()` before rollback because a transaction may be uncommittable. Use `THROW` to preserve error handling. Distributed transactions and client disconnects need explicit operational thought; a client timeout does not guarantee the server-side transaction vanished instantly.

## Row versioning and ADR

Read-committed snapshot and snapshot isolation rely on row versions. Accelerated Database Recovery (ADR), available in modern SQL Server versions and enabled by default in Azure SQL Database, changes recovery and version-store behavior using a persistent version store. Its availability and configuration differ across platforms. Monitor version-store usage and long transactions, and do not transfer assumptions between on-prem SQL Server and managed services without checking the deployment.

## Common mistakes

- Applying `NOLOCK` broadly to avoid blocking. It can return dirty, duplicated or missing rows and still takes schema-stability locks.
- Killing the visible waiter instead of identifying the head blocker and its transaction owner.
- Assuming snapshot isolation eliminates write conflicts or version-store maintenance.
- Treating lock escalation as the root problem without checking why many locks are being acquired.
- Retrying a deadlock victim without making the complete transaction safe to repeat.
- Leaving a transaction open across application work or user input, holding locks and delaying log reuse.


## Reconstructing a blocking chain

A blocking investigation should distinguish the original lock owner from downstream waiters. Session 52 might hold an exclusive key lock inside an idle open transaction; sessions 61 and 70 may then wait behind it, while 70 appears to be the immediate blocker for another request. The root cause is the head blocker and its transaction lifetime, not necessarily the last visible waiter. Capture session ID, request status, `blocking_session_id`, wait type/resource, transaction start time, input buffer and application identity. A session with no active request can still own locks through an open transaction.

```sql
SELECT r.session_id, r.blocking_session_id, r.status,
       r.wait_type, r.wait_time, r.wait_resource,
       s.open_transaction_count, s.host_name, s.program_name,
       txt.text
FROM sys.dm_exec_requests AS r
JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS txt
WHERE r.session_id <> @@SPID
  AND (r.blocking_session_id <> 0 OR s.open_transaction_count > 0);
```

This is only a live snapshot and may not show the statement that acquired the lock if the session is idle. `sys.dm_tran_locks` shows granted and waiting lock resources; `sys.dm_os_waiting_tasks` exposes current task waits. `sys.dm_tran_session_transactions` helps relate sessions to active transactions. Permissions and column details vary by SQL Server release. Avoid automatically killing a blocker: rollback can take time, and the transaction owner may be processing a legitimate operation. First assess business impact, transaction age, application retry behavior and recovery consequences.

Deadlocks are different: a cycle of sessions each waiting on resources held by another. The lock monitor chooses a victim and returns error 1205. Use the `xml_deadlock_report` event from the built-in `system_health` Extended Events session or a targeted session to inspect the resource graph, statements, indexes and lock modes. Fix the cycle by acquiring resources in a consistent order, shortening transactions, narrowing access and ensuring appropriate indexes. Application code can retry the entire transaction with bounded backoff only if the work is safe to repeat. Retrying one statement from the middle of a failed transaction is not equivalent.

## Isolation as a data contract

RCSI changes ordinary read committed reads to statement-level snapshots, but does not guarantee that two statements in one transaction see the same snapshot. `SNAPSHOT` offers transaction-level consistency if enabled and may raise update conflicts. Serializable range locks prevent phantoms, but can block inserts into the ranges. When evaluating versioning, check long-running transactions and `sys.dm_tran_version_store_space_usage` or related version-store DMVs where supported. ADR changes where its persistent versions reside; don't assume all version growth is tempdb on every platform. Keep isolation choice tied to required correctness, not solely the desire to remove a lock wait.
