# Embeddings: Dimensions, Normalisation, and Domain Mismatch

An embedding model turns text into a point in space, positioned so that texts meaning similar things
land near each other. That is the entire contract. Everything that goes wrong with embeddings in
production is a violation of the fine print: the wrong similarity function, a truncated input, a
query encoded as if it were a document, or two models' vectors mixed in one index.

## What the model is doing

Almost every retrieval embedder is a **bi-encoder**: a transformer that pools its final token states
into one fixed-length vector. It is trained contrastively — pull a query and its relevant passage
together, push it away from passages that are not relevant, with in-batch negatives doing most of
the work. The training objective explains the behaviour you observe in production:

- It optimises **topical and semantic proximity**, not factual entailment. "Refunds are not
  available after 30 days" and "refunds are available after 30 days" embed very close together.
- It has a hard token limit (512 for many models, 8192 for newer ones). Text past the limit is
  silently discarded. A chunk that overflows gets a vector describing only its first 512 tokens,
  and nothing in the API tells you.
- It compresses everything into one vector, so long inputs are averages. Precision per token falls
  as length rises, which is the real argument for small chunks.

## Similarity, and why normalisation matters

Cosine similarity, dot product and Euclidean distance give the same ranking **only when all vectors
have the same norm**. Normalise to unit length and:

```
cos(a, b) = a · b        and        ||a - b||² = 2 - 2·a·b
```

so the three metrics become monotone transforms of each other. Without normalisation they diverge:
dot product rewards long vectors, and models do not emit consistently-scaled vectors across inputs.

Most modern models are trained with cosine similarity and *should* be used with `<=>` in pgvector or
`COSINE` in Qdrant. Inner-product indexes assume normalised inputs; if you store unnormalised
vectors and query with `<#>`, ranking changes subtly and recall drops in ways that look random.

Normalising is one line and it removes an entire class of bug:

```python
v = model.encode(text)
v = v / np.linalg.norm(v)          # then cosine == dot, and L2 indexes are usable
```

## Dimensions

Width is a capacity/price trade. A 384-dimension model stores and searches roughly eight times
cheaper than a 3072-dimension one, and on many retrieval tasks the accuracy difference is small —
but on fine-grained, jargon-heavy domains it is not.

| Model | Dims | Context | Notes |
| --- | --- | --- | --- |
| `all-MiniLM-L6-v2` | 384 | 256 tok | Fast baseline; short context limits it |
| `bge-small-en-v1.5` | 384 | 512 tok | Strong small English model |
| `nomic-embed-text-v1.5` | 768 | 8192 tok | Matryoshka; long context; open weights |
| `bge-base-en-v1.5` | 768 | 512 tok | Common self-hosted default |
| `multilingual-e5-large` | 1024 | 512 tok | 100+ languages; needs `query:`/`passage:` |
| `bge-m3` | 1024 | 8192 tok | Dense + sparse + multi-vector in one model |
| `text-embedding-3-small` | 1536 | 8191 tok | Hosted; supports `dimensions` truncation |
| `text-embedding-3-large` | 3072 | 8191 tok | Hosted; strongest of the OpenAI pair |

**Matryoshka** models are trained so that the first *n* dimensions are themselves a usable embedding.
That lets you truncate 1536 → 512, renormalise, and cut storage by two thirds while keeping most of
the recall — and it lets you run cheap short vectors for candidate generation and full vectors for
reranking. Truncation always requires renormalising; the prefix is not unit length on its own.

Lower dimension is not free in another sense: pgvector's HNSW index supports up to 2,000 dimensions
for `vector`, 4,000 for `halfvec` and 64,000 for `bit`. A 3,072-dimension model forces `halfvec` or
a dimensionality reduction step.

## Asymmetric retrieval

A question and the passage that answers it are not the same kind of text. Models handle this in one
of three ways, and getting it wrong is the most common silent quality loss:

