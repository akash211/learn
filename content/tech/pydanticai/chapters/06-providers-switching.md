# Model Providers and Switching Models

PydanticAI provides a common agent interface over multiple LLM providers. An agent can often use a provider/model identifier such as `provider:model`; the provider integration handles API-specific requests and authentication. Depending on the selected integration, a project may need an optional package extra, credentials, a custom provider or an explicitly constructed model object. Check the current provider documentation and installation instructions rather than assuming every integration is installed with the base package.

## Portable orchestration, non-portable behavior

Because the application owns the same tool functions, dependency types and output contract, changing model selection can require little code change. But portability is not behavioral equivalence. Providers differ in supported tool calling, structured output, streaming, multimodal input, token accounting, rate limits, error shapes and model lifecycle. Even models using a compatible HTTP protocol may disagree in schema support or semantics.

Design an agent around the minimum capabilities it requires. If a workflow depends on constrained output, tool calls or streaming, test those features on each intended model before treating the configuration as interchangeable. Keep a small provider compatibility suite that exercises real API behavior in a controlled environment; unit tests with fake models cannot prove remote feature parity.

## Selection and configuration

Separate provider credentials and endpoints from application source. Use environment-based or secret-store configuration and explicit provider/model identifiers in deployment configuration. Avoid printing credential values or sending keys to the model as instructions. If model selection is dynamic, validate it against an allowlist; never let untrusted prompt text choose an arbitrary endpoint or provider.

A model may be selected at agent construction or at run time through supported parameters. Keep defaults stable and make per-request overrides an intentional policy. For resilience, a fallback model can help with provider failures, but fallback should be applied to transient availability conditions that the application understands. It is not automatically safe to retry a non-idempotent tool workflow on another model or to silently change model quality/cost characteristics.

## Cost, latency and privacy

Model choice is an operational decision: evaluate task quality, latency, context limits, availability, data handling terms, geographic requirements and cost under representative workloads. Capture usage metadata where available and correlate it with request outcomes. Token prices and provider capabilities change, so put current commercial facts in configuration or provider dashboards, not static assumptions in agent logic.

Consider what information is sent to an external provider, including instructions, conversation history and tool results. Minimize and redact sensitive data before the model request. Data residency and retention policies must be assessed per provider and contract. A local or self-hosted endpoint changes hosting responsibility; it does not remove the need for access control, observability and model capability tests.

## Migration playbook

When switching, keep the application contract fixed and test representative prompts, tool choices, edge cases and failures against the new provider. Compare not just whether a happy-path answer parses but whether the agent follows tool policy and returns useful error states. Roll out gradually and monitor retry counts, refusal rates, usage, latency and quality signals. A feature-flagged or staged rollout can make reversal practical.

Provider-specific model settings are often not one-to-one. Generation parameters with similar names may have different ranges or defaults. Avoid scattering provider-specific settings through business code; isolate configuration and document any deliberate behavior difference. For sensitive use cases, require explicit approval before a fallback sends data to a different provider.

## Common mistakes

- Assuming “model agnostic” means identical outputs or feature support.
- Embedding API keys or provider endpoints in source or prompts.
- Falling back without considering privacy, cost, semantics or side effects.
- Testing only with a fake model and assuming production provider compatibility.
- Depending on today's exact model catalog or pricing in long-lived documentation.

## Production notes

Pin dependency ranges and test upgrades in a controlled environment. Track provider/model identifiers, SDK/integration versions and configuration without recording secrets. Use finite request timeouts and provider-aware rate-limit handling; do not create unbounded retry storms. Keep a known-good model route and a rollback mechanism. The common abstraction is useful precisely because it makes the provider boundary explicit, not because it erases that boundary.

## A provider-switch experiment

Before a migration, create a compact test set containing ordinary requests, long context, tool selection, malformed or ambiguous inputs, refusal cases, provider timeouts and output correction. Run the same application contract against each candidate with comparable settings. Record whether expected tools were called, whether the output validates, whether domain checks pass, and how latency and usage change. A fake model remains valuable for fast deterministic tests; it cannot simulate all provider semantics.

A successful change is more than “the code ran.” Check credential discovery, model availability, region and data processing terms, API limits, streaming cancellation and error mapping. Revisit prompt wording where a new model requires different guidance, but keep permission rules out of prompt-only enforcement. Stage the rollout with a measurable rollback condition. A fallback may send data to a different service or produce a different output distribution, so document when it can activate.

## Keep provider settings at the boundary

Isolate provider-specific parameters in one configuration module or deployment settings. Similar parameter names may not have identical meaning or supported ranges. Avoid passing arbitrary model settings from a user request. An allowlisted configuration helps prevent untrusted users from selecting models or endpoints and controlling cost. Redact keys from exception traces and diagnostic dumps.

Treat provider SDK and PydanticAI integration versions as a tested pair. During upgrades, run a smoke test against a low-risk account and make package changes through the lockfile. Record model IDs and integration versions in run telemetry; when something changes, operators need to know which route handled it. Provider abstraction helps manage the change, but visible configuration and compatibility evidence make it safe.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Model Providers and Switching Models. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
