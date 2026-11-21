# Adaptive Query Execution and the Knobs That Matter

Static planning has a fundamental problem: at plan time, Spark does not know how big the data
actually is. Statistics are stale, missing or estimated from compressed file sizes, so the
strategy chosen before the first byte is read is often wrong. Adaptive Query Execution fixes that
by pausing at shuffle boundaries, measuring what the map stage produced, and re-planning the rest
of the query with real numbers.

AQE has been on by default since Spark 3.2 (`spark.sql.adaptive.enabled=true`). Understanding
what it does automatically — and what it still leaves to you — is most of what "Spark tuning"
means in 3.5.

## How AQE works

```
Stage 1: scan -> filter -> partial aggregate -> shuffle write
                    │
                    ▼  map output statistics (real partition sizes)
        re-optimise: coalesce partitions, choose join strategy, split skew
                    │
Stage 2: shuffle read -> final aggregate -> write
```

The unit of adaptation is the **materialisation point** — a shuffle exchange. AQE cannot
re-plan inside a stage, because the tasks are already running. So a query with no shuffle (a pure
scan-and-filter) gets nothing from AQE, and a query with five shuffles gets up to five
re-optimisation opportunities.

This is also why `explain()` before an action can be misleading: the plan you see is provisional.
`AdaptiveSparkPlan isFinalPlan=false` means "not yet decided".

## The three things AQE does

### 1. Coalesce shuffle partitions

The most valuable feature, and the one that made `spark.sql.shuffle.partitions=200` less
dangerous. After the map stage, AQE knows the size of every reduce partition. If many are tiny,
it merges contiguous ones so each task reads roughly a target size:

| Setting | Default | Meaning |
|---|---|---|
| `spark.sql.adaptive.coalescePartitions.enabled` | true | enable merging |
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | 64 MB | target size per coalesced partition |
| `spark.sql.adaptive.coalescePartitions.minPartitionSize` | 1 MB | floor when parallelism wins |
| `spark.sql.adaptive.coalescePartitions.minPartitionNum` | `spark.default.parallelism` | never go below this many |
| `spark.sql.adaptive.coalescePartitions.parallelismFirst` | **true** | favour parallelism over the 64 MB target |

That last row is the one people miss. With `parallelismFirst=true`, Spark ignores the 64 MB
advisory size when merging and only respects the 1 MB minimum, to avoid a parallelism regression
when AQE was first enabled. If you want the target size respected — fewer, fuller tasks — set it
to false explicitly:

```python
spark.conf.set("spark.sql.adaptive.coalescePartitions.parallelismFirst", "false")
```

Coalescing also enables the **local shuffle reader**
(`spark.sql.adaptive.localShuffleReader.enabled=true`), which can read a coalesced shuffle block
from local disk instead of fetching it over the network. On a cluster with a slow shuffle
service, this is a quiet but significant win.

### 2. Switch join strategies

After a shuffle, AQE knows each side's real size. If one side turns out to be small enough, it
converts the planned sort-merge join into a broadcast hash join — removing the second shuffle and
both sorts. If `spark.sql.join.preferSortMergeJoin=false`, it can also choose a shuffled hash
join when the build side is small relative to the probe side.

This is why wildly wrong statistics sometimes do not hurt as much as expected: the static plan
was bad, but AQE saw the truth at the first exchange and fixed it. It is also why a plan that
*needs* a broadcast at the very first join (no preceding shuffle) still fails — there is no
materialisation point to learn from.

### 3. Handle skew in sort-merge joins

`spark.sql.adaptive.skewJoin.enabled` (default true) detects reduce partitions that are both
above `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` (default 256 MB) and
`skewedPartitionFactor` (default 5× the median). It splits those partitions into sub-partitions
and replicates the matching side, so one task no longer carries the hot key.

`spark.sql.adaptive.forceOptimizeSkewedJoin` (default false) controls whether Spark will split
even when doing so adds an extra shuffle; leaving it false avoids a pathological case where
splitting costs more than the skew.

The limits are important: this applies to **sort-merge joins only**. It does not split skewed
aggregations, window functions, or skewed input partitions. Chapter 4 covers salting and hot-key
splitting for those cases.

## Rebalance partitions

Since 3.2, `df.repartition(n)` and `df.repartition(n, "key")` can use a `RebalancePartitions`
operator when AQE is on, which distributes rows evenly *and* fixes skew — unlike hash
repartitioning, which cannot split a key. `spark.sql.adaptive.optimizeSkewsInRebalancePartitions.enabled`
(default true) lets AQE further split oversized rebalance partitions.

