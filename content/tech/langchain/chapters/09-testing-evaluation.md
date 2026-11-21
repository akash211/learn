# Testing and Evaluation

An LLM pipeline has two test problems that need different tools. The plumbing — prompt rendering, key mapping, parsing, routing, retry policy — is deterministic and should be unit-tested with no network calls. The model output is not deterministic, so quality requires a scored evaluation over a dataset. Teams that mix the two end up with flaky CI and no quality signal.

## Layer 1: deterministic tests with fakes

`langchain-core` ships fake chat models that return scripted responses.

```python
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

fake = GenericFakeChatModel(messages=iter([AIMessage(content="Approved.")]))
chain = prompt | fake | StrOutputParser()
assert chain.invoke({"draft": "x"}) == "Approved."
```

| Fake | Behaviour | Use |
|---|---|---|
| `GenericFakeChatModel` | Cycles a message iterator, supports streaming | Chain plumbing, streaming tests |
| `FakeListChatModel` | Returns strings from a list, ignores input | Simple return-value tests |
| `FakeMessagesListChatModel` | Returns `AIMessage`s from a list | Tool-call and content-block shapes |
| `DeterministicFakeEmbedding` | Hash-based vectors, stable across runs | Vector store tests without an API |
| `InMemoryVectorStore` | In-process store | Retrieval tests |
| `InMemoryChatMessageHistory` | Message list | History wiring tests |

Custom fakes are often better than the built-ins, because tests read more clearly when the fake asserts the prompt it received:

```python
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatResult, ChatGeneration

class RecordingModel(BaseChatModel):
    seen: list = []
    reply: str = "ok"

    @property
    def _llm_type(self) -> str:
        return "recording"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(self.reply))])
```

Now `model.seen[0]` is the exact message list the prompt produced — assert on it. This is the single most valuable test in an LLM codebase: it locks the prompt text, so an "innocent" template edit that drops a constraint fails CI instead of surfacing as a quality regression three weeks later.

## What is worth asserting

- **Rendered prompt**, as a snapshot of `format_messages()` output. Not the template source.
- **Parser behaviour** on adversarial strings: fenced JSON, trailing prose, empty string, truncated object.
- **Routing decisions**: given classifier output X, the right branch runs with the right input.
- **Tool argument validation**: your `args_schema` rejects the values the model is likely to produce.
- **Fallback and retry paths**: inject an exception from the fake and assert the fallback ran and the error was preserved.
- **Streaming equivalence**: `"".join(chain.stream(x)) == chain.invoke(x)` for a deterministic fake.
- **Retrieval shape**: the context string contains the expected source labels and no empty chunk.

Never assert exact model text in a test that calls a real model. It fails on the next provider update and teaches the team to ignore red builds.

## Layer 2: evaluation

Evaluation answers "is the output good", which requires a dataset and a scorer.

```python
cases = [
    {"inputs": {"question": "What is the sabbatical policy?"},
     "outputs": {"answer": "12 weeks after 5 years, approved by your manager."}},
]

def correct(answer: str, reference: str) -> bool:
    return all(fact in answer.lower() for fact in ["12 weeks", "5 years"])

results = [(c, chain.invoke(c["inputs"])) for c in cases]
score = sum(correct(r["answer"], c["outputs"]["answer"]) for c, r in results) / len(results)
```

Three scorer types, in order of reliability:

1. **Programmatic.** Does the JSON parse? Does it contain the order id? Is the number in range? Cheap, deterministic, and covers far more than people expect.
2. **Reference-based text metrics.** Exact match, containment, or token overlap (ROUGE/BLEU). Fast, but score wording rather than correctness — use for classification and extraction, not for prose.
3. **LLM-as-judge.** A second model scores against a rubric. Necessary for tone, faithfulness and completeness. Requires its own validation: judge prompts drift too, judges have position and verbosity bias, and an unvalidated judge is a random number generator with good manners.

```python
judge_prompt = ChatPromptTemplate.from_messages([
    ("system", "You grade answers. Reply with JSON: {\"score\": 0-2, \"why\": \"...\"}. "
               "2 = fully supported by the context; 1 = partially; 0 = contradicts or invents."),
    ("human", "Context:\n{context}\n\nQuestion:\n{question}\n\nAnswer:\n{answer}"),
])
judge = judge_prompt | model | JsonOutputParser()
```

Validate the judge against 30–50 human-labelled examples before trusting its scores. If it agrees with humans under 80% of the time, its numbers are decoration.

## RAG and agent evaluation differ

**RAG** splits into two measurements, and conflating them makes failures unfixable:

| Metric | Question | How |
|---|---|---|
| Retrieval recall | Did the right chunk appear in top-k? | Label chunk ids per question |
| Faithfulness | Is every claim supported by the retrieved context? | Judge with context only |
| Answer relevance | Does it answer the question asked? | Judge with question + answer |
| Refusal correctness | Does it decline when context is absent? | Adversarial cases with no answer |

If retrieval recall is low, prompt work is wasted. If recall is high and faithfulness is low, the prompt or the model is the problem. Measuring only the end-to-end answer tells you nothing about which.

**Agents** need trajectory evaluation, not just final output: which tools were called, in what order, with what arguments, and how many steps. A correct answer produced by six wrong tool calls is a latent failure that will surface on the next input. Score: tool selection accuracy, argument validity, step count against a budget, and whether a required approval was requested.

## Running evals without going broke

- **Smoke vs full.** 10 cases on every PR with a cheap model; full suite nightly or on prompt changes.
- **Cache aggressively.** Cache model responses keyed by (model, messages, params) for the reference run; re-run only changed cases.
- **Pin the model snapshot.** A floating alias like `gpt-4.1-mini` can change under you, and then your eval measures the provider's release schedule. Where a dated snapshot is available, use it, and treat the upgrade as a change with an eval gate.
- **Store results.** A score without history cannot distinguish a regression from noise. Track per-case pass/fail across commits.
- **Budget the suite.** Compute cost per full run before scheduling it; a 200-case judge suite on a large model is a real line item.

LangSmith's `evaluate()` wraps dataset + target + evaluators and stores results, which is convenient if you already pay for it. The same thing in pytest plus a JSON results file is maybe 80 lines and has no lock-in. Choose based on whether you want the UI, not on capability.

## CI shape

```
tests/unit/          fakes only, no network, < 10 s
tests/contract/      one live call per provider, validates auth + schema, tagged, skippable
evals/               scored suites, nightly, budget-capped
```

Unit tests block merges. Contract tests catch "the provider deprecated our model" and run on a schedule. Evals gate prompt and model changes, and their thresholds are reviewed like any other SLI.

## Common mistakes

- Calling real models in unit tests, then marking them flaky and disabling them.
- Asserting exact generated text.
- One end-to-end score for RAG with no retrieval measurement.
- An LLM judge that was never validated against humans.
- Eval datasets built from the same examples used to iterate on the prompt (you are measuring memorisation).
- No baseline, so "improved" means "different".

## Production notes

Version the dataset with the prompt. Keep a small "canary" set of ten hard cases that must pass before deploy, and a larger set for experiments. Log production failures back into the dataset — every real bad answer is a future regression test, and this loop is the only thing that makes quality improve monotonically instead of oscillating with prompt edits.
