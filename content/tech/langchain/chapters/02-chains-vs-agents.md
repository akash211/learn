# Chains, Agents, and What LCEL Actually Buys You

"Chain" and "agent" get used interchangeably in tutorials and mean opposite things. A chain is control flow you wrote down: the model is called at fixed points, in a fixed order. An agent is control flow the model decides: it chooses which tool to call, how many times, and when to stop. Almost every production incident that gets blamed on "the agent" is really a chain with a loop nobody bounded, or a chain that should have been twenty lines of Python.

## The distinction that matters

| | Chain | Agent |
|---|---|---|
| Who decides the next step | Your code | The model, per turn |
| Number of model calls | Known in advance | Unknown, bounded only by your limit |
| Failure surface | Prompt, retrieval, parsing | All of that plus tool choice and loop control |
| Cost per request | Predictable | Variable, sometimes wildly |
| Testability | Deterministic with fakes | Requires trajectory-level evaluation |
| Right tool | Repeatable pipelines | Open-ended tasks over tools |

A support-ticket classifier is a chain. "Find the customer's order, check whether it shipped, and if not, refund it" is an agent, because the second step depends on what the first returned and the third is conditional on business data.

## What LCEL buys

LCEL — the `prompt | model | parser` style — is not a DSL for intelligence. It is a composition layer with four concrete properties:

1. **One implementation, four execution modes.** The same object supports `invoke`, `batch`, `stream`, `ainvoke`, `abatch`, `astream`. Without it, teams write the sync path, then a separate streaming path in the web handler, then discover the async path is subtly different.
2. **Config propagation.** Callbacks, tags, metadata, `run_name`, recursion limits and concurrency limits flow into every nested step. That is the mechanism behind tracing, per-tenant cost attribution, and token callbacks.
3. **Structural parallelism** through `RunnableParallel`, and bounded concurrency through `batch(..., config={"max_concurrency": n})`.
4. **Composability of policy.** `with_retry`, `with_fallbacks`, `with_config`, `with_listeners` wrap a runnable without editing it, so retry policy can differ between the interactive path and the batch path.

What it does not buy: type safety, cycles, durable state, human approval, or cheaper debugging. All four are commonly assumed and none are delivered.

## Writing the same pipeline three ways

```python
# 1. LCEL
summarise = prompt | model | StrOutputParser()
summary = summarise.invoke({"text": doc})

# 2. Plain Python against the same objects
messages = prompt.format_messages(text=doc)
reply = model.invoke(messages)
summary = reply.content

# 3. Plain Python against the provider SDK
summary = client.chat.completions.create(
    model="gpt-4.1-mini",
    messages=[{"role": "user", "content": build_prompt(doc)}],
).choices[0].message.content
```

Version 2 is the underrated option. It keeps the LangChain model adapter and prompt template — the parts with real value — while removing the composition layer from the debugging path. If a pipeline has one or two steps and never streams, version 2 is usually better engineering than version 1, and it is a five-minute refactor in either direction.

Version 1 earns its keep when the pipeline has parallel branches, must stream, must be traced, or must be swapped between providers per environment.

## Branching without an agent

Most "we need an agent" requirements are a router plus a few chains:

```python
from langchain_core.runnables import RunnableBranch, RunnableLambda

route = RunnableLambda(lambda x: x["kind"])          # cheap, decide in code or with a classifier call

pipeline = route | RunnableBranch(
    (lambda k: k == "invoice", invoice_chain),
    (lambda k: k == "contract", contract_chain),
    default_chain,
)
```

This is deterministic, testable with fakes, and has a bounded cost. The catch: `RunnableBranch` does not catch exceptions, so a failing branch propagates and kills the run. If you want per-branch fallbacks, wrap each branch in `.with_fallbacks([...])` rather than the branch itself.

The other catch is subtler: `RunnableBranch` takes the *first* matching condition, evaluates conditions in order, and passes the original input to the selected branch. People write conditions expecting the output of the previous step and get the whole dict instead.

## Agents, honestly

The old interface was `create_react_agent` plus `AgentExecutor` — a prompt, a scratchpad, and a loop with `max_iterations`. It worked, it was hard to bound, and in current versions it lives in `langchain-classic`. LangChain v1's `create_agent` is a thin wrapper over a LangGraph graph: you give it a model, a list of tools and optionally a system prompt and middleware, and it returns something you invoke with `{"messages": [...]}`.

```python
from langchain.agents import create_agent

agent = create_agent(model=model, tools=[lookup_order, issue_refund])
result = agent.invoke(
    {"messages": [("user", "Refund order A-1042 if it never shipped")]},
    config={"recursion_limit": 12},
)
```

The pieces that actually determine whether this behaves are not in that snippet:

- **Tool descriptions are the prompt.** A vague docstring produces wrong tool selection, and no amount of `temperature=0` fixes it.
- **The loop needs a budget.** `recursion_limit` is a counter, not a cost limit. Bound tokens, wall-clock time and tool-call count separately.
- **Tool errors must be returned, not raised.** A raised exception aborts the run; a returned error string lets the model recover. Both are legitimate policies, but pick deliberately.
- **State is a message list.** Everything the agent "remembers" is in that list, and it grows every turn. Long agent runs hit the context limit before they hit their step limit.

For anything with approval gates, retries, or a need to resume after a crash, use LangGraph directly. The agent wrapper is convenient precisely because it hides the graph — which is the wrong trade when you need to inspect it.

## Cost and latency arithmetic

A three-step LCEL chain makes three sequential round trips. At 800 ms per call that is 2.4 s before any parsing. Two of those steps are often independent — entity extraction and query rewriting rarely need each other — and `RunnableParallel` turns 2.4 s into 1.6 s. Agents invert this: latency scales with the number of turns the model chooses, so p95 latency is a property of your prompt quality, not your infrastructure.

## Common mistakes

- Calling a fixed pipeline an "agent" and then adding autonomy to justify the label.
- Using an agent for classification, extraction, or summarisation, where one call suffices.
- Assuming `with_fallbacks` catches errors from inside a tool. It wraps the runnable it is attached to.
- Leaving `max_iterations` / `recursion_limit` at the default and discovering the cost in production.
- Building the whole application as one LCEL chain, then being unable to add a retry for a single step.

## Production notes

Decide the control-flow model before writing prompts: fixed pipeline, router, or agent loop. Record that decision in the code, because it determines what tests are possible. Chains should be tested with fake models and golden prompts; agents need trajectory evaluation and a hard budget. If a chain needs a conditional that depends on a prior model output, that is a router, not a reason to hand control to the model. And keep an exit path: if prompts, parsing and retry policy live in your own functions, swapping LangChain out later is an afternoon, not a quarter.