- **Prefixes.** E5 expects `"query: "` and `"passage: "`. BGE v1.5 expects an instruction on the
  query side for retrieval, e.g. `"Represent this sentence for searching relevant passages: "`.
- **An `input_type` parameter.** Cohere's embed models take `search_query` vs `search_document`;
  Voyage uses `query` vs `document`. The provider applies a different projection per side.
- **Nothing.** Some models are symmetric and expect identical treatment. Applying a prefix they
  were not trained with degrades them.

Whichever applies, it must be applied identically at index time and query time. A pipeline that
indexes with `passage:` and queries without `query:` still returns results, which is why the bug
survives for months.

## Domain mismatch

A general embedder has never seen your product names, internal acronyms, or the way your customers
phrase things. Two symptoms:

- Queries use vocabulary that never appears in the documents ("cancel" vs "terminate", "seat" vs
  "licensed user").
- The model clusters on topic but not on **the distinction that matters** — for a legal corpus, that
  a clause is an obligation rather than a permission.

Cheap fixes first, in order of cost:

1. **Hybrid retrieval.** Lexical search covers exact terms the embedder smooths away. Often enough
   on its own (chapter 6).
2. **Query and document expansion.** Add synonyms or generated questions to each chunk before
   embedding (`doc2query`-style). Index-time cost only.
3. **Fine-tune the embedder.** Collect (query, relevant passage) pairs from logs, click data or
   synthetic generation, then train with `sentence-transformers` using
   `MultipleNegativesRankingLoss` and evaluate with `InformationRetrievalEvaluator`. This is the
   highest-leverage model to tune in a RAG system, and it is cheap to evaluate: retrieval metrics
   need no LLM judge.

## Multilingual and cross-lingual

If queries and documents can be in different languages, the embedding space must be shared. An
English-only model will place a Hindi query nowhere near its English answer, and no reranker
recovers from an empty candidate list.

- Use a genuinely multilingual model: `multilingual-e5`, `bge-m3`, Cohere multilingual, or a
  multilingual sentence-transformers model. "Supports 50 languages" usually means "was trained on
  them", not "aligns them".
- Test **cross-lingual** retrieval explicitly: query in language A, relevant document in language B,
  measure recall. This is a separate slice from monolingual recall and it fails first.
- Chunking interacts with language: tokenizers fragment Devanagari, Thai and CJK differently, so a
  400-token chunk in English may be 250 tokens of content in Hindi. Size chunks by tokenizer, not by
  character count.
- Do not translate the corpus as a shortcut unless you also keep the original. Translation loses
  identifiers, and identifiers are what users search for.

## Versioning

An embedding model change is a **full re-index**, not an upgrade. Vectors from two models are not
comparable even at identical dimensionality: the spaces are unrelated rotations of each other.

Practical rules:

- Store `embedding_model`, `embedding_version` and `dim` on every row.
- Build the new index alongside the old one; dual-write new documents to both; backfill; evaluate;
  then flip an alias. Never re-embed in place.
- Freeze the model for the lifetime of an index. Provider "silent" model updates are a real
  operational hazard; pin explicit versions where the API allows it.

## Common mistakes

- Mixing a cosine-trained model with an inner-product index and unnormalised vectors.
- Letting chunks exceed the model's token limit so the tail of every long chunk is unsearchable.
- Embedding the query with a different prefix, instruction or `input_type` than the documents.
- Changing the embedder and re-embedding only new documents, leaving the index half in each space.
- Assuming a bigger model fixes domain mismatch. It often just produces confident wrong neighbours.

## Production notes

- Batch embeddings at the provider's maximum batch size with exponential backoff; a re-index of a
  million chunks is thousands of requests and some will fail.
- Cache by content hash. Re-chunking one section should re-embed one section.
- Log the embedding model with every query. When recall drops after a deploy, this is the first
  thing to check and the hardest to reconstruct afterwards.
- Sanity-check a new model with a tiny labelled set before trusting a leaderboard: five queries
  whose answers you know, checked by hand, catch most catastrophic mismatches.