The practical use is before a write: `repartition(200)` gives evenly sized output files without
the "all rows of one key in one file" problem that `repartition(200, "key")` has.

## The knobs that actually matter

Sorted by how often they are the answer:

| Setting | Default | Change it when |
|---|---|---|
| `spark.sql.shuffle.partitions` | 200 | always, per job: 2–4× total cores |
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | 64 MB | you want 128–200 MB tasks; set `parallelismFirst=false` too |
| `spark.sql.autoBroadcastJoinThreshold` | 10 MB | a known-small dimension is being shuffled |
| `spark.sql.files.maxPartitionBytes` | 128 MB | read tasks are too small or too large |
| `spark.sql.files.openCostInBytes` | 4 MB | many small files are packing badly |
| `spark.executor.cores` | 1 (standalone/YARN) | 3–5 is a sane range; more cores mean more concurrent memory pressure |
| `spark.executor.memory` | 1 GB | sized from partition size, not from "as much as possible" |
| `spark.executor.memoryOverhead` | max(384 MB, 10%) | Python UDFs, Arrow, native memory |
| `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` | 256 MB | partitions are legitimately large |
| `spark.sql.sources.partitionOverwriteMode` | STATIC | any incremental partition write |
| `spark.speculation` | false | a few stragglers dominate stage time |

One knob people reach for that rarely helps:

- **`spark.sql.shuffle.partitions` set very high** ("more parallelism"). It trades a small number
  of big tasks for thousands of tiny ones, and the scheduler becomes the bottleneck.

## What AQE cannot fix

AQE is a re-planner, not a magician. It cannot help with:

- **Read-side skew.** One 30 GB gzipped file is one task before any shuffle happens.
- **Aggregation skew.** A `groupBy` on a hot key is not a sort-merge join; splitting it is manual.
- **Small files.** Planning time and per-file overhead are outside the query plan.
- **Python UDFs.** A row-at-a-time Python operator is slow at any partition size.
- **Driver bottlenecks.** `collect()`, huge broadcast collection, and giant plans.
- **Bad layouts.** A filter that cannot prune still reads the bytes.
- **Broadcast build-side skew.** If the broadcast side is 900 MB, every task builds a 900 MB hash
  map; AQE does not shrink it.

## A tuning method

1. **Find the slow stage** in the Spark UI, not the slow job. Duration per stage, and which stage
   dominates.
2. **Read its summary metrics**: shuffle read size (max vs median), spill memory/disk, GC time,
   input size, task count.
3. **Classify the problem**: too few partitions (huge tasks), too many (tiny tasks), skew (max ≫
   median), spill (partition bigger than memory), or I/O (input bytes too high).
4. **Change one thing.** Usually `spark.sql.shuffle.partitions` first, then layout, then join
   strategy, then memory.
5. **Re-run and compare the same metrics.** A change that improves wall time but increases shuffle
   bytes has moved the problem, not solved it.

## Testing and plan stability

AQE makes plans non-deterministic across runs: partition counts depend on runtime sizes, so a
test that asserts an exact physical plan will flake. For plan-shape tests, disable AQE; for
performance tests, keep it on — production has it on.

`spark.sql.adaptive.optimizer.excludedRules` lets you disable specific adaptive rules when one is
producing a bad plan, and `spark.sql.planChangeLog.level` (3.3+) logs each re-optimisation, which
is the only reliable way to see what AQE actually did.

## Common mistakes

- Setting `spark.sql.shuffle.partitions` to a huge number and assuming AQE will fix the tiny
  tasks — with `parallelismFirst=true`, it deliberately will not merge below its floor.
- Turning AQE off because "the plan changed between runs".
- Expecting AQE to fix a skewed `groupBy`.
- Tuning executor memory before looking at partition sizes.
- Changing five configs at once, then attributing the improvement to the wrong one.

## Production notes

Set `spark.sql.shuffle.partitions` from the job's data volume, not from a cluster-wide default:
`shuffle_bytes / 150 MB`, bounded below by `2 × total cores`. Let AQE coalesce upward and split
skew.

Keep the adaptive settings at their defaults unless you have a measured reason. The default's
failure mode is "slightly more tasks than ideal"; aggressive tuning's failure mode is one 8 GB
task that OOMs at 3 a.m.
