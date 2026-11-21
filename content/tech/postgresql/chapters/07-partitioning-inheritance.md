# Partitioning and Table Inheritance

Partitioning splits one logical table into many physical ones so that the planner can skip the
ones that cannot match, and so that retention becomes a metadata operation instead of a delete.
PostgreSQL makes this declarative, but the details — pruning, unique constraints, lock counts and
maintenance — decide whether it helps or quietly makes everything slower.

## Declarative partitioning

```sql
CREATE TABLE events (
  event_id    bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id   bigint NOT NULL,
  created_at  timestamptz NOT NULL,
  kind        text NOT NULL,
  payload     jsonb,
  PRIMARY KEY (tenant_id, created_at, event_id)
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_01 PARTITION OF events
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
```

Three strategies:

| Strategy | Key | Good for |
| --- | --- | --- |
| `RANGE` | timestamp, date, numeric range | time-series, retention by period |
| `LIST` | tenant, region, status | a handful of large tenants or regions |
| `HASH` | any stable key | spreading writes when no natural range exists |

`FOR VALUES FROM (a) TO (b)` is a **half-open** interval: `a` is included, `b` is not. Adjacent
partitions therefore tile the space without overlap, and the classic bug — a row landing in two
partitions, or in none — comes from writing `TO ('2026-02-01')` when you meant to include January
31st's last microsecond.

Hashing needs a modulus and remainder, and the number of partitions is fixed at creation:

```sql
CREATE TABLE sessions (id uuid NOT NULL, data jsonb) PARTITION BY HASH (id);
CREATE TABLE sessions_p0 PARTITION OF sessions FOR VALUES WITH (MODULUS 8, REMAINDER 0);
-- ... through REMAINDER 7
```

Changing the modulus later means moving every row; pick a number you can live with.

## Pruning: where it works and where it does not

The planner eliminates partitions whose bounds cannot satisfy the predicate. Since 11 it can also
prune at *execution* time for parameterised queries, which is what makes prepared statements and
`WHERE created_at >= $1` work at all.

It fails when:

- The predicate is not on the partition key. `WHERE tenant_id = 5` on a table partitioned by
  `created_at` reads every partition.
- The key is wrapped in a function: `WHERE date_trunc('day', created_at) = $1` cannot be matched to
  range bounds. Write `created_at >= $1 AND created_at < $1 + interval '1 day'`.
- The types do not line up: comparing a `timestamptz` column to a `date` literal forces a cast that
  may defeat bound matching in older versions.
- Pruning is disabled: check `SHOW enable_partition_pruning` (on by default), and note that
  `constraint_exclusion` only governs *inheritance* children, not declarative partitions.

You can see the effect directly:

```sql
EXPLAIN (ANALYZE, COSTS OFF)
SELECT count(*) FROM events WHERE created_at >= '2026-02-01' AND created_at < '2026-03-01';
-- Aggregate -> Seq Scan on events_2026_02   (one partition, not twelve)
```

`EXPLAIN` on a parameterised prepared statement may only show "Partitions removed: N at execution"
in newer versions; `EXPLAIN (ANALYZE)` on the `Append` node is the reliable check.

## The constraints partitioning imposes

- **A unique constraint must include the partition key.** `UNIQUE (event_id)` on a table
  partitioned by `created_at` is impossible, because uniqueness cannot be enforced across
  partitions without a global index (which PostgreSQL does not have). That is why the primary key
  above is `(tenant_id, created_at, event_id)`: `event_id` alone is not unique table-wide, and a
  lookup by `event_id` alone has to scan every partition. If you need a globally unique key, either
  partition by that key (hash) or accept a separate lookup table.
- **Foreign keys** can reference a partitioned table (12+) and be defined on one (12+), but the
  referenced side must have a unique constraint on the referenced columns, which brings back the
  partition-key problem.
- **A row cannot move between partitions.** An `UPDATE` that changes the partition key fails with
  `new row for relation "events_2026_01" violates partition constraint`. Delete-and-insert, or
  `MERGE`, is the workaround. There is no automatic row movement.
- **`ON CONFLICT` needs an inference specification that each partition can satisfy**, so it works
  only with the per-partition unique constraints described above.

## Attaching and detaching

Bulk-loading a month of history is much faster into a standalone table, then attached:

