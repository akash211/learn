# Designing an ML and LLM-Backed Service

An LLM feature is a distributed system with three budgets instead of one: **quality**, **latency**
and **cost per request**. It has all the usual failure modes of a service — timeouts, retries,
partial failure — plus two unusual ones: the dependency is non-deterministic, and its unit cost is
large enough that a design mistake shows up on the invoice within days.

The worked brief: an assistant answering questions over internal documentation, **200,000
requests/day**, answers grounded in retrieved passages, streamed to the user.

## Requirements and budgets

| Dimension | Target | Consequence |
|---|---|---|
| Quality | ≥ 90% pass on a 300-item golden set; < 2% unsupported claims | Retrieval plus evaluation harness, not just a prompt |
| Latency | TTFT p95 < 1 s; full answer p95 < 8 s | Streaming required; output length capped |
| Cost | < $45,000/month | Prompt caching and response caching are architecture, not tuning |
| Availability | 99.5%, degraded answer acceptable | Fallback model and a "sources only" mode |
| Safety | No PII in prompts, no prompt-injection-driven tool calls | Redaction and allow-listed tools |

Note what is absent: "state of the art". Model choice is downstream of these numbers, and it will
change; the retrieval, evaluation and caching layers will not.

## Architecture

```
client -> API gateway -> guardrails (PII, injection) -> retrieval (hybrid: BM25 + vectors)
                                                              |
                                                    rerank top 20 -> 5 passages
                                                              |
                                     prompt assembly (system + passages + question)
                                                              |
                                        model call (streamed, timeout 8 s)
                                                              |
                                  validation (citations, schema) -> log + eval sample
```

Every box earns its place. Retrieval exists because the model does not know internal documents and
fine-tuning on them would be stale within a week. Reranking exists because vector similarity is a
recall tool, not a precision tool. Validation exists because a plausible unsupported answer is the
failure mode users cannot detect.

## Retrieval sizing

Two million document chunks at 1,536 dimensions, stored as float32:

```
2,000,000 × 1,536 × 4 bytes = 12.3 GB of raw vectors
HNSW index overhead ≈ 1.5×   ->  ~18.4 GB resident
```

So the vector index fits on a single 32 GB node with room for the OS and the query path. That is a
useful conclusion: no sharding, no distributed vector database. Sharding becomes necessary at
roughly 10× this corpus, and the arithmetic is the argument.

Chunking is a modelling decision with numbers attached. At ~500 tokens per chunk, 2 million chunks
is about a billion tokens of source material — 2 million × 500 = 1 billion. Embedding that once at
$0.02 per million tokens costs **$20**; re-embedding monthly is $240/year, which is why changing the
embedding model is cheap and changing the chunking strategy is the expensive decision.

Retrieve 20 candidates, rerank to the best 5. Five passages at ~180 tokens each is 900 tokens of
context — enough to answer most questions, small enough to keep the prompt (and the bill) bounded.

## The token budget

A worked request:

```
system instructions    400 tokens
retrieved passages     900 tokens
user question          200 tokens
input subtotal       1,500 tokens
output (capped)        400 tokens
```

At $3 per million input tokens and $15 per million output:

```
input : 1,500 × $3  / 1,000,000 = $0.0045
output:   400 × $15 / 1,000,000 = $0.0060
per request                     = $0.0105
daily   : 200,000 × $0.0105     = $2,100
monthly : $2,100 × 30           = $63,000
```

That is $18,000/month over the target, so the design has to change the unit economics, not the
model price.

**Prompt caching.** The 400-token system prompt plus the 900-token retrieved context is a stable
prefix within a conversation and often across requests for the same document. Cached input at a
90% discount on 1,200 tokens saves `1,200 × $3/M × 0.9 = $0.00324` per request:

```
$0.00324 × 200,000 = $648/day = $19,440/month
```

**Response caching.** Identical or near-identical questions (a semantic cache at 0.95 similarity)
hit 20% of traffic in a documentation assistant: `0.20 × ($63,000 − $19,440) = $8,712/month` saved,
and those requests return in milliseconds.

