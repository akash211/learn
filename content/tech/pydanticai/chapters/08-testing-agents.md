# Testing Agents with TestModel and FunctionModel

Agent code includes ordinary application logic—dependency handling, tool implementations, validation and error policy—that should be unit tested without paying for or relying on a live model. PydanticAI provides `TestModel` for convenient predictable test behavior and `FunctionModel` for custom scripted model responses. They let tests drive the agent loop while asserting application behavior. They are not quality evaluations and do not demonstrate that a production LLM will make the same choices.

## Replace the model at the boundary

Use `Agent.override(...)` as a context manager to substitute a test model, dependencies or toolsets for a run. It lets production functions that refer to a configured agent run under test without changing their public signature. In current documented patterns, `TestModel` can generate output and exercise tools based on the agent's tool definitions; options can customize output behavior. Consult the installed version when depending on particular helper parameters.

```python
from pydantic_ai import models
from pydantic_ai.models.test import TestModel

models.ALLOW_MODEL_REQUESTS = False

async def test_agent_path():
    with agent.override(model=TestModel()):
        result = await agent.run('summarize this record', deps=fake_deps)
    assert result.output.title
```

Disabling non-test model requests provides a useful guard against accidental network calls in unit tests. Restore or configure global test state appropriately in the test suite. Agent overrides should be scoped so parallel tests do not leak their model or dependencies into one another; follow the concurrency behavior supported by the installed library.

## When FunctionModel is better

`FunctionModel` lets a test define how the fake model responds to each request. It is useful when the scenario needs a specific tool call, a malformed output, an alternate branch, or a multi-step conversation. Script the response parts explicitly and assert both the requested tools and the final result. The test should be deterministic and fail clearly when the code asks for an unexpected model step.

Test output validation by supplying invalid data and checking the correction/retry path, including exhaustion. Test tool arguments that fail schema validation, tool exceptions, authorization denials and provider-like errors. A fake dependency should record calls so a test can establish which tenant or account was used, not merely that the agent returned a plausible answer.

## Unit tests are not evals

A passing fake-model test says the application code handles the modeled interaction. It says nothing about whether a real model will call the right tool, follow nuanced instructions, resist prompt injection or produce useful answers. Use a separate evaluation set for model behavior, representative cases and adversarial inputs. Keep a small controlled integration suite against real provider models where justified; protect credentials and usage budgets.

Golden message snapshots can help detect orchestration changes, but they may be brittle across library versions and may include volatile identifiers or timestamps. Prefer assertions on meaningful behavior: output, tool names, validated arguments, result state and dependency calls. Capture messages when diagnosing a specific interaction, but avoid locking the test to incidental serialization details.

## Test FastAPI integration separately

An HTTP endpoint that calls an agent has two seams: FastAPI request/dependency behavior, and agent orchestration. Replace the application dependency or agent model independently. Exercise the ASGI app using the project's normal test client and check request validation, response shape, mapping of agent failures and any streaming transport. Avoid real model requests in broad CI tests.

Keep test fixtures explicit about resource lifecycle. Fake clients should close if they own resources. For async tests, use the project's configured pytest/AnyIO setup and do not call `run_sync` from the active loop. Make tests assert safety properties, such as that a denied request makes no write-tool call.

## Common mistakes

- Believing `TestModel` proves real-model quality or prompt compliance.
- Letting unit tests make network requests accidentally.
- Asserting every timestamp, UUID or internal message representation in snapshots.
- Testing that a prompt contains a policy instead of testing enforcement in the tool.
- Sharing mutable overrides across concurrently executing tests.

## Production notes

Build a test matrix around both expected and rejected paths: valid output, correction, exhausted retries, tool failure, authorization failure, cancellation, usage/time limits and provider outage. Keep deterministic unit tests fast, then run opt-in integration tests and model evaluations at appropriate boundaries. Record model and dependency versions for evaluations so regressions can be interpreted. The most important test double is still a well-designed fake for your own services; the model mock only controls the probabilistic boundary.

## Test matrix and realistic claims

Start with small tests for domain logic and tool behavior independent of the model. Then add agent-loop tests with `TestModel`, and use `FunctionModel` when the test needs a precise sequence of responses. A matrix can cover: normal structured output, a validation correction, exhausted retry, tool argument rejection, authorization denial, downstream timeout, refusal and cancellation. Assert observable behavior and side effects rather than implementation details that change across library releases.

For each fake-model test, state what it proves. A test that scripts a tool call proves the application dispatches and handles that call; it does not prove a deployed model will choose the tool. Keep a separate evaluation set for that. Evaluation examples should include borderline and adversarial prompts, and comparisons should fix or record the model, prompt, schema and configuration. A changed score may come from any of these variables.

## Isolate test state

Agent overrides and global model-request guards can interact with parallel execution. Configure the guard in a predictable test setup and keep overrides scoped. If the framework uses context-local state, confirm the behavior of your pinned version rather than relying on assumptions. Do not share mutable fakes between concurrently running tests unless they are designed for it. Reset recorded calls and use distinct dependency objects per case.

Message capture can be useful to inspect a surprising request, but snapshots may contain identifiers, timestamps, token metadata or formatting that is not part of the contract. Assert a stable subset such as the requested tool and validated final value. Add exact serialization snapshots only when output format itself is the behavior under test, and update them consciously after upgrades.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Testing Agents with TestModel and FunctionModel. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
