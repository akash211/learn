# Evaluation: Retrieval Recall, Faithfulness and Golden Sets

RAG systems fail in two places with two different mechanisms, so they need two different kinds of
measurement. Retrieval either finds the right passage or it does not; that is a search problem, and
the metric is recall. Generation either uses the passage correctly or it does not; that is a
grounding problem, and the metric is faithfulness. An aggregate "answer quality" score measures
neither, and a team that only tracks it will spend months tuning the wrong component.

## Build the golden set first

Everything else depends on a set of queries with known correct evidence and known correct answers.
There is no shortcut, but there is a cheap way to start: **mine real queries**.

Sources, in order of value:

1. Support tickets and chat transcripts where you can see what the user actually asked and which
   document resolved it.
2. Search logs with click-through — the clicked document is a weak positive label.
3. Questions written by subject-matter experts against the corpus.
4. Generated questions: for each chunk, ask a model to write a question the chunk answers. Fast,
   scales to thousands, and biased — it produces questions that sound like the document, which is
   exactly what retrieval finds easy.

Target 100–300 queries for a working set, each with: the query, the relevant chunk ids (and the
relevant document ids), a reference answer written from the sources, and slice tags (language, doc
type, question type).

Three properties matter more than size:

- **Label at two granularities.** Document-level labels survive re-chunking; chunk-level labels
  measure chunking. Record both, because a re-chunk invalidates half your labels otherwise.
- **Split by document, not by query.** If the same document appears in train and test, tuning
  chunking on the test set is just leakage with extra steps.
- **Include the hard slices deliberately**: numeric questions, negations, multi-hop, tables,
  non-English, and questions whose answer is *not* in the corpus. That last category is the only way
  to measure abstention.

## Retrieval metrics

Given a ranked list and a set of relevant ids:

| Metric | Question it answers | Use when |
| --- | --- | --- |
| recall@k | Is any relevant chunk in the top k? | Primary retrieval metric |
| precision@k | What share of the top k is relevant? | Prompt budget is the constraint |
| MRR | How high is the first relevant hit? | Single-answer lookups |
| nDCG@k | Is the ordering good, graded by relevance? | Reranker tuning |
| Hit rate | Fraction of queries with ≥1 relevant hit | Executive-friendly summary |

Report recall at the depth you actually pass to the generator, not at 100. Recall@5 of 0.72 with
recall@50 of 0.94 tells a clear story: the right passage is being retrieved but not ranked into the
prompt, so the problem is fusion or reranking, not the index.

Measure each retriever separately (dense, lexical), then the fused result. Fusion should never
reduce recall below the better of the two — if it does, ids are mismatched between indexes or
deduplication is dropping candidates.

Beware the chunk-recall trap: shrink chunks and chunk-level recall rises mechanically, because more
smaller chunks means more chances to hit a labelled span. Document-level recall is the control.

## Answer metrics

Three questions about a generated answer, and they are genuinely different:

- **Faithfulness / groundedness**: is every claim supported by the retrieved context? Measures
  hallucination relative to the evidence, not correctness in the world.
- **Answer relevance**: does it address what was asked? A faithful answer to the wrong question
  scores well on faithfulness.
- **Context precision / recall**: were the retrieved passages the right ones, and were they used?
  Bridges the two halves of the system.

When the two halves disagree, retrieval wins the argument. Faithfulness can only be as good as the
context it is given: an answer that scores 0.99 on faithfulness against the wrong passage is a
perfectly grounded non-answer. Fix recall first, then faithfulness, then relevance — in that order,
because each later metric is conditional on the earlier one being sound.

Ragas names these directly (`faithfulness`, `answer_relevancy`, `context_precision`,
`context_recall`) and is the most common open-source implementation; TruLens and DeepEval cover
similar ground, Arize Phoenix and LangSmith add tracing around them, and promptfoo is convenient for
CI-style assertion suites. They all work the same way underneath: an LLM decomposes the answer into
claims or generates questions from it, then checks each against the context.

That means **the judge is a model, and the metric inherits its biases**. Practical mitigations:

- Use a judge at least as capable as the generator, and never the same model grading itself on the
  same prompt.
- Prefer claim-level entailment ("is this sentence supported by this passage?") over holistic
  scoring. Binary per-claim judgements are far more stable than a 1–10 score.
- Pin the judge model and version. A judge upgrade silently changes your metric baseline.
- Hand-label 50 examples and check the judge's agreement before trusting any number it produces.
- Run the judge at temperature 0 and still expect variance; report confidence intervals or run
  twice on disagreements.

## Offline, in CI

A RAG regression suite is cheap to run and catches the failures that matter:

```python
cases = load_golden_set("eval/golden.jsonl")
report = evaluate(cases, pipeline, metrics=["recall@5", "recall@50", "faithfulness", "relevance"])
assert report["recall@50"] >= 0.90
assert report["faithfulness"] >= 0.95
assert report["recall@50"].slice("multilingual") >= 0.80
```

Run it on every change to: chunking, embedder, index parameters, fusion weights, reranker, prompt
template, and generator model. Gate merges on the slices, not the mean — a pipeline that gains two
points overall while losing fifteen on German queries is a regression.

Also evaluate the **abstention** path: feed out-of-corpus questions and measure the refusal rate.
A system that answers everything scores well on relevance and badly on trust.

## Online signals

Offline metrics cannot see whether users got what they needed. In production, track:

- Thumbs up/down and free-text feedback, segmented by retrieval hit rate.
- Citation click-through — users clicking the source is weak evidence the answer was trusted.
- Follow-up rephrasing within the same session: often a sign the first answer missed.
- Escalation to human support, and ticket re-opening after a self-serve answer.
- Abstention rate. A sudden drop usually means a similarity threshold drifted or an index went stale.

Join these back to the trace: query, rewritten query, retrieved ids, model, index version. Without
the join, feedback is a complaint rather than a diagnosis.

## Cost of evaluation

Evaluating 200 queries with an LLM judge at ~2k tokens each is on the order of a few dollars per
run — cheap enough for CI, expensive enough that you should not judge every commit on the full set.
Split into a 30-query smoke suite for every push and the full suite nightly.

## Common mistakes

- Tuning on the evaluation set until it is memorised, then reporting the tuned number as quality.
- Using one aggregate score, so a retrieval regression and a faithfulness improvement cancel out.
- Labelling only questions the system already answers, which removes exactly the failures worth
  measuring.
- Judging with the same model that generated the answer, on the same prompt, and calling it
  independent.
- Never testing the "answer is not in the corpus" case, then being surprised in production.

## Production notes

- Version the golden set alongside the code. A metric that changed because the labels changed is not
  a metric.
- Store per-query results, not just aggregates. The failures are the useful part.
- Re-mine the golden set quarterly from live logs; the question distribution drifts faster than the
  documents do.
- Keep a small "known-bad" set of previously reported failures. It is the most motivating regression
  suite you will ever have.
