# Retrieval: Loaders, Splitters, and Retrieval Chains

Retrieval-augmented generation is the part of the LangChain surface that people use most and understand least. The chain is the easy half. Almost every quality problem lives in the ingestion side: what got loaded, how it was split, what embedding produced the vectors, and whether the retriever returns anything relevant at all — including when the honest answer is "nothing".

## Documents and loaders

The data unit is `Document`, with `page_content` (text) and `metadata` (a dict). Metadata is not decoration: it carries the source path, page number, section heading, tenant id, and the ingestion timestamp you will need for citations, filtering and re-indexing.

```python
from langchain_community.document_loaders import PyPDFLoader

docs = PyPDFLoader("handbook.pdf").load()   # one Document per page
docs[0].metadata   # {'source': 'handbook.pdf', 'page': 0, ...}
```

Loader reality, in order of how often it bites:

- **PDF text extraction is unreliable.** Multi-column layouts interleave, tables collapse into word soup, headers repeat on every page. If quality matters, extract text with a layout-aware tool and hand LangChain `Document` objects you built yourself.
- **Scanned PDFs produce empty strings, not errors.** The loader succeeds and returns nothing useful. Check for emptiness after loading.
- **`lazy_load()` is the streaming variant** and is what you want for large corpora, so the process does not hold every document in memory.
- **Web and API loaders change without notice.** Sites restructure; loaders return boilerplate navigation text. Deduplicate and sanity-check.

The loader is a thin shim over a parser library. When it misbehaves, debug the parser, not the chain.

## Splitting is a retrieval decision

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=800,
    chunk_overlap=120,
    separators=["\n## ", "\n\n", "\n", " "],
    add_start_index=True,
)
chunks = splitter.split_documents(docs)
```

`RecursiveCharacterTextSplitter` tries separators in order and only breaks inside a chunk when it must, which preserves paragraph structure better than a fixed window. `add_start_index` records the offset in the original document, which is what makes "expand this chunk to its parent section" possible later.

The tradeoff is fundamental:

| Chunk size | Retrieval | Generation |
|---|---|---|
| Small (200–400 tokens) | Precise, more chunks, more noise | Fragmentary context, missing surrounding meaning |
| Medium (600–1000) | Good default | Enough context for most answers |
| Large (1500+) | Imprecise scores, duplicates crowd out results | Rich context, expensive, dilutes attention |

Retrieval quality depends on the *question-to-chunk* match, not on what reads well to a human. A table split down the middle retrieves as two useless fragments. A section split at a heading retrieves as a coherent unit. For structured docs, split on structure — `MarkdownHeaderTextSplitter` to make section-aware chunks, then a character splitter for anything oversized.

Two things people skip: `chunk_overlap` exists so an answer spanning a boundary appears whole in at least one chunk, and embedding *tokens* are not the same as chunk characters. A 1000-character chunk of dense code can exceed a small embedding model's window and get silently truncated.

## Embeddings and stores

```python
from langchain_openai import OpenAIEmbeddings
from langchain_postgres import PGVector

store = PGVector(
    embeddings=OpenAIEmbeddings(model="text-embedding-3-small"),
    collection_name="handbook_v3",
    connection="postgresql+psycopg://...",
)
store.add_documents(chunks)
```

The embedding model is part of the index's identity. Change it — even to a new version of the same model — and every stored vector is garbage relative to new query vectors. Version the collection name, keep the model name in metadata, and re-embed rather than mixing.

Similarity search returns the top *k* nearest chunks, which is not the same as the top *k* relevant ones. `max_marginal_relevance_search` trades some similarity for diversity, which helps when five chunks say the same thing. Score thresholds help more: if the best score is below a floor, return nothing and let the application say "I don't know" rather than feeding the model irrelevant text and inviting a confident hallucination.

## Retrievers and retrieval chains

A retriever is anything with `invoke(query) -> list[Document]`. A vector store is one source; `BM25Retriever` (lexical), `EnsembleRetriever` (weighted blend), `MultiQueryRetriever` (LLM rewrites the query several ways), `ParentDocumentRetriever` (retrieve small, return large), and `ContextualCompressionRetriever` (rerank or filter after retrieval) are others.

The canonical chain:

```python
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain.chains import create_retrieval_chain

qa = create_retrieval_chain(retriever, create_stuff_documents_chain(model, prompt))
answer = qa.invoke({"input": "What is the sabbatical policy?"})
answer["answer"], answer["context"]
```

(In v1 these legacy helpers moved to `langchain_classic.chains`; the LCEL version below is what you should write for new code either way.)

The same thing in LCEL, which is worth writing once so the abstraction stops being magic:

```python
def format_docs(docs):
    return "\n\n".join(
        f"[{d.metadata.get('source')}#{d.metadata.get('page')}]\n{d.page_content}" for d in docs
    )

rag = (
    {"context": retriever | format_docs, "input": RunnablePassthrough()}
    | prompt
    | model
    | StrOutputParser()
)
```

Note what the LCEL version exposes that `create_retrieval_chain` hides: the exact string the model sees. That string is where most RAG bugs live — missing separators, no source labels, duplicated chunks eating the context window.

## What actually improves RAG quality

In rough order of measured impact for typical corporate corpora:

1. **Hybrid retrieval.** Vector search misses exact identifiers, product codes and rare names; BM25 misses paraphrase. Run both and fuse (reciprocal rank fusion) or weight them.
2. **A reranker.** Retrieve 30 candidates, rerank with a cross-encoder, keep 5. This is usually the single biggest jump after fixing chunking.
3. **Better chunking.** Section-aware, with heading context prepended to each chunk.
4. **Query rewriting.** Multi-query or HyDE for conversational input where the question lacks context.

Adding another chain wrapper ranks far below all four. This is the honest summary of the ecosystem: retrieval gains come from information-retrieval work, not from LangChain features.

## Grounding and refusal

A retrieval chain that always answers will answer from parametric memory when retrieval fails, which is indistinguishable from a correct answer to a user. Two cheap defences: instruct the model to answer only from `<context>` and to emit a fixed refusal token otherwise, and check the refusal token is emitted when the retriever returns nothing. Return the source documents to the caller so the citation is real, and keep `score` thresholds in configuration so they can be tuned per corpus.

## Common mistakes

- Indexing PDFs without checking that text was actually extracted.
- Leaving `chunk_size` at the default because the tutorial did.
- Mixing embeddings from two models in one collection.
- Retrieving `k=4` and assuming the answer is among them.
- Feeding retrieved text with no delimiters or source labels, then blaming the model for ignoring it.
- Re-indexing by deleting and re-adding without a versioned collection, so queries hit a half-built index.

## Production notes

Treat ingestion as a data pipeline with tests: assert chunk counts, assert no empty chunks, assert metadata completeness. Version collections. Log retrieved ids and scores with every answer — when a user reports a wrong answer, that log is the only way to tell retrieval failure from generation failure. Watch token cost of the context block; stuff-chains grow linearly with `k` and with chunk size, and it is easy to ship a prompt that costs more in input tokens than the answer is worth.
