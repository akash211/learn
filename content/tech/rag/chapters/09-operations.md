# Operations: Refresh, Cost, Latency, Permissions

A RAG pipeline demo is a weekend. The operational version is a small distributed system with a
corpus that changes underneath it, a bill that scales with tokens, a latency budget of a few hundred
milliseconds, and an access-control model that must never leak a document to the wrong person. This
chapter is what breaks and what to do about it.

## Index refresh

Three patterns, and most teams need all three:

**Full rebuild.** Re-chunk, re-embed, swap. Correct by construction, expensive, and requires double
the index storage plus a window where both exist. Run it for chunker or embedder changes, and
periodically (weekly or monthly) to purge drift from incremental updates.

**Incremental upsert.** The default. On document change, delete the previous chunks for that
`doc_id` and insert the new ones, in one transaction if your store allows it, otherwise
delete-then-insert with an idempotent retry. Key on `(doc_id, content_hash)` so a duplicate event
does not double the index.

**CDC.** Debezium or native logical replication on the source database streams inserts, updates and
deletes. Necessary when documents live in an application database rather than a file store; adds
schema coupling and an ordering problem, since a chunk written from event N+1 must not be overwritten
by a late event N. Stamp events with the source transaction id and drop out-of-order ones.

The failure to design against is **delete lag**. A document removed from the source but still in the
index keeps answering questions. On a compliance deadline that is not a bug, it is an incident.
Delete by `doc_id` first and let the vector store's tombstones settle; verify with a query for the
document id.

## Embedding model migration

Changing the embedder is the highest-risk routine operation in RAG. It touches every vector and
invalidates every threshold tuned on the old space.

The procedure that works:

1. Create a new index with a new name (`chunks__v2`), same rows, new model.
2. Backfill from the source of truth, not from the old index. Re-chunk while you are there if you
   want; you cannot do both later.
3. Evaluate both indices on the golden set. Compare recall@k per slice, not just overall.
4. Shadow traffic: run queries against both, log both candidate lists, compare offline.
5. Flip an alias. Keep the old index for a rollback window measured in days, not hours.
6. Delete the old vectors and the old thresholds.

Never re-embed in place. A half-migrated index returns nonsense that looks like a ranking bug.

## Cost

Four components, and the ordering surprises people:

| Component | Scales with | Notes |
| --- | --- | --- |
| Embedding (index) | Corpus tokens, one-time per model | Cheap per token; re-paid on every model change |
| Vector storage | Chunks × dims × bytes | ~4 KB per 1,024-dim chunk at float32; HNSW adds graph overhead |
| LLM input tokens | Queries × context size | Usually the dominant per-query cost |
| Reranking + judging | Queries × candidates | Cross-encoder GPU time or per-document API price |

The lever that matters most is **context size**, because it is paid on every single query. Halving
top-k from 20 to 10 chunks halves the dominant cost and often *improves* answer quality by removing
distractors. Teams routinely pay for thousands of tokens of boilerplate per request because nobody
looked at the token counts by stage.

Track cost per answered query, not per token. Then attribute it: embedding, retrieval, rerank,
generation. A cost regression after a "small prompt tweak" is invisible otherwise.

## Latency

A working budget, as an order of magnitude rather than a promise:

| Stage | Typical |
| --- | --- |
| Auth and filter resolution | 5–20 ms |
| Query rewrite (LLM) | 150–600 ms |
| Query embedding | 20–100 ms |
| Dense ANN search | 5–30 ms |
| Lexical search | 5–30 ms |
| Rerank (50 docs) | 50–300 ms |
| LLM time to first token | 300–1000 ms |

The rewrite and the rerank are the two stages that can be cut without touching answer quality much.
The rewrite can be skipped for single-turn queries; the rerank can be capped at 25 candidates or
dropped to a smaller model. Decide which degrades first, and make that an explicit, configured
degradation rather than an outage behaviour.

Run retrieval stages in parallel, stream generation tokens, and prefetch for the likely follow-up.

## Caching

Four caches, each with a different invalidation key:

- **Embedding cache**: `hash(text) → vector`. Safe, high hit rate on repeated chunks.
- **Retrieval cache**: `(normalised_query, filters, index_version) → chunk ids`. Must include the
  index version and the full filter set, including the user's ACL groups, or it leaks documents
  between users. This is the cache that causes security incidents.
- **Prompt prefix cache**: provider-side caching of the stable system prompt. Put invariant content
  first and variable content last; reordering the prompt destroys the hit rate.
- **Answer cache / semantic cache**: `(query embedding) → answer`. Tempting and dangerous: two
  queries within 0.02 cosine can have different correct answers ("refund window EU" vs "refund
  window US"). If you use it, scope it tightly by filters and verify on a sample.

## Permission-aware retrieval

This is the part that turns a demo into something an enterprise will buy, and the part most often
built wrong.

Rules:

1. **The filter comes from the session, never from the model.** Resolve allowed groups, tenants and
   document scopes from the authenticated identity, and inject them server-side into every query.
   A model that can choose its own filter can be talked out of it.
2. **Enforce at the chunk, not the document.** A document can have mixed permissions (an HR file
   with a public summary). Store the ACL set on each chunk at index time.
3. **Filter before ranking, not after.** Post-filtering top-k means the model may already have seen
   forbidden text in a reranker log or a debug trace, and it returns fewer results than requested.
   Filtered ANN or pre-filtered exact search, per chapter 5.
4. **Isolate tenants physically where the contract requires it.** Separate collections or schemas
   per tenant remove a whole class of predicate bug; a shared index with a `tenant_id` filter is one
   missing `WHERE` away from a breach.
5. **Do not put secrets in embeddings.** Embeddings are invertible enough to leak phrases, and vector
   stores are frequently less locked down than the source database.
6. **Log retrieval decisions.** Which document ids were returned, for which user, at what time. That
   log is what an audit asks for.

Test it adversarially: a user in group A asks a question whose answer lives in a group-B document.
The correct behaviour is an abstention, not a paraphrase of the forbidden content.

## Monitoring

Dashboards that earn their space:

- Retrieval hit rate and empty-result rate, by query class.
- recall@k on a canary slice replayed daily against the live index.
- Citation coverage (share of sentences with a verified citation) and unsupported-citation rate.
- Abstention rate, and its trend after every index or model change.
- p50/p95 latency per stage, and cost per answered query.
- Index freshness: age of the newest chunk, count of documents pending re-index, delete backlog.

Alert on **changes**, not absolutes. A faithfulness drop from 0.96 to 0.89 after a deploy is
actionable; a constant 0.89 is a project decision.

## Common mistakes

- Rebuilding the index in place, so queries during the rebuild see a half-populated corpus.
- Caching retrieval results without the ACL in the key.
- Treating the vector store as the system of record, then discovering there is no way to answer
  "which documents are indexed, and who can see them?"
- Ignoring delete propagation until a customer exercises a deletion right.
- Budgeting latency for the model only, and being surprised by a 300 ms reranker on the critical path.

## Production notes

- Make the index rebuildable from source at any time. If you cannot, you have a database with no
  backups.
- Keep an index manifest: model, chunker version, build time, row count, source snapshot. Store it
  next to the collection, not in a wiki.
- Give every request a trace id that appears in the retrieval log, the generation log and the billing
  record. Debugging across three systems without one is guesswork.
