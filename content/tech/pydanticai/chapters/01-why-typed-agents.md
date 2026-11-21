# Why Typed Agents: Contracts Around Uncertain Models

A language model is a probabilistic service, not a Python function with a dependable return type. It may omit a field, misunderstand a request, return a value in an unexpected format, or be unavailable. PydanticAI addresses this mismatch by placing familiar Python types, Pydantic validation, and explicit application code around model interactions. The important promise is not that a model becomes deterministic; it is that an application can define and check the boundaries where uncertain output enters typed code.

## Types as executable boundary contracts

A Python annotation such as `def total(x: int) -> int` helps an editor and static checker, but ordinary Python does not enforce it at runtime. PydanticAI uses types in agent declarations to shape model requests and parse results, and Pydantic validates values at the boundary. When a typed agent returns a `BaseModel`, the application receives an object with the declared fields only after validation succeeds. This is materially stronger than prompting “return JSON” and then trusting `json.loads` output.

```python
from pydantic import BaseModel, Field
from pydantic_ai import Agent

class TicketSummary(BaseModel):
    category: str
    urgency: int = Field(ge=1, le=5)
    needs_human: bool

agent = Agent('provider:model', output_type=TicketSummary)
```

Here `output_type` communicates the result contract to the agent runtime and provides a type for the result. It does not prove the classification is factually correct, fair, or useful. Schema validation checks shape and constraints; domain validation and evaluation address meaning. Those are separate quality layers and production systems need both.

## Three boundaries, three responsibilities

Think about an agent workflow as three contracts. First, the application supplies a prompt and typed dependencies. Second, the model may ask to call a tool, whose arguments are parsed against a schema before Python executes it. Third, a final result is validated against the declared output type. The language model proposes; the runtime validates; the application decides whether the operation is authorized and whether the result can be acted upon.

That last distinction is crucial. A valid tool call such as `delete_account(account_id=42)` can still be unsafe. Validation establishes that `account_id` is an integer, not that the caller owns the account or that deletion is appropriate. Tools should apply ordinary authorization, scope limits, idempotency and confirmation rules. Never turn a model's syntactically valid request into implicit permission.

Pydantic itself is a natural neighbor: its models, constraints, validators and serialization semantics form the data contract PydanticAI uses. FastAPI complements the agent layer at the HTTP boundary; it can validate a request and expose a response while PydanticAI handles model orchestration. Neither replaces domain services or database constraints.

## Why not a prompt-only wrapper?

A hand-written client can call a model and parse the answer. At first it seems simpler. But as soon as the workflow has tool argument schemas, dependency access, output validation, controlled retries, streaming, or deterministic tests, the wrapper begins to reimplement a runtime. PydanticAI makes those concerns explicit through `Agent`, typed dependencies, tools, result types and run APIs. Python's type checker can then follow the dependency and output types through ordinary application code.

The goal is not to build every system as an agent. If a deterministic function solves the problem, call the function. If the task is one simple completion, an agent may be unnecessary. PydanticAI is useful when a model needs constrained outputs or tools, and the application benefits from testable orchestration and explicit contracts.

## The reliability model

“Validated” is narrower than “correct.” A model can choose the wrong category while producing a valid `TicketSummary`. A validator can reject impossible values but cannot establish a source's truth unless the application provides evidence and checks it. Retries may fix formatting, but can also repeat cost and latency or produce a different wrong answer. A production design therefore combines structural validation with domain checks, model evaluation, bounded resource use, observability, and a safe fallback.

Use Pydantic models for stable data shapes, field constraints for local invariants, and deterministic Python for decisions that must not be delegated. Record enough run metadata for diagnosis without logging secrets or unnecessary personal data. Treat prompts, model output and tool arguments as untrusted input even after parsing: escaping, authorization and downstream validation still matter.

## Common mistakes

- Treating a successful parse as proof of factual accuracy.
- Using a model-generated tool call as authorization to perform a sensitive action.
- Putting database or network lookups in model validators instead of explicit application logic.
- Assuming type hints enforce runtime behavior throughout Python.
- Adding an agent to a deterministic task that is simpler and safer as a function.

## Production notes

Start with a small contract and a narrow tool surface. Verify that each provider/model combination supports the output and tool features the workflow needs; provider portability does not mean identical behavior. Test schema failures and provider failures separately, and set timeouts, usage limits and retry budgets. For consequential decisions, route ambiguous or rejected results to a human or deterministic path rather than loosening validation until every answer passes. The strongest typed-agent design preserves uncertainty instead of disguising it.

## Worked design review: decide what the type can guarantee

Imagine a support workflow that receives an inbound request, extracts a category and urgency, and routes it to a queue. A Pydantic model can require the category to be one of an enum and urgency to be within a small range. The agent can return that model, but a deterministic routing function should map its result to a known queue and apply escalation rules. Unknown categories should become an explicit review state rather than a guessed default. Tests can prove that an out-of-range urgency fails and that a valid but unauthorized action is rejected by application code.

This decomposition helps when an interviewer or teammate asks whether “the agent is type-safe.” Clarify the level: a static checker reasons about Python expressions; Pydantic validates values at model boundaries; domain services enforce cross-record rules and permissions; evaluation measures model quality. These guarantees complement one another but do not collapse into a single property. A type checker cannot catch a fabricated fact, and a validator cannot infer a user's permission from a plausible prompt.

## Review questions for a new agent

Before adopting a model, ask what the minimum useful output contract is, which fields can be unknown, and which checks require trusted external state. Identify which functions are exposed as tools and what authority each tool carries. Then specify failure states: invalid output, model timeout, refusal, unavailable tool, and exhausted retry budget. A useful design review requires the path from model proposal to externally visible side effect to be explicit. If that path cannot be drawn, the agent boundary is probably too broad.

For classification or extraction, maintain examples that cover ambiguous and adversarial inputs, not just typical happy paths. Have a human or deterministic fallback for decisions whose error cost is high. Record evaluation outcomes alongside schema acceptance so a change that increases parse success while reducing accuracy does not look like an improvement. The schema is the contract on shape; the test and policy suite defines what that shape means in the product.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Why Typed Agents: Contracts Around Uncertain Models. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
