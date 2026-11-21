# The Pipeline, Stage by Stage

RAG is usually drawn as a loop with five boxes. In production it is eight stages, and most of the
quality lives in the three nobody demos: parsing, chunking, and prompt assembly. The rest of this
module takes each stage apart; this chapter is the map, the contracts between stages, and the
things that go wrong at the seams.

## The stages

```
ingest → parse → chunk → embed → index
                                 ↓
query → rewrite → retrieve (dense + lexical) → fuse → rerank → assemble → generate → cite
                                                                    ↓
                                                                  log/trace
```

The arrow worth noticing is the one that is missing: nothing flows from generation back into the
index automatically. That is deliberate. A pipeline that learns from its own answers without a
verification step will happily index its own hallucinations.

Each stage has a contract with the next. Write them down, because almost every "RAG is broken"
bug is a contract violation rather than a model problem.

| Stage | Produces | Contract |
| --- | --- | --- |
| Parse | Text plus structure | Every character accounted for; no silent drops |
| Chunk | Units with stable ids | `chunk_id` derivable from (doc, version, offset, text hash) |
| Embed | Vector per chunk | Same model, same normalisation, same prefix convention as queries |
| Index | Searchable store | Metadata filterable; deletes propagate |
| Retrieve | Candidate list | Recall@k measured on a labelled set, not assumed |
| Rerank | Ordered shortlist | Ordering is what the generator sees; scores are comparable within one query |
| Assemble | Prompt | Token budget enforced; evidence ordered deliberately |
| Generate | Answer plus citations | Every claim maps to a supplied id, or the answer abstains |

## Ingest and parse

Ingest is scheduling, deduplication and provenance: which documents exist, which version is
current, who can read them, and when they changed. Give every document a stable source id and a
content hash. The hash is what lets you skip unchanged files and detect that a document changed
without changing its timestamp.

Parsing is where quality is silently lost. A PDF is a page description, not a document; a scanned
contract is an image; a spreadsheet used as a table is a grid of cells with merged headers. Tools
matter here more than anywhere else in the stack: `unstructured`, Docling, PyMuPDF for text
extraction, `pdfplumber` for tables, Tesseract or a vision model for scans, `tree-sitter` for code.
Whatever you choose, **verify by sampling**: pull twenty random documents, extract, and read the
output. A parser that drops table cells produces chunks that look fine and answer wrongly.

Record per-document parse metadata: pages, characters extracted, tables found, whether OCR ran. A
sudden drop in characters per page across a batch is an ingestion bug, not a content change.

## Chunk

A chunk is the unit of retrieval, and it is not the unit of reading. That distinction drives
chapter 3. For now, the contract: every chunk carries `doc_id`, `chunk_index`, `section_path`
(headings, breadcrumb), `page`, `char_start`, `char_end`, `token_count`, `content_hash`, and an
ACL tag. The offsets are what let you highlight the exact passage in the UI, and the hash is what
makes re-indexing idempotent — re-embed only what changed.

## Embed

Two rules, both routinely broken:

1. **The query and the passage must go through the same model, with the same prefix convention.**
   Asymmetric models such as E5 expect `query: …` and `passage: …`; instruction-tuned embedders
   expect a task instruction on the query side only. Skip it and recall degrades quietly, with no
   error to tell you.
2. **Store the model name and version next to the vector.** `text-embedding-3-small@2024-01` and a
   future revision do not share a space, even at the same dimensionality. Mixing them returns
   plausible garbage.

Batch embedding requests, retry with backoff, and cache by content hash so a re-index only pays
for changed text.

## Index

You need two things: a vector index over embeddings, and a lexical index (BM25 or Postgres full-text)
over the same chunks. Keeping both in one engine — pgvector plus `tsvector`, or OpenSearch with
kNN and BM25 — removes a class of consistency bug: split across systems, you get dual writes, and
dual writes leave a window where one side is stale.

