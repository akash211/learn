# Indexes and the Query Planner

An index in SQLite is a second b-tree whose keys are the indexed columns followed by the rowid of
the row they point at. Leaves are ordered by the key, linked left to right, and the entries hold
the key values plus that rowid — no heap pointer, no visibility map, no tuple header. A lookup is
a descent to the first matching key and then a walk along the leaf level.

That structure dictates everything the planner can and cannot do with it. An index on
`(cust_id, ts)` can answer `cust_id = ?`, `cust_id = ? AND ts > ?`, and `ORDER BY ts` within one
customer. It cannot answer `ts > ?` alone, because the leading column is missing and the ordering
is by `(cust_id, ts)`, not by `ts`.

```sql
CREATE INDEX ord_cust_ts ON ord (cust_id, ts);
CREATE INDEX ord_new_ts  ON ord (ts) WHERE status = 'new';
CREATE INDEX ord_month   ON ord (substr(ts, 1, 7));
```

## Reading EXPLAIN QUERY PLAN

`EXPLAIN QUERY PLAN` returns four columns — node id, parent id, an unused field, and the detail
string — and **no costs**. This is the first difference from PostgreSQL: there is no
`cost=0.43..8.12 rows=...` to reason about, only the access path chosen. To see the actual
program, use bare `EXPLAIN`, which prints VDBE opcodes (`OpenRead`, `SeekGE`, `Column`, `Next`,
`ResultRow`); it is useful for confirming a covering index or a missing seek, not for daily work.

