# Vector Indexes and Filtering

Brute force compares the query against every vector: exact, and linear in corpus size. A million 1,024-dimension float32 vectors is about 4 GB per query: fine at 10 QPS, hopeless at 500. Every approximate index exists to trade a little recall for a lot of
speed — and the trade is only safe if you measure what it costs.

## The shape of the problem

All practical indexes are one of two families:

- **Partition-based (IVF)**: cluster vectors into cells at build time; search the few cells nearest
  the query.
- **Graph-based (HNSW)**: link each vector to its near neighbours; walk the graph greedily from an
  entry point toward the query.

Plus a compression layer that can sit on top of either, trading memory for recall.

## IVF: cluster, then probe

`IVFFlat` in pgvector, `IndexIVFFlat` in FAISS, similar in Milvus.

```sql
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1000);
SET ivfflat.probes = 20;
```

- `lists` should be roughly `rows / 1000` for up to a million rows, and `sqrt(rows)` beyond that.
  Too few lists means each cell is huge and probing is expensive; too many means cells are sparse
  and the nearest cell may not contain the nearest vector.
- `probes` is the recall/latency dial at query time. Probing 1 list is fast and inaccurate;
  probing `sqrt(lists)` is a reasonable starting point.
- The index must be **trained** on a representative sample. Build it before loading data and the
  centroids are wrong; build it on last quarter's distribution and drift degrades recall silently.
- New vectors are assigned to the nearest existing centroid, so heavy insert-only workloads with
  evolving content gradually degrade. Periodic rebuilds are part of the operating cost.

IVF builds fast and uses little memory; HNSW is the better default for read-heavy, latency-
sensitive work.

## HNSW: the graph

`HNSW` builds a hierarchy of proximity graphs. Search enters at the top layer, descends greedily,
and does a beam search at the bottom layer.

| Parameter | Effect | Typical |
| --- | --- | --- |
| `m` | Links per node per layer | 16 (default); 32–48 for high recall |
| `ef_construction` | Beam width at build time | 64–200; higher = better graph, slower build |
| `ef_search` | Beam width at query time | 40 default in pgvector; raise for recall |

Costs that surprise people:

- **Memory.** The graph is roughly `m × 2 × 4–8 bytes` per vector on top of the vectors themselves.
  At `m = 32` and 10M vectors that is several GB before you store a single embedding.
- **Build time.** Building is much slower than inserting into a B-tree, and pgvector's build is
  bounded by `maintenance_work_mem`; too small and it spills to disk and crawls.
- **Deletes are tombstones.** Removing a node from the graph is expensive, so implementations mark
  it deleted and skip it at query time. A heavily churned index accumulates dead nodes and loses
  recall until it is rebuilt.
- **Updates are re-inserts.** Changing a vector means inserting a new node; the old one becomes a
  tombstone.

## Compression

| Method | Size | Recall behaviour |
| --- | --- | --- |
| float32 | 4 bytes/dim | Baseline |
| float16 (`halfvec`) | 2 bytes/dim | Negligible loss on most models |
| int8 (scalar quantisation) | 1 byte/dim | Small loss; needs per-dimension scaling |
| binary | 1 bit/dim | Large loss; requires rescoring a shortlist |
| product quantisation | 8–64 bytes total | Depends on subquantisers; needs reranking |

The pattern that works: store compressed vectors in the index for traversal, keep full-precision
vectors (or the original text) alongside, and rescore the top 50–100 candidates exactly. That gives
binary-level memory with float-level ranking quality. pgvector exposes this through `halfvec` and
`bit` column types; Qdrant through `quantization_config` with `rescore: true`; FAISS through
`IndexIVFPQ` plus a separate flat index.

## Choosing an engine

