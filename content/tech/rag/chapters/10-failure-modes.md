# Failure Modes: Debugging a Bad Answer End to End

"The assistant gave a wrong answer" is not a diagnosis. In a RAG system there are eight places the
answer could have gone wrong, and they produce nearly identical symptoms. The discipline is to walk
the pipeline in order and prove, at each stage, that the evidence was available and correct — then
stop at the first stage that fails.

## The worked example

A SaaS support assistant. The user asks:

> "What's the refund window for annual plans in Germany?"

The system answers: "Refunds are available within 14 days of purchase." The correct answer is 30
days for EU annual plans. Someone opens a ticket: "the model is hallucinating".

Work the stages.

**1. Is the document in the corpus at all?** Query the metadata store for the policy document by
title. It is there, last updated three weeks ago. Now check the index: `SELECT count(*) FROM chunks
WHERE doc_id = 'policy-2024'`. If the count is zero, ingestion is the bug — a failed parse, a
skipped file extension, a scheduler that stopped. This check eliminates half of all "hallucination"
reports.

**2. Did parsing preserve the answer?** Pull the raw chunk text around "annual plans". If the policy
table lost its header row, the chunk reads "Germany | 30 days" with no indication of what the
columns mean: retrievable by accident, uninterpretable when it is. Table extraction failures look
exactly like model failures from outside.

**3. Is the answer inside one chunk?** Print the chunks covering that section. If the heading is in
chunk 7 and the table is in chunk 8, no single vector represents "refund window for annual plans in
Germany". The fix is structural chunking or parent expansion, not a prompt tweak.

**4. Does the query reach it?** Run the query through retrieval with filters disabled and print the
top 50 ids. Note the rank of the correct chunk. Three outcomes:

- Absent from the top 50: embedding or vocabulary mismatch. The document says "EU" and "yearly
  subscription"; the user says "Germany" and "annual plans". Hybrid retrieval with a lexical path
  fixes most of this, because at least one term usually overlaps.
- Present at rank 30–45: the retriever found it and the ranking buried it. That is a fusion or
  reranker problem, and it is the easiest to fix.
- Present at rank 1 but filtered out downstream: see stage 5.

**5. Did a filter remove it?** Re-run with the exact filters the request applied, including the
locale filter the rewrite step extracted. A rewrite that turns "in Germany" into `country = DE` will
miss a document tagged `region = EU`. Filters derived from natural language are a common and
invisible cause of zero results.

**6. Was it in the prompt?** Check the assembled prompt, not the candidate list. Silent truncation
is the culprit: the context budget cut the last chunk, which happened to be the right one. If the
prompt contains 20 chunks and the model answered from chunk 2, that is the next stage.

**7. Did the model use it?** If the correct passage is in the prompt and the answer contradicts it,
the failure is grounding: too many distractors, the passage buried mid-context, a conflicting
document ranked above it, or an instruction that let general knowledge win. Compare the answer with
what the passage says, sentence by sentence. "14 days" is the US policy, which suggests the model
retrieved a *different* document and preferred it — check whether the German document was deduped
against an identical-looking US one.

**8. Is the citation honest?** If the answer cites `[S4]` and `[S4]` is the German policy, the
citation is fabricated support — the worst outcome, because it looks verified. Run the entailment
check: does `[S4]` actually state 30 days for annual plans in Germany?

In this case the trace shows the correct chunk at rank 22, fused to rank 9, cut to rank 12 by the
reranker, and the prompt kept the top 8. Retrieval was the failure, not generation. The ticket said
"hallucinating" for two weeks while the real bug was a chunk boundary between a heading and a table.

## The ladder, as a table

| Symptom | First check | Usual cause |
| --- | --- | --- |
| Answer is generic, cites nothing | Candidate ids in prompt | Index empty or stale; filter too narrow |
| Answer contradicts a document you know exists | Rank of that document in retrieval | Ranking, not generation |
| Answer is right for the wrong reason | Cited passage vs claim | Parametric override; verification missing |
| Answer mixes two documents | Chunk boundaries, dedupe | Conflation of adjacent sources |
| Same question, different answers | Index version, sampling params | Rebuild mid-session, or non-determinism |
| Works for English, fails for German | Recall per language slice | Monolingual embedder; tokenizer chunking |
| Works in testing, fails in production | Prompt token counts | Truncation under longer real queries |
| Confident answer to an out-of-scope question | Abstention threshold | No calibration; no negative examples |

## Instrumentation that makes this fast

- **A retrieve-only endpoint.** `POST /retrieve {query, filters}` returning scored chunks, no
  generation. It converts a 20-minute investigation into a 20-second one.
- **The full prompt, stored.** Not a hash. You will need to read it.
- **Score breakdown per candidate**: dense score, lexical score, fused rank, rerank score. "Why is
  this chunk here" should be answerable from the trace.

## The failure catalogue

Beyond the example, the recurring ones:

- **Stale index.** The document changed, ingestion did not run, the answer is last quarter's policy.
  Detect with an age metric per source, not per index.
- **Model swapped without re-index.** Vectors in two spaces; results look random. The tell is that
  recall dropped on the day of an unrelated deploy.
- **Chunk too large.** The answer is one sentence in 1,200 tokens, so the embedding averages eleven
  topics. Recall looks mediocre everywhere rather than failing on one query.
- **Top-k too small.** Recall@50 is fine, recall@4 is not. The prompt budget was set by cost, not by
  measurement.
- **Over-aggressive rewrite.** The rewriter adds specifics the user never said ("EU", "annual"), and
  retrieval confidently answers a question nobody asked. Log original and rewritten side by side.
- **Duplicate documents.** One policy in five places, four outdated: retrieval returns all five and
  the model averages them. Deduplicate by content hash at index time.
- **Negation and numbers.** "Not available" and "available" embed close together; "30" and "13"
  embed close together. Neither is fixable by ranking alone — verify numerically (chapter 8).
- **Multi-hop questions.** "Does the enterprise plan include the feature that replaced SSO?" needs
  two retrievals. A single-shot pipeline answers half of it fluently.
- **Aggregation requests.** "How many tickets mention billing?" RAG cannot count. Route to a tool.

## A debugging order that respects cost

Cheapest check first:

1. Corpus and index counts (seconds).
2. Exact string search for the answer in the chunks (seconds).
3. Retrieval rank with filters off, then on (seconds).
4. Prompt contents and token counts (seconds).
5. Generation behaviour with the same context and a different prompt (minutes).
6. Model comparison, embedder comparison, index rebuild (hours).

Most teams start at step 5, which is why the same bug survives three prompt rewrites: no
instruction can fix an empty context.

## Common mistakes

- Changing the prompt before reading the retrieved chunks.
- Reproducing the bug with a freshly typed query instead of the stored one. The rewriter and filters
  behave differently for a paraphrase.
- Trusting the citation because it points at a real document. Check entailment, not existence.
- Fixing one query by raising top-k, paying a token cost on every query forever.
- Closing the ticket without adding the case to the regression set, so the same bug returns after the
  next chunking change.

## Production notes

- Store per-stage pass/fail for sampled requests. "Retrieval found something, rerank kept it, answer
  cited it" is a funnel; the drop-off tells you where to work.
- Sample 20 real failures a week and read them. Automated metrics find regressions; reading finds
  design errors.
- Keep a library of pathological queries — multi-hop, negated, numeric, cross-lingual, out-of-scope
  — and run it on every change.
