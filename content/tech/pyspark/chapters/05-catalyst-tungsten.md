# Catalyst and Tungsten

The reason a DataFrame is usually faster than an equivalent RDD pipeline is that Spark does not
run what you wrote. It rewrites the query, picks operators, generates Java bytecode, and executes
over a compact binary row format. That machinery has two names: **Catalyst** for the planner, and
**Tungsten** for the execution engine underneath it.

## The four phases

```
SQL / DataFrame
      │
      ▼
  Parsed plan        what you typed, unresolved names
      │  analysis (catalog lookup, type coercion)
      ▼
  Analyzed plan      every column resolved, every type known
      │  logical optimisation (rule-based)
      ▼
  Optimized plan     predicates pushed, columns pruned, joins reordered
      │  physical planning (strategies + cost model)
      ▼
  Physical plan      concrete operators, codegen'd at runtime
      │  AQE re-optimisation at each exchange
      ▼
  Executed plan
```

`df.explain("formatted")` shows all four sections, which makes it the single most useful
debugging command in PySpark. `explain("cost")` adds statistics when CBO is on.

**Analysis** is where `AnalysisException: cannot resolve 'cust_id'` comes from. It resolves
column names through the catalog, expands `SELECT *`, applies implicit casts (string to double
in arithmetic), resolves functions and views, and assigns fresh expression IDs. Nothing about
performance happens here — but almost every correctness bug surfaces here.

**Logical optimisation** is a fixed-point loop over rules. The ones that pay for themselves:

| Rule | Effect |
|---|---|
| `PushDownPredicates` | moves filters below joins, aggregates and into scans |
| `ColumnPruning` | removes columns nothing downstream reads |
| `ConstantFolding` | evaluates `1 + 2`, `lit("a").upper()` at plan time |
| `BooleanSimplification` | removes `AND true`, collapses `OR` chains |
| `NullPropagation` | turns `null + 1` into `null` |
| `LimitPushdown` | pushes `LIMIT` into the scan for `head()`/`first()` |
| `ReorderJoin` | reorders joins — only with CBO enabled and statistics present |
| `DecorrelateInnerQuery` | rewrites correlated subqueries as joins |

The effect is visible. This:

```python
(df.filter(F.col("dt") == "2026-01-01")
   .join(dim, "id")
   .select("id", "amount"))
```

becomes a scan with `PushedFilters: [IsNotNull(dt), EqualTo(dt,2026-01-01)]`, a projection of two
columns, and a join that reads only `id` and `amount` from the fact side. The filter moves into
the Parquet reader, so the bytes are never decoded; the pruned columns are never read from disk.
That is a different physical workload from what the Python code appears to say.

## Cost-based optimisation

Rule-based rewriting cannot answer "which side should be broadcast" or "in what order should
these four joins run". That needs statistics: row count, total size, per-column distinct count,
min/max, null count.

```sql
ANALYZE TABLE orders COMPUTE STATISTICS FOR ALL COLUMNS;
```

With `spark.sql.cbo.enabled=true` and `spark.sql.cbo.joinReorder.enabled=true` (both default
false), Catalyst estimates intermediate cardinalities and picks the join order with the lowest
estimated cost. Without stats it guesses from file sizes, which is how a 10 MB dimension gets
planned as a shuffle join because nobody ran `ANALYZE`, or a 2 GB table gets broadcast because
its Parquet files are highly compressed.

Stats go stale. `spark.sql.statistics.size.autoUpdate.enabled` (default true) updates table size
after writes, but column statistics need an explicit `ANALYZE`. A plan that was right last month
can be wrong today because the dimension table tripled.

## Physical planning

Each logical operator has one or more physical strategies. A join, for instance, has five. Spark
attaches a cost to each candidate using the statistics and picks the cheapest, subject to
requirements like "both sides partitioned on the join key".

This is where hints enter:

```python
orders.join(F.broadcast(dim), "id")            # force broadcast hash join
orders.hint("merge").join(dim, "id")           # force sort-merge
orders.hint("shuffle_hash").join(dim, "id")    # force shuffled hash
spark.sql("SELECT /*+ BROADCAST(d) */ ...")
```

Hints are a way of overriding a planner that cannot see the data. They are also a way of freezing
a decision that was right once. Prefer fixing the statistics.

## Whole-stage codegen

For a stage with no exchange, Spark compiles the operator chain into a single Java function:
scan → filter → project → aggregate, one loop, no virtual dispatch between operators, rows kept
as primitives in local variables where possible.