```
sqlite> EXPLAIN QUERY PLAN
   ...> SELECT * FROM ord WHERE cust_id=17 ORDER BY ts DESC LIMIT 20;
QUERY PLAN
`--SEARCH ord USING INDEX ord_cust_ts (cust_id=?)
```

`SEARCH` means a b-tree seek; `SCAN` means a full pass. The distinguishing words after `USING`
carry the real information:

| Detail | Meaning |
| --- | --- |
| `SEARCH ... USING INDEX x (a=? AND b>?)` | Index seek with the stated constraints |
| `SEARCH ... USING COVERING INDEX x` | Every column needed came from the index; no table lookup |
| `SEARCH ... USING INTEGER PRIMARY KEY (rowid=?)` | Direct rowid access, the fastest path |
| `SEARCH ... USING PRIMARY KEY` on a `WITHOUT ROWID` table | The table *is* the index |
| `SCAN ... USING INDEX x` | Full index scan — usually the wrong plan |
| `USE TEMP B-TREE FOR ORDER BY` | The index did not supply the order; rows were sorted |
| `MULTI-INDEX OR` | Two indexes combined with a union of rowids |
| `SEARCH ... USING AUTOMATIC COVERING INDEX` | A transient index built for this query — a missing-index signal |
| `LIST SUBQUERY` / `CORRELATED SCALAR SUBQUERY` | Subquery executed per outer row |

A plan with `SCAN` on a large table plus `USE TEMP B-TREE FOR ORDER BY` is the canonical
"this query needs an index" signature. A plan with `SCAN ... USING INDEX` is worse than it looks:
it reads the whole index in order and then fetches each row.

## What the planner knows

SQLite has no per-column histograms and no `pg_statistic`. `ANALYZE` samples the indexes and
writes `sqlite_stat1`, one row per index, with a compact selectivity string:

```
ord|ord_cust_ts|50000 25 1
ord|ord_status|50000 16667
cust||2000
```

Read it as: the table has 50,000 rows; an average `cust_id` value matches 25 rows; within one
`cust_id`, an average `ts` matches 1. The planner uses these averages, plus the structure of the
query, to order joins and decide between a scan and a seek. It does not know that one customer has
40% of the rows, so a skewed value can produce a bad plan with no warning.

`ANALYZE` is cheap but not free, and running it blindly on every startup is wasteful. The modern
advice is `PRAGMA optimize`, which runs `ANALYZE` only where statistics are missing or stale:

```sql
PRAGMA analysis_limit = 400;   -- sample at most 400 rows per index
PRAGMA optimize;               -- on connection close, or periodically
```

Without statistics the planner still works — it uses default guesses and the schema — but join
order on large tables becomes a coin flip.

## Designing indexes that get used

1. **Equality first, range last.** `(tenant_id, created_at)` serves a tenant's date range;
   `(created_at, tenant_id)` scans every tenant's range. Put the column compared with `=` first.
2. **Cover the query when it is hot.** SQLite will use an index as a covering index when every
   referenced column is in it, including the rowid. `SELECT count(*) FROM ord WHERE cust_id=?`
   reads only the index. Adding a column to the index to make a frequent query covering is often
   a bigger win than adding a new index.
3. **Partial indexes for the hot subset.** `WHERE status = 'new'` keeps the index proportional to
   the work actually done; the planner uses it only when the query's predicate provably implies
   the index's `WHERE`. `status = 'new'` qualifies, `status IN ('new','paid')` does not.
4. **Expression indexes for computed predicates.** `substr(ts,1,7)` or `json_extract(payload,'$.status')`
   can be indexed, and the query must use the identical expression. This is the standard way to
   index JSON without generated columns.
5. **Match the collation.** An index on a `BINARY` column will not serve `WHERE name = ? COLLATE NOCASE`;
   create the index with `COLLATE NOCASE` if that is how you query.

## What silently disables an index

- A function around the column: `WHERE substr(ts,1,7) = '2024-05'` scans; `WHERE ts >= '2024-05' AND ts < '2024-06'`
  seeks. The first is only fast with an expression index.
- A leading wildcard: `LIKE '%abc'` cannot use a b-tree. `LIKE 'abc%'` can — but only with a
  `NOCASE` index, because default `LIKE` is case-insensitive and a `BINARY` index cannot serve it.
  `GLOB 'abc*'` is case-sensitive and *does* use a `BINARY` index. Verified against 3.45: with an
  index on `ts`, `ts GLOB '2024-05*'` gives `SEARCH ... (ts>? AND ts<?)` while `ts LIKE '2024-05%'`
  gives `SCAN`.
- Arithmetic or a unary `+`: `WHERE +cust_id = 17` is a deliberate way to forbid index use, useful
  in tests.
- A type mismatch: comparing a `TEXT` column to an integer applies TEXT affinity, which is fine,
  but joining a `TEXT` column to an `INTEGER` column compares across storage classes and matches
  nothing — no plan will save that query.
- Low selectivity: on a 50,000-row table where `status='new'` matches a third of the rows, a scan
  is genuinely cheaper than 16,000 random row lookups, and the planner will choose it.

## Joins and ordering

SQLite plans joins greedily as nested loops: for each table it picks an access path given the
tables already joined. The order is visible as the nesting of the plan output.

```
`--SCAN c
`--SEARCH o USING INDEX ord_cust_ts (cust_id=?)
```

It scanned `c` (2,000 rows, filtered by country) and used the index for each matching `o`. When
the planner's order is wrong — usually because statistics are missing — `CROSS JOIN` fixes it by
forbidding reordering, and `INDEXED BY`/`NOT INDEXED` force or forbid a specific index for
diagnosis. `AUTOMATIC COVERING INDEX` in the output means SQLite built a throwaway index on a
column you should probably index permanently.

`ORDER BY` is satisfied for free when the chosen index's key order matches the requested order and
the query is a single-table seek; otherwise you see `USE TEMP B-TREE FOR ORDER BY`, which
materialises and sorts the result. Descending order is fine: an ascending index can be walked
backwards, so `ORDER BY ts DESC` on `(cust_id, ts)` needs no sort.

## The cost you do not see

Every index is an extra b-tree insert on write, and SQLite has no HOT-update equivalent: updating
any column rewrites the row and every index entry whose key includes a changed column. A table
with eight indexes does nine b-tree modifications per insert. SQLite keeps no `idx_scan` counter,
so there is no query to find unused indexes — the discipline is to review
`PRAGMA index_list(table)` against the queries the application actually issues, and drop what
nothing uses.

## Common mistakes

- Indexing a single low-cardinality column and expecting a win on a large fraction of the table.
- Expecting an index on `(a, b)` to serve `WHERE b = ?`.
- Adding `ORDER BY` columns to the end of an index that is used for equality on a different
  prefix, then wondering why the sort is still there.
- Forgetting that `LIKE` needs a `NOCASE` index while `GLOB` does not.
