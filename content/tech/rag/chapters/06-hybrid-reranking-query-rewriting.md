# Hybrid Retrieval, Reranking and Query Rewriting

Dense retrieval alone has a characteristic failure: it is excellent at meaning and bad at strings.
Ask for "error code E4012" or "the Kestrel-3 migration" and an embedder will happily return a
semantically adjacent passage about authentication errors in general. The token that made the query
specific is precisely the token a 1,024-dimension vector smooths away.

The fix is not a better embedder. It is adding a lexical retriever, fusing the two candidate lists,
reranking the result, and rewriting the query so both retrievers get a fair shot. Four stages, each
independently measurable, and each with a specific failure mode.

## Why lexical search still earns its place

BM25 scores a document by term frequency, inverse document frequency, and length normalisation:

```
score = Σ_t idf(t) · (f(t,d) · (k1+1)) / (f(t,d) + k1 · (1 - b + b · |d| / avgdl))
```

with `k1 ≈ 1.2` controlling term-frequency saturation and `b ≈ 0.75` controlling length
normalisation. Its virtues are the complement of dense retrieval's:

- Exact identifiers, SKUs, error codes, function names, legal citations.
- Rare terms, where IDF is high and one match dominates the ranking.
- Negation and numeric constraints, which embeddings blur ("not supported" vs "supported").
- No training, no model version, no re-embedding. A `tsvector` column and a GIN index.

Its weakness is equally clear: vocabulary mismatch. A user asking "how do I cancel" will not match a
document that says "terminate the subscription" unless the terms overlap.

In PostgreSQL both live in one table:

```sql
ALTER TABLE chunks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX ON chunks USING gin (tsv);

SELECT id, content,
       ts_rank_cd(tsv, websearch_to_tsquery('english', $1)) AS lex_score,
       1 - (embedding <=> $2) AS dense_score
FROM chunks
WHERE tsv @@ websearch_to_tsquery('english', $1)
ORDER BY lex_score DESC
LIMIT 50;
```

`websearch_to_tsquery` handles quoted phrases, `OR`, and `-term` the way users expect, which matters
more than any ranking tweak.

## Fusing two ranked lists

Scores from BM25 and cosine are not comparable: BM25 is unbounded and corpus-dependent, cosine sits
in a narrow band near 1. Min-max normalising per query is the obvious approach and the wrong one —
it makes the best result in every list score 1.0, regardless of whether it was actually good, and a
list of uniformly bad results looks identical to a list of excellent ones.

**Reciprocal rank fusion** avoids the problem entirely by using ranks only:

```python
def rrf(rankings, k=60):
    scores = defaultdict(float)
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking):
            scores[doc_id] += 1 / (k + rank)
    return sorted(scores, key=scores.get, reverse=True)
```

`k = 60` (from the original Cormack et al. paper) flattens the curve so that being ranked 1st versus
5th matters less than appearing in both lists. That is the property you want: agreement between
retrievers is stronger evidence than a high score in one.

Weighted fusion (`alpha · dense + (1-alpha) · lexical` with normalised scores) is worth trying when
you have labelled data to tune `alpha` on. Weaviate exposes exactly this as `alpha`; Elasticsearch
and OpenSearch offer RRF natively. Without labels, RRF is the safer default.

## Reranking

Retrieval is a recall stage; reranking is a precision stage. The retrievers return 50–100 candidates
cheaply; a cross-encoder reads each (query, passage) pair jointly and scores relevance, which is far
more accurate and far more expensive — it cannot precompute anything, so cost is linear in candidate
count.

| Reranker type | Example | Latency per 50 docs | Quality |
| --- | --- | --- | --- |
| Cross-encoder | `bge-reranker-v2-m3`, `ms-marco-MiniLM-L-6-v2` | Tens to hundreds of ms on GPU, more on CPU | Strong |
| Hosted reranker | Cohere Rerank, Voyage rerank | One API call | Strong, no ops |
| Late interaction | ColBERT / ColPali via Vespa or Qdrant multivector | Higher storage, mid latency | Strong, cheap at scale |
| LLM listwise | Prompt the generator to order candidates | Highest | Variable, expensive |