`spark.sql.codegen.wholeStage` is true by default. In the plan, `*(1)`, `*(2)` prefixes mark
codegen'd stages; the number is a codegen stage ID and increments at each new fused chain, so a
plain operator between two numbered stages marks a break in the pipeline.

Codegen has limits. The JVM caps a method at 64 KB of bytecode, and Spark falls back to
interpreted execution when a generated method would exceed
`spark.sql.codegen.hugeMethodLimit`. Very wide tables, deeply nested expressions, and hundreds of
columns are the usual triggers. A plan that suddenly loses its `*` after a schema change is
telling you the query got too big to compile — and it will be slower.

## Tungsten

Tungsten is the set of execution-level decisions that make codegen worthwhile:

- **Binary row format.** `UnsafeRow` stores a row as a compact byte array: null bitmap, fixed-width
  fields, variable-length offsets. No Java object per field, no per-row header, no pointer
  chasing. Sorting and hashing operate on the bytes directly.
- **Explicit memory management.** Operators allocate from a `TaskMemoryManager` over off-heap
  memory, so the JVM garbage collector does not see millions of short-lived row objects. This is
  why Spark can sort terabytes without GC pauses dominating, and why `spark.memory.offHeap.enabled`
  is a real option for large heaps.
- **Cache-aware algorithms.** Sort and hash structures are laid out to be sequential in memory;
  pointer-chasing structures are avoided.
- **Vectorised readers.** The Parquet and ORC readers decode columnar batches
  (`ColumnarBatch`) rather than row by row, and stay columnar until an operator needs rows.

The practical consequences: a `select` of 200 columns does not pay 200 object allocations per
row; a `groupBy` hashes bytes rather than objects; and the whole-stage pipeline keeps values in
registers across several logical operators.

## Where the optimizer stops

Catalyst cannot see inside a black box, and a Python UDF is a black box:

```
+- BatchEvalPython [my_udf(amount#8), pythonUDF0#40]
   +- FileScan parquet [amount#8, ...]
```

Two things just happened. The projection is no longer codegen'd — `BatchEvalPython` is a separate
operator that serialises each row to a Python worker. And the filter that used to be pushed into
the scan may now sit above the UDF, because Catalyst cannot prove the UDF is deterministic or
that reordering is safe. A single Python UDF can turn a sub-minute scan-and-filter into a long
row-by-row round trip.

The same opacity applies to:

- **`mapPartitions` / `rdd.map`** — the plan ends at the RDD boundary; nothing above is optimised.
- **Non-deterministic expressions** (`rand()`, `uuid()`, `monotonically_increasing_id()`) — they
  block constant folding and predicate pushdown.
- **Correlated subqueries** that the decorrelation rules cannot rewrite.
- **Cached DataFrames** — filters can be pushed into `InMemoryTableScan`, but the cached plan is
  fixed; a query that would have pruned columns now reads the full cached schema.

## Reading a plan quickly

| Node | Meaning |
|---|---|
| `FileScan parquet ... PushedFilters: [...]` | filters reached the reader; good |
| `Exchange hashpartitioning(...)` | a shuffle; the main cost centre |
| `BroadcastExchange` / `BroadcastHashJoin` | small side shipped; no shuffle |
| `SortMergeJoin` | two shuffles plus two sorts |
| `AQEShuffleRead coalesced` | AQE merged partitions at runtime |
| `ColumnarToRow` | leaving the vectorised path; usually before a UDF or Python sink |
| `BatchEvalPython` | Python UDF; codegen and pushdown stop here |
| `AdaptiveSparkPlan isFinalPlan=true` | the plan shown is the one that ran |

## Common mistakes

- Reading `explain()` before an action and treating it as final when AQE is on.
- Believing hints are always honoured. A hint that contradicts a hard requirement (broadcast a
  side that does not fit) is ignored or fails at runtime.
- Enabling CBO and expecting a better plan without running `ANALYZE`.
- Adding `persist()` to "help the optimizer" — it creates a fixed `InMemoryRelation` that can
  block later pruning.
- Blaming Catalyst for a slow job whose real problem is 400,000 small files.

## Production notes

Keep `spark.sql.planChangeLog.level=WARN` (and a rules list) in staging when you are tuning: it
logs the plan before and after each optimizer rule, which is the fastest way to find out why a
predicate did not get pushed down.

For repeated queries, compare `explain("formatted")` between the version that was fast and the
one that is slow. The difference is almost always an `Exchange` that appeared, a `BroadcastHashJoin`
that became a `SortMergeJoin`, or a `BatchEvalPython` that replaced a built-in expression.
