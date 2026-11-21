# Observability and Evaluation of Trajectories

A final answer alone is not enough to understand a multi-step agent. Two runs can return similar prose while taking very different paths: one used current sources and stopped; another called the wrong tool, retried several times, and reached the same text by accident. For a LangGraph workflow, observe the trajectory—the nodes executed, routes chosen, model and tool calls, errors, state updates, and final outcome. This makes failures diagnosable and provides material for systematic evaluation.

LangSmith integrates with LangChain and LangGraph tracing. With tracing configured, graph execution can be inspected as nested runs, including node-level boundaries and model/tool calls where integrations emit them. A common configuration uses environment variables such as `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, and `LANGSMITH_PROJECT`; follow current LangSmith documentation and your organization's deployment settings. Treat traces as sensitive: they may contain user prompts, model outputs, retrieved documents, tool arguments, and identifiers.

Observability is more than enabling traces. A good operational view connects the graph run to a business request with a correlation ID, records the workflow and schema version, and summarizes outcome, duration, route, error class, and bounded resource usage. Keep high-cardinality identifiers out of metric labels; put them in access-controlled traces or logs instead. Decide what is redacted, who can inspect traces, how long they persist, and how deletion requests propagate.

## Evaluate the path and the result

Evaluation asks whether the application does the intended task on representative inputs. Separate dimensions so a single score does not hide weaknesses:

- **Outcome quality:** Is the final response correct, useful, grounded, and appropriately qualified?
- **Control flow:** Did it choose the intended branch, terminate within budget, and avoid a forbidden tool?
- **Evidence:** Were claims supported by the expected sources, with provenance retained?
- **Tool behavior:** Were calls valid, authorized, and limited to necessary operations?
- **Operations:** Did it complete within service deadlines and recover safely from expected failures?

A dataset should include ordinary requests, edge cases, ambiguous inputs, adversarial or malformed content, and known failure situations. For each example, define expected behavior, not just an exact string. A deterministic evaluator can check routes, required citations, schema shape, and maximum tool calls. A model-based evaluator can judge semantic qualities but should be calibrated against human review and should not be the only safety test. Evaluate on held-out cases as well as examples used while tuning prompts or routers.

LangSmith supports datasets, experiment runs, and evaluators for tracing and comparing application versions. The exact evaluator setup depends on the LangSmith APIs and libraries in use; the general practice is to associate a versioned dataset with a runnable graph, record traces, and compare results across changes. Avoid cherry-picking a few successful traces. A change that improves a mean quality score may still increase unsafe routes or tail latency, so retain per-case outcomes and safety checks.

## Inspecting trajectories

When debugging a run, reconstruct its sequence: initial input, state updates, branch selection, calls and their return values, any retries, and terminal state. Find the earliest divergence from expected behavior. For example, if the final answer is unsupported, the root may be a retrieval node that returned no documents, a router that bypassed retrieval, or a synthesis node that ignored evidence. Changing the final prompt without identifying that divergence may make one case look better while leaving the actual cause.

Use streaming when a caller needs progress updates, but consider which event types and state fields it exposes. Streaming node updates can reveal internal work before the final response. Do not send raw internal reasoning or private data to end users by default. A progress UI can report safe statuses such as “searching sources” or “waiting for approval” without exposing the full prompt or tool payload.

Trace sampling can control volume in high-throughput systems, but keep enough coverage to diagnose rare failures. Sample deliberately by environment, workflow version, or error condition; preserve full traces for controlled evaluation where consent and data policy permit. Trace retention should be explicit, and trace content should not be copied into analytics without review.

## Evaluation loop

A useful improvement loop is: collect representative failures, classify root causes, add or update tests, change one workflow behavior, compare versions, and verify no protected dimension regressed. Keep application code, graph topology, prompt templates, tool schema, and evaluation dataset revisions identifiable. When an evaluation fails, save the trace or a redacted reproduction so it can be reviewed without relying on a human's memory of the incident.

For non-deterministic model calls, repeat runs when variance matters and report the distribution or per-case outcomes rather than one lucky result. Use fake models or deterministic nodes for graph topology tests. Use provider-backed tests for integration behavior, and curated evaluation cases for quality. No single technique establishes that a workflow is reliable across arbitrary inputs.

## Example: testing a route separately from answer quality

Keep routing tests deterministic and small; evaluate generated content separately. A unit test can assert that a source-seeking question selects retrieval, while a dataset evaluator checks whether the final answer cites evidence correctly. This avoids asking a semantic judge to detect a simple routing regression.

```python
def test_source_question_uses_retrieval():
    state = {
        "question": "Find sources for this claim",
        "intent": "needs_sources",
        "result": "",
    }
    assert route(state) == "retrieve"

# In an evaluation run, capture the graph output and inspect the trace for:
# - selected route and executed nodes
# - retrieval result IDs and citation coverage
# - tool/model error events and total call count
# - final answer quality and whether it abstains when evidence is absent
```

This example does not claim to demonstrate a complete LangSmith SDK invocation; it shows the testing split. Use the documented tracing and evaluation API versions selected by the application. Keep evaluators explicit about acceptable answers and failures, and manually review examples where evaluator confidence is low.

## Common mistakes

- **Scoring only the final string.** Inspect routes, tools, evidence, retries, and termination as well.
- **Using an LLM judge as ground truth.** Calibrate and audit it with human-reviewed cases.
- **Logging everything indefinitely.** Traces can contain secrets and personal information.
- **Changing prompts and datasets together without versioning.** You cannot attribute the result.
- **Testing only the happy path.** Include timeouts, malformed tool output, missing evidence, and budget exhaustion.

## Production notes

Define a minimal trace schema and a clear retention policy before broad rollout. Alert on operational signals such as error rate, stuck/pending thread age, and unexpected tool-call volume; use evaluation results to detect quality regressions that infrastructure metrics cannot see. Store prompt, graph, and tool versions with run metadata. Maintain a compact gold set for fast changes and a broader regression set for release evaluation. Observability helps identify behavior; only a disciplined evaluation process can tell whether a change improved it. Review tail cases and failures individually.