```sql
CREATE TABLE events_2026_03 (LIKE events INCLUDING DEFAULTS INCLUDING IDENTITY);
COPY events_2026_03 FROM '/staging/2026-03.csv' WITH (FORMAT csv);

-- A matching CHECK lets ATTACH skip a full validation scan
ALTER TABLE events_2026_03 ADD CONSTRAINT events_2026_03_range
  CHECK (created_at >= '2026-03-01' AND created_at < '2026-04-01');
ALTER TABLE events ATTACH PARTITION events_2026_03
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
```

`ATTACH PARTITION` takes `SHARE UPDATE EXCLUSIVE` on the parent and `ACCESS EXCLUSIVE` on the
attached table, and — crucially — scans the table to verify the constraint unless a matching
`CHECK` is already present and valid.

Detaching is the retention mechanism:

```sql
ALTER TABLE events DETACH PARTITION events_2025_01 CONCURRENTLY;
DROP TABLE events_2025_01;
```

`DETACH ... CONCURRENTLY` (14+) avoids blocking readers on the parent, cannot run inside a
transaction block, and takes longer because it uses a two-phase protocol. Without `CONCURRENTLY`
it needs `ACCESS EXCLUSIVE` on the parent — on a busy ingest table, a multi-second write stall.

Compare that with `DELETE FROM events WHERE created_at < '2025-02-01'`: it writes WAL for every
row, creates the same number of dead tuples, needs a vacuum that will run for hours, and does not
reduce the file size. Dropping a partition is O(1) and returns disk immediately. That difference is
the main reason to partition at all.

## How many partitions

More partitions mean more planning time, more locks, and more files. Each query that touches N
partitions needs locks on all of them, and lock space is governed by
`max_locks_per_transaction` (default 64) × `max_connections`. A query touching 3,000 partitions can
fail with `out of shared memory ... increase max_locks_per_transaction`, which requires a restart.

Practical bounds: hundreds of partitions are fine, thousands are a design smell. If you need daily
partitions over ten years, partition by month and sub-partition by tenant, or use hash
partitioning for the second level so the fan-out per query stays small.

Also note `enable_partitionwise_join` and `enable_partitionwise_aggregate` are **off** by default.
Turning them on lets the planner join and aggregate per partition (much better for large
partitioned joins) at the cost of more planning time — worth testing per workload rather than
enabling globally.

## Table inheritance: the predecessor

`CREATE TABLE child () INHERITS (parent)` predates declarative partitioning and is still used for
a few things, but it is a different mechanism:

```sql
CREATE TABLE events_2026_03 () INHERITS (events);
```

- Queries on the parent include children by default; `ONLY parent` excludes them.
- There is no partition pruning — the planner uses `CHECK` constraints with
  `constraint_exclusion = partition` to exclude children, which is weaker and gets slower with many
  children.
- Indexes, unique constraints, primary keys and triggers are **not** inherited; `CHECK` constraints
  are.
- `tableoid` identifies which child a row came from — the standard trick for reporting across
  children:
  `SELECT tableoid::regclass AS source, count(*) FROM events GROUP BY 1;`

Use inheritance only for legacy schemas or for genuinely heterogeneous tables that share columns
but not semantics. For time-series and multi-tenant data, declarative partitioning is strictly
better.

## Production notes

- Create future partitions ahead of time. An insert with no matching partition fails with
  `no partition of relation "events" found for row` — a hard outage, not a fallback.
  `pg_partman` automates this, and a `DEFAULT` partition avoids the error but silently absorbs
  rows into a partition you then cannot easily move.
- Keep the number of indexes per partition small; index maintenance multiplies by partition count.
- `VACUUM` and `ANALYZE` on the parent recurse; autovacuum settings set on the parent are inherited
  by partitions created afterwards, not retroactively.
- Monitor partition sizes; a skewed partition (one tenant, one month) is where the vacuum and index
  problems concentrate.

## Common mistakes

- Partitioning on a column that queries do not filter on.
- Expecting a global unique index; there isn't one.
- Using `DELETE` for retention on a table that was partitioned for exactly this purpose.
- Forgetting the `CHECK` constraint before `ATTACH PARTITION`, then wondering why it takes an hour.
- Partitioning a 2-million-row table, where the planning overhead exceeds any pruning win.
