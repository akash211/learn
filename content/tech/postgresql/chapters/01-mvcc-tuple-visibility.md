# MVCC and Tuple Visibility

PostgreSQL never overwrites a row in place. An `UPDATE` writes a new row version and marks the
old one as superseded; a `DELETE` only marks it. Readers therefore never wait for writers and
writers never wait for readers, because they are looking at different physical rows. Everything
else in this module — vacuum, bloat, index-only scans, the visibility map, freezing — exists to
clean up after that one decision.

## A tuple is not a row

A heap tuple begins with a 23-byte header, padded to 24. The fields that matter are:

| Field | Meaning |
| --- | --- |
| `xmin` | Transaction ID that inserted this version |
| `xmax` | Transaction ID that deleted it, or 0 if live |
| `xmin`/`xmax` hint bits | Cached committed/aborted status, set on first inspect |
| `ctid` | Physical address of the *next* version in the update chain |
| `infomask2` | Attribute count and the `HEAP_HOT_UPDATED` flag |
| `t_cid` | Command counter, ordering statements inside one transaction |

A page is 8 kB: 24-byte header, an array of 4-byte line pointers growing up from the front, and
tuples growing down from the end. `ctid` is `(block, offset)` into that line-pointer array, which
is why `ctid` changes on every update and must never be used as a stable key.

## The snapshot

Visibility is decided against a snapshot, not against the current state of the world. A snapshot
is three things: `xmin` (everything below this ID is finished), `xmax` (everything at or above is
invisible), and `xip`, the list of transaction IDs still in flight in between.

```sql
SELECT pg_current_snapshot();               -- 4832:4851:4836,4844
SELECT pg_snapshot_xmin(pg_current_snapshot());   -- 4832
SELECT pg_visible_in_snapshot('4836'::xid8, pg_current_snapshot());  -- false, still running
```

The test for a version, in order:

1. `xmin` must be committed. If it aborted, the version is dead on arrival.
2. `xmin` must be less than the snapshot's `xmax` and not in `xip`. A transaction that started
   after your snapshot took its picture is invisible even if it commits a microsecond later.
3. `xmax` must be zero, aborted, or not yet visible to the snapshot. A version deleted by a
   transaction that started after your snapshot is still visible **to you**.

Step 3 is the one people miss. Two sessions can disagree about whether the same physical bytes
constitute a live row, and both are correct.

## What it costs

An update that changes a 100-byte row consumes a second 100-byte tuple until vacuum reclaims the
first. A `DELETE` of a million rows removes no bytes at all — it sets a million `xmax` values and
leaves a million dead tuples behind. That is bloat, and it is the normal consequence of MVCC
rather than a malfunction.

Index entries are worse. A B-tree leaf points at a `ctid`; when the row moves, the old index entry
still points at the old (now dead) tuple. So every update adds a heap tuple *and* one entry per
index. PostgreSQL does not update indexes in place — which is why over-indexing hurts writes more
than the arithmetic suggests.

## HOT: the escape hatch

A **heap-only tuple** update skips the indexes entirely. It applies when no indexed column
changed, the new version fits on the same page, and there is free space to hold it. The old line
pointer is turned into a redirect to the new tuple, and index entries keep pointing at the chain
head.

Two consequences:

- `fillfactor` below 100 leaves room on the page. Default 100 means a page is packed full, so the
  first update on a full page cannot be HOT. `ALTER TABLE ... SET (fillfactor = 85)` on
  update-heavy tables is usually worth more than another index.
- Every index you add removes HOT opportunities for the columns it covers.

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC LIMIT 10;
```

A large table with a hot percentage under 50 is usually either over-indexed or filled to
`fillfactor = 100`.

## Isolation is a choice of snapshot policy

The isolation level decides *when* the snapshot is taken, and nothing else:

- **READ COMMITTED** (default): a new snapshot per statement. Two `SELECT`s in one transaction can
  see different data, and an `UPDATE` that waits on a lock re-evaluates its `WHERE` clause against
  the newly committed row.
- **REPEATABLE READ**: one snapshot for the whole transaction. Implemented as snapshot isolation;
  a concurrent update to a row you also modify raises `40001 serialization_failure` instead of
  silently losing the write.
- **SERIALIZABLE**: snapshot isolation plus predicate locks (SSI) that detect read-write
  dependencies forming a cycle. It can abort transactions that never touched the same row.

The xmin horizon — the oldest snapshot any backend still holds — is what vacuum can safely
delete below. One session sitting `idle in transaction` for six hours pins that horizon for the
whole database, and no amount of autovacuum tuning will reclaim a byte until it ends.

## Production notes

- `idle_in_transaction_session_timeout = '60s'` on application roles is the single highest-value
  setting against vacuum starvation.
- Long-running reporting queries on the primary hold the horizon open just as effectively as
  idle transactions. Move them to a replica and set `hot_standby_feedback = off` there.
- Watch `SELECT min(backend_xmin) FROM pg_stat_activity` and alert when its age exceeds a few
  minutes; `age(backend_xmin)` is effectively the vacuum debt clock.
- `pg_stat_all_tables.n_tup_newpage_upd` (16+) counts updates that had to move to a new page.
  A high ratio with a low `hot_pct` points at fillfactor, not at the workload.

## Common mistakes

- Treating `ctid` as a row identifier in application logic or dedupe scripts.
- Assuming a `DELETE` frees disk space, then being surprised when the table does not shrink.
- Running analytics on the primary and blaming autovacuum for the resulting bloat.
- Reading committed data in REPEATABLE READ and expecting to see another session's later commits.
