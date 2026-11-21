# Chunking: Strategy and Trade-offs

Chunking constrains everything downstream. A chunk is what gets embedded, so it is what a query
can match; what gets returned, so it is what the reranker scores; and what gets pasted, so it is
what the model reads. Get the boundaries wrong and no amount of
reranking, prompt engineering or model choice recovers the answer, because the evidence was never
in one retrievable unit.

## The unit mismatch

Retrieval wants small, focused units: a 200-token passage about refund windows embeds to a vector
that is mostly about refund windows. Generation wants large, coherent units: the same passage plus
the sentence that says "this applies only to annual plans sold in the EU" and the table of
exceptions. These are not the same size, and the tension between them is the whole design problem.

Two ways out, and most systems use both: retrieve small and expand to the parent section before
generating, or retrieve small with a header of surrounding context attached to each chunk.

## Fixed windows

Split into N tokens with an overlap of M: cheap, predictable, no parser needed.

```python
def fixed_chunks(text: str, size=400, overlap=60):
    tokens = tokenize(text)                      # use the embedder's tokenizer
    step = size - overlap
    for i in range(0, len(tokens), step):
        yield detokenize(tokens[i : i + size])
```

Overlap exists so that a sentence cut at a boundary appears intact in at least one chunk. Ten to
fifteen percent is the usual range; more overlap means more near-duplicate vectors competing for
the same top-k slots, which is why 50% overlap often *lowers* answer quality while raising cost.

The failure is obvious: a fixed window cuts through a table, mid-sentence, or between a heading
and the content it labels, and it makes a page of navigation text look like a page of
specification.

Use it as a baseline to beat.

## Recursive structure splitting

Split on the strongest boundary that yields chunks under the limit, then recurse: paragraphs →
sentences → words. This is `RecursiveCharacterTextSplitter` in LangChain and the default node
parser behaviour in LlamaIndex. It respects paragraph boundaries where it can and degrades
gracefully where it cannot, which is why it is the sensible default for mixed prose.

The improvement is modest: paragraph boundaries in a PDF are layout artifacts, not semantic units.

## Semantic chunking

Embed each sentence, then cut where the similarity between consecutive sentences drops below a
threshold — typically a percentile of the distance distribution within the document rather than an
absolute value.

It finds topic shifts that layout does not mark: the end of a procedure, the start of a caveat.
You embed every sentence before you can chunk, so indexing cost roughly doubles. The percentile threshold is document-relative, so chunk sizes vary between documents and
drift when the corpus changes. And the boundaries are not stable across embedder versions: change
the model and every chunk id changes with it.

Semantic chunking earns its cost on long, poorly structured prose — transcripts, support threads,
It is near-useless on documents with good headings, where structure beats cosine distance.

## Parent-child and sentence windows

The cleanest resolution of the unit mismatch: embed small, return large.

- **Parent-child**: index child chunks of 150–300 tokens, each carrying `parent_id`. At query
  time, match children, then substitute the parent section (up to a token cap) into the prompt.
  Retrieval precision comes from the child; answer completeness comes from the parent.
- **Sentence window**: index single sentences plus a window of neighbours stored in metadata;
  return the sentence with ±k neighbours. Same idea at finer grain, and it works well for
  documentation where the answer is one sentence and the qualification is the next.

The cost is storage and a second lookup. The benefit is that a 200-token query vector is not
diluted by 2,000 tokens of surrounding material: an embedding is a fixed-size summary, and every
irrelevant sentence takes capacity from the relevant one.

## Structure-aware chunking

If the source has structure, use it. Splitting on headings is nearly free and usually beats every
embedding-based method.

**Markdown and HTML**: split at heading levels, keep the heading path as metadata
(`H1 > H2 > H3`), and prepend it to the chunk text. A chunk that begins "Refunds > Annual plans >
EU exceptions" is retrievable by queries that never appear in its body.

**Code**: split on syntax, not lines. `tree-sitter` gives you functions, classes and methods as
nodes. Keep the signature and docstring with the body; keep imports in a file-level chunk. A


**Tables**: never split rows from headers. Serialise the table (Markdown or CSV) with the header
row repeated in each chunk, or convert it to one sentence per row with the column names inlined
("Plan: Annual; Region: EU; Refund window: 30 days"). Tables are where pure-text chunkers fail
most visibly, because the answer is a cell and the meaning is the header.

## Contextual headers

A cheap, high-yield trick: before embedding each chunk, prepend a short generated context — the
document title, the section path, and one line situating the chunk in the document ("This is an
exception to the refund policy described above"). Anthropic published this as "contextual
retrieval" in 2024 and reported a large reduction in retrieval failures when combined with
reranking; treat the size of the effect as theirs, the mechanism as sound. The generation
cost is one cheap LLM call per chunk at index time, paid once.

Do not confuse it with retrieval-time query rewriting. The header changes what the chunk *is*; the
rewrite changes what is asked.

## Choosing parameters

| Strategy | Chunk size | Best for | Main failure |
| --- | --- | --- | --- |
| Fixed window | 300–500 tok | Plain prose, parser failures | Cuts tables and headings |
| Recursive | 300–800 tok | Mixed documents | Paragraphs are layout artifacts |
| Semantic | 200–600 tok | Transcripts, long narrative | Cost, unstable ids |
| Parent-child | 150–300 child | Docs with sections | Extra lookup, token budget |
| Structure-aware | Per section | Markdown, code, API docs | Sections longer than the limit |
| Sentence window | 1 sentence + k | FAQ, policy clauses | Loses multi-sentence reasoning |

Sizing heuristic: a chunk should contain **one answerable idea**. If you cannot write a question
that a chunk fully answers, it is too large or badly bounded. If a chunk needs its neighbour to
make sense, it is too small.

## Measuring chunking

You cannot tune what you do not measure. Three numbers, computed on a labelled query set:

- **Recall@k by document**: is the right document retrieved at all? Insensitive to chunking, so it
  isolates parser and index problems.
- **Recall@k by chunk**: is a chunk containing the answer in the top k? Sensitive to boundaries;
  a gap between document recall and chunk recall is a chunking problem.
- **Chunk size distribution**: median, p95, and the share of chunks under 50 tokens. A long tail of
  tiny chunks is usually navigation text or table fragments; a tail of huge chunks is usually a
  missing heading boundary.

Inspect failures by eye. Print the chunk that should have matched and ask whether a human could
answer the question from it alone. That single check catches more chunking bugs than any metric.

## Common mistakes

- Using 1,000-token chunks because "more context is better". It is better for the reader and worse
  for the retriever: the vector is an average, and the answer is one paragraph in it.
- Splitting on characters instead of the embedder's tokens, so chunks silently exceed the model's
  limit and get truncated at embed time.
- Re-chunking with a new strategy and forgetting that every stored chunk id, citation and
  evaluation label just became invalid.
- Chunking HTML that still contains navigation, cookie banners and footers: boilerplate repeated on
  every page dominates the embedding space.

## Production notes

- Store `char_start`/`char_end` so the UI can highlight the exact cited span. Users trust a
  highlighted sentence far more than a document link.
- Set a hard minimum chunk length (30–50 tokens) and merge anything shorter into its neighbour;
  fragments embed to noise.
- Version the chunker with the embedder: `chunker@v3 + embed@v2` is an index identity, and mixing
  them yields citations that point at text no longer in the index.
