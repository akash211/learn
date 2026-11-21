# Structured Outputs, Validation, and Retries

When a caller needs machine-readable data, declare an `output_type` instead of asking for JSON in a prompt and hoping for the best. PydanticAI supports Pydantic models and other supported Python types, including scalar, collection and union forms. The runtime communicates an output schema through the selected model's structured-output or tool-calling capability, parses the response and validates it. The final typed value is available as `result.output`.

## Encode local invariants in the output type

Use models to express required fields, enums, ranges, and cross-field rules that can be evaluated from the result itself. A `BaseModel` validator is useful for deterministic local invariants; it should not do remote lookups or side effects. Keep the schema as simple as the task allows. Every optional field and nested union increases the work for both model and application, and provider-supported schema features vary.

An output type validates form, not truth. A `sources: list[str]` field can be valid while containing fabricated citations. If the application needs evidence, verify source identifiers against trusted retrieval results. If it needs a confidence policy, define that policy and measure it rather than inventing confidence from a model's fluent prose.

## Validation failures and correction loops

If the model returns output that does not satisfy the contract, validation may trigger a retry/correction interaction so the model can repair its response. Tool argument validation follows a similar loop. A custom output validator can enforce application rules and use `ModelRetry` to tell the model what must change. Retries are not free: each attempt costs tokens, adds latency and may still fail. Set a retry budget and define the exception path when correction is exhausted.

Distinguish schema errors from semantic rejection. A schema error may be correctable by asking the model for a missing or malformed value. A forbidden action, untrusted source or impossible business transition should not be transformed into “try again until accepted.” Application code should decide whether the result is safe to proceed with. Use a human review or explicit error state when uncertainty remains.

## Structured output modes

PydanticAI can use tool-based structured output and, where supported, provider-native structured response modes or other output strategies. The right mode depends on the provider/model API and its feature support. Do not assume the same JSON Schema subset or behavior across vendors. Test the exact provider and model configuration in staging. For union output choices, the runtime may present alternatives separately; handle each resulting Python type explicitly rather than assuming one concrete class.

A refusal or a plain text response also needs a designed outcome. If `str` is among allowed output types, free text may be valid; without it, the agent is expected to produce one of the structured options. Model a refusal explicitly if the caller needs to distinguish it from a normal answer. Avoid treating any parseable object as an approved business decision.

## Separating extraction from action

A safe workflow often has two steps: extract a candidate structured result, then validate it against authoritative application state and policy. For example, an invoice extraction agent can return vendor, date and line items, after which deterministic code checks totals, currency, duplicate identifiers and authorization. The typed object makes this second stage tractable but does not replace it.

Use field descriptions and examples to explain domain meaning, but keep schemas aligned with actual accepted values. If the model often omits a value because it is unknown, represent uncertainty deliberately rather than forcing a fabricated default. Nullable, optional and defaulted values have different semantics; choose the one the consumer needs.

## Common mistakes

- Confusing valid structure with correct facts or an authorized action.
- Using retries as an unbounded repair mechanism.
- Assuming every provider supports the same JSON Schema or native mode.
- Performing network/database I/O from Pydantic validators.
- Silently mapping missing or refused output to plausible-looking defaults.

## Production notes

Capture validation failure category and attempt counts, but redact raw payloads that may contain personal data. Test successful output, malformed output, semantic rejection, refusal, provider errors and retry exhaustion. Bound token usage, elapsed time and tool/model calls. Make the caller's result states explicit so downstream code cannot accidentally treat “could not validate” as “validated empty result.” Validation is a gate in a workflow, not a guarantee of model quality.

## Worked example: extraction with unknown values

Suppose an agent extracts a delivery date, address and order ID from a message. A strict schema can require the order identifier if fulfillment must find a record, but an address may be unknown or ambiguous. Represent that uncertainty intentionally; do not use a plausible default address or tell the model to invent one. The application can look up the order ID in a trusted system, check whether extracted fields agree with the record, and route discrepancies to review. A valid Pydantic object is a candidate interpretation, not proof of the message's contents.

Validators belong where rules are deterministic and local. For instance, a date range can reject an end date before a start date, while a database lookup for whether an order exists belongs in a service. Keeping external I/O out of validation avoids hidden latency and makes retries harder to reason about. If a custom output validator uses `ModelRetry`, give the model a precise, non-sensitive correction message and cap the loop. A rejection based on authorization should not be phrased as an invitation to try another identifier.

## Schema evolution and compatibility

An output model is an internal integration contract between model orchestration and calling code. Changing a required field, union, enum or serialization behavior can affect every downstream caller. Evolve it like an API: add compatibility tests, map old representations deliberately, and distinguish unknown from null or omitted values. If outputs are persisted, include a schema/version strategy so later code can interpret stored records. Do not assume Pydantic serialization in one package version produces exactly the same wire representation forever.

For high-value extraction, evaluate field-level precision and recall, not merely whole-object parse rate. Track which constraints reject outputs and whether the model's correction succeeds. This feedback can indicate that a schema is inappropriate, examples are ambiguous or the provider cannot support the required mode. The fix should preserve the business definition rather than simply making every field optional.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Structured Outputs, Validation, and Retries. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
