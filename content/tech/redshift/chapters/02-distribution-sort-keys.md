# Distribution Styles and Sort Keys

Distribution and sort choices are physical design decisions with workload-wide consequences. Distribution decides which compute slice owns each row. Sort keys decide the physical ordering used for block pruning and ordered access. Good choices reduce data movement and scanned blocks; bad choices create skew, unnecessary network traffic, and maintenance work. They are worth deciding from real joins and filters, not from table names or intuition alone.

## Distribution styles

Redshift supports `DISTSTYLE AUTO`, `EVEN`, `KEY`, and `ALL`. With `EVEN`, rows are spread round-robin across slices, which tends to balance storage and scan work when no useful key is apparent. With `KEY`, rows with the same distribution-key value are colocated on slices. This can make a join local when both large tables use the same key and join on it. With `ALL`, a full copy is placed on each compute node, making a relatively small dimension available locally at the cost of storage and replicated load/update work. `AUTO` lets Redshift manage the choice and is a reasonable starting point for many tables; inspect actual choices and plans rather than presuming it picked the right design for every future query.

A key distribution style is powerful but not free. It can collocate a dominant fact-to-dimension join, yet a low-cardinality or highly skewed key can send a large fraction of rows to a small number of slices. A null-heavy key can produce similar imbalance. Choose a candidate using cardinality, frequency distribution, table sizes, and join workload. The best key is not necessarily the column with the most distinct values; it should also align with joins that matter and avoid pathological value frequencies.

```sql
CREATE TABLE fact_sales (
  sale_id bigint,
  customer_id bigint,
  sale_date date,
  amount decimal(12,2)
)
DISTSTYLE KEY
DISTKEY (customer_id)
SORTKEY (sale_date, customer_id);
```

This example is only sensible if customer joins dominate and customer IDs are sufficiently balanced. A large fact table with multiple important join dimensions cannot be colocated with all of them simultaneously. Measure which joins dominate runtime and whether redistributing a smaller table is acceptable.

## Sort key decisions

A compound sort key stores rows in the declared column order. Its leading columns matter most for block skipping. `(sale_date, customer_id)` is a strong candidate when most scans constrain a range of dates; it is less useful for a query filtering only on customer. A sort key should reflect common filters, range predicates, and sometimes grouping patterns. Do not add columns merely because they occur in a query: every added key component must earn its maintenance and pruning value.

An interleaved sort key gives columns more equal weight for block skipping across different predicate combinations, but it has additional maintenance considerations and is less commonly the default design choice. Historically it could help workloads with many alternative filter dimensions; current recommendations often favor compound keys or automatic table optimization. Compare against current Redshift guidance and the actual `SVV_TABLE_INFO` state before choosing interleaved sorting for a new design.

Sort keys are not indexes. A sort-key predicate can prune blocks if their min/max ranges exclude the target, but a sort key does not point directly to an individual row. A query can still scan many blocks when values overlap widely or the table has become unsorted. Check `unsorted`, `stats_off`, and distribution-related indicators in `SVV_TABLE_INFO`, then correlate them with expensive queries rather than treating one metadata number as a universal threshold.

## Make trade-offs using plans

For joins, `EXPLAIN` indicates whether the engine needs redistribution or broadcast. `DS_DIST_NONE` and `DS_DIST_ALL_NONE` usually mean the join can use colocated data. `DS_BCAST_INNER` means the inner input is broadcast; this may be fine for a genuinely small filtered relation but expensive if the estimate is wrong or the relation grows. `DS_DIST_INNER`, `DS_DIST_OUTER`, and `DS_DIST_BOTH` show data movement that deserves investigation. `DS_DIST_ALL_INNER` is a warning sign because use of `ALL` on the outer side can force work onto one slice.

Do not optimize away every redistribution at any cost. Setting a huge table to `ALL` can multiply storage and loading, and updating that table becomes more expensive. A broadcast of a tiny dimension may be the right plan. Compare representative query runtime, queue behavior, load cost, storage, and maintenance under realistic concurrency. Also ensure statistics are current; a plan's redistribution choice can be driven by a bad row-count estimate.

## Automatic table optimization and evolution

Automatic table optimization can select distribution and sort choices as Redshift learns from workload. It helps teams avoid premature manual design, especially when query patterns are still changing. It does not remove the need to inspect table state and critical plans. A table optimized for one query set may not serve a new dashboard, new join pattern, or changed data distribution equally well. Treat automatic choices as observable decisions, and review them after major workload shifts.

The safest workflow is iterative: start with `AUTO` where appropriate, load a representative dataset, run the real workload, inspect plans and `SVV_TABLE_INFO`, and then decide whether manual keys or changed query shape provide a measurable win. Re-test after data volume and cardinality change. Keep DDL and migration scripts explicit so a design change can be reproduced.

## A practical design review

Start a design review with the query workload: list the largest fact tables, the joins that dominate runtime, common filters, and the dimensions that change frequently. Estimate both table size and value frequencies. A distribution key that is nearly unique may still have extreme skew if nulls or one default value dominate. Inspect the actual data, not only catalog cardinality. For a candidate join key, compare per-slice row balance and determine whether both tables can reasonably use that key.

Then evaluate sort keys separately from distribution. Distribution answers where rows live; sort order answers how blocks are arranged within the table. A date key may be excellent for pruning but not for collocating a customer join. Conversely, a customer distribution key does not automatically make customer-only filters skip blocks. Trying to make one column solve both problems often leads to a compromise that helps neither. Use `EXPLAIN`, table metadata, and observed scan volume to validate each choice.

When data is still small or query patterns are uncertain, automatic settings reduce the risk of premature commitment. Capture the initial state and rerun representative queries after the table and workload grow. If manual changes are proposed, create a comparable table or controlled test, preserve the source, and compare not just query execution but `COPY` time, storage footprint, delete/update behavior, and maintenance. The more workloads depend on a table, the more carefully a physical-design change should be staged and communicated.

## Common mistakes

- Choosing a distribution key from distinct count alone and ignoring skew.
- Assuming matching names mean two tables are collocated; types, values, and declared key must align.
- Treating every `DS_BCAST_INNER` as a defect instead of checking the filtered input size.
- Assuming a sort key behaves like a B-tree index.
- Applying a universal threshold to `unsorted` without considering scan patterns and table size.
- Setting `DISTSTYLE ALL` on a large, frequently changing table to eliminate one network step.