The second decision is where the authoritative metadata lives. Keep it with the documents, in a
transactional store, and treat the vector index as a derived artifact you can rebuild.

## Retrieve

Run both retrievers in parallel with a candidate depth larger than what you will show the model —
typically 30–100 per retriever. Dense retrieval handles paraphrase and cross-lingual matching;
lexical handles part numbers, error codes, product names and rare tokens. Fuse with reciprocal rank
fusion or a weighted score, then rerank.

Retrieval has a metric you can trust offline: on a labelled query set, recall@k is a number, not
an opinion. Measure it before touching the prompt.

## Assemble

The prompt is a budget. A typical layout:

```
[system: role, citation rules, abstention rule]        ~200 tokens
[document context: 4-8 chunks, each with an id]        ~2000-6000 tokens
[conversation summary if multi-turn]                    ~300 tokens
[user question]                                         ~50 tokens
```

Ordering matters. Put the strongest evidence at the start and end of the context block: models
attend most reliably to both ends and least to the middle (Liu et al., "Lost in the Middle", 2023).
Deduplicate near-identical chunks — three paraphrases of the same paragraph crowd out a fourth,
better passage. Keep the id header on every chunk; it is what the citation step will reference.

Never concatenate without a budget check. A silent truncation that cuts the passage containing the
answer is one of the most common causes of a confident wrong answer, and it leaves no error in the
logs.

## Generate and cite

Ask for the answer and the evidence in one pass, with an explicit refusal path:

```
Answer using only the context below. After each sentence, cite the
bracketed id of the passage that supports it, e.g. [S3]. If the
context does not contain the answer, say "I could not find this in
the provided documents" and name what is missing.
```

Then verify the citations programmatically (chapter 8). A citation that points at a real document
which does not support the claim is worse than no citation, because it transfers unearned trust.

## Log the trace

One row per request, containing: query as typed, rewritten query, filters applied, candidate ids
with scores from each retriever, fused order, reranked order, the exact prompt (or its hash plus
the chunk ids), the answer, the citations, token counts per stage, latency per stage, model and
index versions, and the user's feedback if it arrives. Without this you cannot debug a bad answer
— you can only guess at it, and guessing is how teams end up rewriting prompts to fix a parsing bug.

## A minimal skeleton

```python
def answer(question: str, user: User) -> Answer:
    trace = Trace(question=question, index_version=INDEX_VERSION)

    q = rewrite(question, history=trace.history)           # chapter 6
    filters = {"acl_groups": {"$in": user.groups}}         # server-side, never model-chosen

    dense = vector_search(embed_query(q), k=50, filters=filters)
    lexical = bm25_search(q, k=50, filters=filters)

    candidates = rrf([dense, lexical], k=60)[:30]
    ranked = rerank(q, candidates, top_n=8)

    prompt = assemble(ranked, budget_tokens=6000)
    out = generate(prompt)                                  # returns text + [S#] markers

    citations = verify_citations(out.text, ranked)          # chapter 8
    trace.record(dense, lexical, ranked, prompt, out, citations)
    return Answer(text=out.text, citations=citations, trace_id=trace.id)
```

Each function is where a real system grows: `rewrite` needs conversation state, `rerank` needs a
timeout and a fallback to the fused order, and `verify_citations` must fail closed.

## Production notes

- Make every stage independently runnable: a `retrieve-only` endpoint that returns chunks without
  generating is the single most useful debugging tool you can build.
- Timeout and degrade. If the reranker misses its budget, serve the fused order; if the lexical
  index is down, serve dense only and record it.
- Idempotency is not optional. Re-running ingestion for a document must produce the same chunk ids
  and the same vectors, or every retry doubles your index.

## Common mistakes

- Treating chunk ids as ephemeral. If they change on every re-index, citations, feedback and
  evaluation labels all break at once.
- Letting the model choose metadata filters. It will invent `region: "Europe"` when the stored
  value is `eu`.