Practical shape: retrieve 100 per retriever, fuse to ~50, rerank 50 → keep 5–8 for the prompt. The
reranker is also where you can enforce diversity (MMR, or dedupe near-identical chunks) so the
context is not five paraphrases of the same paragraph.

Two operational notes. Rerankers need a **timeout and a fallback** to the fused order; a 300 ms p99
tail on a 150 ms budget should degrade, not fail. And rerank scores are comparable *within* one query
only — never threshold them globally.

## Query rewriting

The user's message is rarely a good search query. It contains pronouns, implied context from three
turns ago, and vocabulary from their world rather than the document's. Rewriting fixes that, and it
is the cheapest quality win in the pipeline.

**Conversational condensation.** Turn "what about the EU?" into "What is the refund window for
annual plans in the EU?". Without it, follow-up questions retrieve nothing, because the vector has
no subject. This is the single highest-value rewrite in any chat product.

**Multi-query expansion.** Generate 3–5 paraphrases, retrieve for each, fuse. Improves recall on
ambiguous phrasing; triples retrieval cost and can drift off-topic if the generator is loose. Cap the
number and keep the original query in the fusion.

**HyDE** (Gao et al., 2022). Generate a hypothetical answer, embed *that*, and search with it.
Answers look more like documents than questions do, so the vector lands closer to the target.
Useful for terse or jargon-heavy queries; risky when the generator hallucinates specifics, because
those specifics become the search terms.

**Step-back and decomposition.** "Compare our refund policy with the enterprise SLA" is two
retrievals plus a synthesis. Decompose multi-hop questions into sub-queries, retrieve per sub-query,
then answer. Step-back prompting asks a more general question first to ground the specific one.

**Filter extraction.** "Refunds in Germany last quarter" should produce `country = DE` and a date
range, not just a vector. Extract structured filters with a constrained model call, then apply them
**server-side** alongside the user's ACL filter. Never let the model's output widen what the user is
allowed to see.

**Routing.** Not every query should hit the same index: policy questions to the docs index, "where
is my order" to the orders tool, chit-chat to no retrieval at all. A small classifier or an LLM
router decides, and misrouting is a top cause of "the assistant is useless" feedback.

Every rewrite adds latency and a new failure mode. Log the rewritten query next to the original;
when retrieval quality drops, you need to know whether the user asked badly or the rewriter did.

## Measuring each stage

| Stage | Metric | How |
| --- | --- | --- |
| Dense retrieval | recall@50 | Labelled query set, chunk ids |
| Lexical retrieval | recall@50 | Same set |
| Fusion | recall@20 after fusion | Must be ≥ max of the two retrievers |
| Rerank | nDCG@10, MRR | Ordering quality, not just presence |
| Rewrite | recall delta on follow-ups | A slice of conversational queries |

If fused recall is lower than the best single retriever, the fusion is broken — usually a
deduplication bug or mismatched ids between the two indexes.

## Common mistakes

- Adding hybrid search and leaving `limit` at 5 per retriever, so fusion has almost nothing to work
  with. Retrieve deep, return shallow.
- Normalising scores per query and then comparing them across queries.
- Reranking 500 candidates because "more is better", blowing the latency budget for a marginal gain.
- Rewriting the query and then using the rewritten query as the citation text, so the answer quotes
  a question the user never asked.
- Letting the rewrite step invent filters (`region: Europe` when the corpus stores `EU`), then
  getting zero results and blaming the index.

## Production notes

- Run dense and lexical retrieval concurrently. Sequentially they add latency for no reason.
- Keep the raw query in the fusion even after expansion. It is the one query you know the user meant.
- Cache rewrites per (query, conversation prefix); they are deterministic enough to reuse.
- Track empty-result rate per rewrite strategy. A rewriter that doubles recall but triples zero-hit
  queries is a net loss.