| Engine | Model | Strong at | Weak at |
| --- | --- | --- | --- |
| pgvector | Extension in PostgreSQL | Transactions, joins, filters, one system of record | Very large scale, high-QPS ANN tuning |
| Qdrant | Dedicated service | Payload filtering, named vectors, quantisation | Another service to operate |
| FAISS | Library | Fast experimentation, exotic index types | No CRUD, no persistence story, no ACLs |
| Milvus | Distributed service | Billion-scale, GPU indexes | Operational weight |
| LanceDB | Embedded, columnar | Local/edge, versioned datasets | Smaller ecosystem |
| OpenSearch / Elastic | Search engine | BM25 and kNN in one query, mature ops | Vector tuning less granular |
| Vespa | Serving platform | Ranking expressions, multi-phase ranking | Steep learning curve |

Two questions decide it. **Already on PostgreSQL, corpus under a few million chunks?** pgvector
keeps retrieval in the same transaction as the metadata, removing both a consistency problem and a
service. **Need per-tenant isolation, heavy filtering, or 10M+ vectors?** A dedicated store earns
its operational cost.

FAISS is a library, not a database: no durable CRUD, metadata filtering or access control —
excellent offline, a poor service foundation.

## Filtering is the hard part

A vector index returns the nearest *k* globally. A `WHERE tenant_id = 42` clause applied afterwards
can eliminate almost all of them, so `LIMIT 10` returns two rows — or zero.

Three strategies:

1. **Post-filter** (naive): search k, then filter. Cheap, breaks badly at low selectivity. Never
   use it when filters can remove more than a few percent of the corpus.
2. **Pre-filter**: compute the allowed set from metadata, then search within it. Exact and
   correct, but a full scan of the allowed set — fine when the set is small (thousands), hopeless
   when it is millions.
3. **Filtered traversal**: the index itself respects the predicate. Qdrant builds payload indexes
   and walks the graph only through matching nodes; pgvector applies the `WHERE` during the scan and,
   since 0.8, continues scanning beyond the initial `ef_search` budget with
   `hnsw.iterative_scan = relaxed_order`, bounded by `hnsw.max_scan_tuples`.

The practical rule: **estimate selectivity first**. If the filter keeps less than a few percent of
the corpus, a pre-filtered exact scan is usually both faster and more accurate than ANN. If it keeps
most of the corpus, plain ANN with post-filtering is fine. The dangerous middle — filters that keep
10–40% — is where filtered ANN implementations need tuning and where most "we get too few results"
bugs live.

Partitioning is the structural answer: one collection or partition per tenant, or per language, or
per document class, so the filter becomes a routing decision rather than a predicate.

## Measuring recall

Approximate recall is measurable:

```python
sample = random.sample(queries, 200)
truth = {q: exact_search(q, k=10) for q in sample}        # brute force, offline
approx = {q: index.search(q, k=10) for q in sample}
recall = mean(len(set(truth[q]) & set(approx[q])) / 10 for q in sample)
```

Report recall@10 alongside p95 latency, per filter slice. A configuration at 0.85 recall and 15 ms
may be a worse product than 0.97 at 40 ms, because the missing 15% is silently wrong answers, not
- Tune `ef_search` or `probes` to target recall, then stop.

## Build and change operations

- `CREATE INDEX ... USING hnsw` takes an `ACCESS EXCLUSIVE`-class lock for its duration in
  PostgreSQL. On a live table use `CREATE INDEX CONCURRENTLY`, which is slower but non-blocking.
- Raise `maintenance_work_mem` for the build (1–4 GB is common) and `max_parallel_maintenance_workers`
  where supported. A build that spills is an order of magnitude slower.
- Rebuilding while serving doubles memory: build into a new table and swap.
- Monitor tombstone ratio; rebuild before recall collapses, not after a bad answer.

## Common mistakes

- Ignoring index memory in capacity planning; HNSW routinely needs more RAM than the raw vectors.

## Production notes

- Keep an exact-search path behind a flag for small result sets and for debugging: "what would
  brute force have returned?" answers most recall questions in one query.
- Log the index parameters and build timestamp with each collection. Recall regressions correlate
  with rebuilds far more often than with code changes.
- Benchmark with *your* filters and *your* query distribution. Public latency numbers are measured
  on unfiltered, uniformly distributed queries, which is not what production looks like.