New total: `$63,000 − $19,440 − $8,712 = $34,848/month`, under the $45,000 budget with headroom.
Neither optimisation touched model quality; one changed the prompt layout so the stable prefix
comes first, the other added a cache with a short TTL.

## The latency budget

```
guardrails          20 ms
retrieval (hybrid) 120 ms
rerank              80 ms
queueing            40 ms
prefill 1,500 tok @ 3,000 tok/s = 500 ms
------------------------------------------
time to first token             ≈ 760 ms   (p95 target 1 s)
generation 400 tok @ 60 tok/s   = 6.7 s
------------------------------------------
full answer                     ≈ 7.4 s    (p95 target 8 s)
```

Two consequences. Streaming is mandatory — a 7.4-second blank screen is a failed interaction, while
a 0.76-second first token with progressive text is acceptable. And the output cap is a latency
control: if the product needs a 3-second answer, then `3.0 − 0.76 = 2.24 s` of generation at
60 tokens/s allows about **130 output tokens**. Set `max_tokens` from the budget, not from the
model's maximum.

Prefill throughput and generation throughput are different numbers, and conflating them produces
estimates that are wrong by an order of magnitude. Measure both against your provider.

## Quality: evaluation before tuning

A prompt change is a code change with no compiler. The only defence is a fixed evaluation set:

- **300 golden items**, each with a question, the correct answer or required facts, and the
  passages that should be retrieved.
- **Metrics**: retrieval recall@5, answer correctness, citation validity, and refusal when the
  answer is not in the corpus.
- **Gate**: a prompt or model change ships only if the pass rate does not drop by more than 2
  points and no safety case regresses.
- **Online**: sample 1% of production traffic for human review, and track thumbs-down rate per
  intent.

Retrieval quality caps answer quality. If recall@5 is 70%, no prompt fixes the 30% of questions
whose evidence was never retrieved; improve chunking or add BM25 fusion first.

## Failure, guardrails and degradation

| Failure | Behaviour |
|---|---|
| Provider 429/5xx | Retry twice with jitter; then fall back to the smaller model |
| Provider outage | Serve retrieved passages with "here are the sources" — degraded but useful |
| Timeout (8 s) | Return partial streamed answer with a truncation notice |
| Low retrieval confidence | Refuse and ask a clarifying question instead of guessing |
| Prompt injection in a document | Retrieved text is data, never instructions; tools are allow-listed |
| PII in the question | Redact before the call; log the redaction, not the value |

The circuit breaker matters more here than in a typical service: when the provider is slow,
retrying aggressively turns a latency incident into a rate-limit incident. Open the breaker after
five failures in thirty seconds, and keep a queue for work that can complete asynchronously.

## Batch versus interactive

Not every LLM workload belongs behind an API. Summarising 500,000 archived documents is a batch job:
it tolerates hours of latency, benefits from a 50% batch discount, and should never share a rate
limit with interactive traffic. Route by latency requirement:

- **Interactive** (< 8 s): streaming, prompt caching, small model, tight output cap.
- **Asynchronous** (minutes): queue, larger model, retries, no user waiting.
- **Offline** (hours): batch API, spot capacity, idempotent output keyed by document id.

## Common mistakes

- **Choosing the model before the budget.** Cost and latency targets eliminate most candidates; the
  remaining choice is an evaluation, not an opinion.
- **No evaluation set.** Prompt changes become vibes, and regressions ship silently.
- **Putting the variable content first.** It defeats prompt caching and multiplies cost.
- **Unbounded context.** "Just include the whole document" doubles tokens for a marginal quality
  gain and doubles latency.
- **Trusting retrieved text as instructions.** Prompt injection is the new SQL injection.
- **No fallback path.** A provider outage becomes a product outage for a feature that could degrade.

## Production notes

Log per request: prompt version, model, token counts, cache hit, retrieval ids, latency breakdown,
and validation outcome. That log is how you answer "why did cost double on Tuesday" and "why did
quality drop after the deploy". Version prompts like code, evaluate before shipping, and keep the
golden set in the repository next to them.
