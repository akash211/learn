# RAG, Fine-Tuning, and the Decision That Comes First

Every team that wants an LLM to "know about our stuff" faces the same fork: put the material in
the weights, or put it in the prompt. The two options fail differently, cost differently, and go
stale at different rates. Getting the choice wrong is expensive in a way that is hard to notice
early — a fine-tuned model that sounds authoritative and is quietly six months out of date looks
exactly like a working system until someone checks an answer.

## Two kinds of memory

A language model's knowledge lives in its parameters. That memory is large, diffuse, and frozen at
the training cutoff. Retrieval-augmented generation adds a second, external memory: a searchable
store of your documents, read at query time and pasted into the context window. Lewis et al. named
the pattern in 2020, pairing a dense retriever with a sequence-to-sequence generator; the
architecture has changed a great deal since, but the split between parametric and non-parametric
memory is still the whole idea.

The distinction that matters operationally is **where the change happens when a fact changes**.
In a fine-tune, a fact is a distributed pattern across millions of weights, and there is no address
at which to edit it. In a RAG index, a fact is a row with an id, and you can update it in
milliseconds, attribute an answer to it, or delete it because a customer asked you to.

## What fine-tuning actually changes

Fine-tuning is very good at teaching **form**: output schema, tone, house style, the shape of a
tool call, the difference between a terse answer and a careful one, refusal behaviour, domain
vocabulary. It is a poor mechanism for teaching **content**.

Supervised fine-tuning on question-answer pairs where the answer
contains a fact the model did not know teaches the model to produce answers of that shape with
high confidence. It does not reliably install the fact, because the gradient signal rewards
fluency, not lookup. Gekhman et al. (2024) showed the effect directly: fine-tuning on facts the
model could not already recall *increased* hallucination rather than curing it, and the examples
that helped least were precisely the ones containing new knowledge. If a fact is worth relying on,
it needs to be retrievable and checkable, not merely trained in.

There is a second, harder problem: **fine-tuning cannot forget**. Remove a discontinued product
from a training set and retrain, and the old associations are still partly present, mixed with the
new ones. In a retrieval index, deletion is a `DELETE`.

## What RAG actually buys

Four properties, in rough order of how often they decide the architecture:

- **Freshness.** Re-index a changed document and the next query sees it. No training run, no
  deployment, no evaluation cycle.
- **Provenance.** Each answer can carry the id of the passage it came from. That is what makes an
  answer auditable, and it is the single largest practical difference in a regulated or
  customer-facing setting.
- **Per-user access control.** Retrieval can be filtered by who is asking. A fine-tuned model has
  one set of weights for everyone; the only way to enforce permissions is to not train on the data,
  which usually defeats the purpose.
- **Cheap, reversible change.** A wrong chunk can be fixed by editing a document. A wrong weight
  cannot be fixed at all without another training run.

And what it costs: tokens on every query, a retrieval latency floor, a pipeline with more moving
parts, and a new class of failure where the right document exists but is not found.

## The cost curves point in opposite directions

Fine-tuning has high fixed cost and low marginal cost. You pay for curation, training, evaluation
and a deployment path once; each query then costs whatever the (possibly smaller, possibly
distilled) model costs to run. RAG has low fixed cost and high marginal cost: standing up a
pipeline is a week's work, but every query carries embedding, search, reranking and a much larger
prompt.

The rule of thumb: **fine-tune to make a cheaper model
do a narrower job; retrieve to make any model know more.** If the goal is to replace a frontier
model with a small one for a fixed task — classify a ticket, extract fields from an invoice,
rewrite a query — fine-tuning wins on unit economics. If the goal is to answer questions about a
body of text that changes, RAG wins because the alternative is retraining forever.

## Long context is not a substitute

A model with a million-token window can technically hold a small corpus. In practice it is a poor
replacement for retrieval:

| Concern | Long context | Retrieval |
| --- | --- | --- |
| Cost per query | Grows with every token sent | Grows with top-k, not corpus size |
| Latency | Prefill dominates; scales with input length | Small constant plus search |
| Attention quality | Degrades for material in the middle (Liu et al., 2023) | Only relevant passages compete |
| Provenance | Model must be asked to quote; often paraphrases | Chunk ids are known before generation |
| Permissions | The whole document set is in one request | Filtering happens before the model sees anything |
| Freshness | Still needs the document set assembled | Index update |

Long context is a useful *second* stage — hand the generator a whole section once retrieval has
narrowed the field — but as a replacement for retrieval it merely moves the problem from "which
chunk" to "which million tokens", and drops access control on the way.

## A decision procedure

Ask these in order. The first one that fires usually settles it.

1. **Must the answer be attributable to a source?** If yes, you need retrieval regardless of what
   else you do. A model cannot cite what it memorised.
2. **Does the underlying content change more often than you can retrain and re-evaluate?** If yes,
   retrieval.
3. **Is the data per-user or per-tenant?** If yes, retrieval with server-side filters.
4. **Is the task a fixed transformation with a stable input/output shape?** Classification,
   extraction, routing, normalisation. Fine-tune; retrieval adds nothing.
5. **Is the bottleneck cost or latency at high volume?** Fine-tune a smaller model, then retrieve
   into it if it also needs facts.
- **Is the knowledge procedural — how to do something rather than what is true?** Few-shot
  prompting first, fine-tuning second, RAG last.

## The combination that usually wins

In production the question is rarely either/or. The pattern that holds up is: **fine-tune or
prompt the behaviour, retrieve the facts, and tune the retriever rather than the generator.**

That last clause is the one teams under-use. If retrieval quality is the bottleneck — and it
usually is — the highest-leverage model to fine-tune is the *embedder* or the *reranker*, trained
on your own query-passage pairs harvested from logs. A domain-tuned bi-encoder or cross-encoder
improves every downstream answer without touching generation, and it is far cheaper to train and
evaluate than a generator fine-tune.

The layered version looks like this:

- Prompt: role, output contract, citation rules, abstention rule.
- Retrieval: hybrid search plus reranking, tuned on a labelled query set.
- Generator: optionally fine-tuned for format and tone, not for facts.
- Guardrails: citation verification, schema validation, refusal on empty evidence.

## Common mistakes

- Fine-tuning on a document dump and calling it a knowledge base. The model learns the register of
  the documents, not their contents.
- Assuming a bigger context window removes the need for chunking and ranking. It changes the
  failure mode from "not retrieved" to "retrieved but ignored".
- Fine-tuning before measuring retrieval. If recall@10 is 0.6, no amount of generator tuning fixes
  the missing 40%.

## Production notes

- Keep the fine-tune and the index independently deployable. Coupling them means every content
  change becomes a model release.
- Version both: `model@2026-03` and `index@sha` in the trace. A bad answer is unattributable
  without them.
- If you fine-tune for format, evaluate on format compliance separately from factual accuracy.
  A model can score 100% on schema and 60% on truth, and aggregate scores hide exactly that.
- Budget the retrieval path from the start. A pipeline that adds 400 ms before the first generated
  token changes which product surfaces can use it.
