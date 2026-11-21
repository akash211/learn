# PydanticAI, LangChain, and LangGraph: Choosing an Approach

PydanticAI, LangChain and LangGraph all support LLM application development, but they emphasize different abstractions and have evolving feature sets. A useful comparison asks what kind of application you are building, how much control flow you need, how much framework surface you want, and how strongly Python typing should shape your code. Avoid choosing from framework popularity or benchmark claims that do not match your workload.

## Type-first agent construction

PydanticAI centers on typed agents, dependency injection through `RunContext`, function tools and validated output types. It feels natural when a Python service already uses Pydantic models and the workflow can be represented as an agent run with tools and a well-defined result. The types help static analysis and make the input/output boundaries visible. PydanticAI's ecosystem also includes lower-level graph capabilities and integrations, but a simple `Agent` is often the direct path for a bounded workflow.

The main advantage is not that types eliminate model uncertainty. It is that dependencies, tool signatures and outputs can align with normal Python APIs. Tests can replace the model using `TestModel` or `FunctionModel`. A team that values explicit contracts and already uses Pydantic can minimize translation between API DTOs and agent output models.

## Chains, graph workflows, and broader ecosystems

LangChain provides abstractions and integrations for connecting models, prompts, retrievers and tools. LangGraph focuses on stateful graph workflows, with explicit nodes, edges and control flow useful for cycles, persistence, human approval and long-running orchestration. These abstractions may be a better fit when the central problem is a multi-step graph with checkpoints or a broad ecosystem integration requirement.

There is overlap: each framework can orchestrate tools and models, and capabilities shift over time. Do not assume one framework can or cannot do a feature based on a stale comparison. Evaluate the specific version, provider adapters and operational requirements. A custom Python workflow may be clearer than any framework when there are only a few deterministic steps.

## When type-first wins

PydanticAI is a strong candidate when the team works in Python, already uses Pydantic, values precise dependency and result typing, and the agent's control flow is relatively bounded. It can also be attractive when you want to unit test tools and output handling with controlled models without adopting a larger orchestration vocabulary. The types make it easier to see what a function expects and what its caller receives.

Consider LangGraph or an equivalent explicit state-machine approach when durable state, checkpoints, resumability, human interventions and complex branching are core requirements. Consider LangChain when an existing application depends on its integrations and abstractions, or the team has established expertise and tooling. Those are workload fit arguments, not universal rankings. A graph framework can still benefit from typed state; an agent framework can still require explicit persistence and operational design.

## Compare the whole system

Prototype one representative workflow in the leading options. Measure developer clarity, testability, failure handling, observability, provider compatibility, latency and operational burden. Include a failure path, not just the happy path: invalid structured output, tool outage, cancellation, human review, state persistence and version upgrades. Count adapters and custom code needed to bridge your existing services.

Migration cost also matters. A library's model abstraction does not make prompts, histories or tool semantics portable automatically. Keep core business logic in ordinary Python services, separate from framework-specific orchestration where practical. Then a framework change does not require replacing the domain layer.

## Common mistakes

- Treating type annotations as proof the model's answer is true.
- Comparing feature checklists without checking the exact released versions.
- Choosing a graph engine for a simple one-shot call or an agent wrapper for durable workflow state.
- Rewriting domain logic into framework-specific callbacks unnecessarily.
- Assuming provider/model behavior transfers unchanged across libraries.

## Production notes

Choose the smallest abstraction that matches the workflow's lifecycle and state needs. For a bounded typed interaction, PydanticAI's type-first approach can reduce glue and make validation explicit. For durable, human-supervised graphs, use an orchestration design whose persistence and recovery semantics meet the requirement. Framework maturity, licensing, deployment footprint, security posture and team familiarity should be checked in the actual project. Reassess over time; this ecosystem moves quickly.

## A decision framework for comparing libraries

Write down requirements before comparing frameworks: single request or long-running workflow, state persistence, human approval, replay, provider support, existing integrations, type-checking expectations, deployment and team operations. Build a small prototype that includes one realistic failure and recovery path. Compare how clearly each design expresses control flow and how much custom glue it needs. The best choice is usually determined by lifecycle and operational requirements rather than the shortest happy-path example.

PydanticAI's type-first approach can be particularly direct when a workflow is a bounded Python function plus model calls, a few typed tools and a known result schema. It aligns naturally with Pydantic-heavy services and conventional unit testing. LangChain or LangGraph may be more attractive when an existing application already uses their integrations or when explicit graph structure, persistence and checkpointing are central. These are tendencies to test, not hard limitations: capabilities overlap and change.

## Preserve business logic across framework boundaries

Keep authorization, data access, idempotency and domain rules in ordinary services. Framework-specific callbacks should orchestrate those services, not become the only home of core rules. This keeps tests independent of model APIs and gives a migration path if a library's abstractions no longer fit. It also prevents a prompt from quietly becoming the authority for a financial, security or eligibility decision.

If multiple agent frameworks are evaluated, do not duplicate production implementations for long. Define an interface and compare prototypes behind it, or select a clear experiment branch. Record release versions, assumptions and test results. Avoid over-weighting feature checklists: the necessary question is whether the framework supports the application's required semantics with acceptable failure modes and operations.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around PydanticAI, LangChain, LangGraph: Choosing an Approach. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
