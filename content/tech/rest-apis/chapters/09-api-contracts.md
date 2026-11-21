# OpenAPI Contracts, Validation, and Compatibility

An API contract describes the messages clients can send and the responses they can expect, including status codes, headers, schemas, security, and error behavior. OpenAPI is a language-agnostic format for describing HTTP API surfaces. It enables documentation, validation, test generation, and client tooling, but a valid OpenAPI file does not prove the running service conforms to it. The specification and implementation must be checked against each other continuously.

## Design an OpenAPI description

An OpenAPI document contains metadata, paths and operations, components such as schemas and reusable parameters, servers, and security requirements. Each operation should state method, parameters, request body if any, success responses, meaningful errors, content types, and security requirements. Describe pagination and conditional headers rather than documenting only JSON bodies. Use stable `operationId` values when generators depend on them. Give schemas examples that satisfy constraints and specify whether fields are required, nullable, read-only, or write-only. Be explicit about date-time formats, enum behavior, and unknown fields.

OpenAPI 3.1 aligns its Schema Object closely with JSON Schema 2020-12, which helps express nullable unions and validation constraints. Tool support varies, so pin the spec version and check that linters, generators, gateways, and documentation systems support the features you use. Do not assume an annotation framework's generated output captures runtime behavior. A field declared `format: date-time` is only as strictly validated as the implementation and tooling make it.

Keep one source of truth. Contract-first teams author the description and generate stubs or validators. Code-first teams generate the description from routes and models, then validate it in CI and review material diffs. Both can work. Two independently maintained sources predictably drift. Treat generated files as build outputs or commit them with a defined regeneration check; do not hand-edit a generated artifact and forget to change its source.

## Validation at boundaries

Validate incoming data at the boundary before business logic executes: media type, syntax, required fields, data types, range limits, and cross-field invariants. Apply request size limits before parsing to protect memory and CPU. Normalize only where the API contract says normalization occurs; silently trimming or coercing inputs can produce surprising signatures, identifiers, or money values. Validate output too, especially when multiple code paths construct the same response, but ensure validation failures do not leak internals.

Schema validation alone cannot enforce every domain invariant. “End date after start date” may fit a schema constraint, but “only the invoice owner can approve while status is pending” depends on current state and authorization. Keep these checks in the correct domain layer and report them through a stable error contract. Avoid treating client-side validation as a trust boundary.

## Compatibility checks in CI

A schema-diff tool can flag removed required properties, changed types, narrowed enums, or response-code changes. Review flags against actual client tolerance. Add contract tests that exercise requests and responses against the running application, and consumer-driven tests for high-value clients where appropriate. Generated-client compilation catches some class of changes but not runtime semantic regressions. A successful JSON-schema check cannot prove pagination links work, or that an endpoint respects the documented authorization rules.

For versioned contracts, test old and current descriptions against the service behavior expected for each version. Test malformed requests and representative failures, not only a successful example. Verify that examples remain valid against schemas. Run CI checks before merge and optionally against deployed staging so routing, gateway policy, and application behavior are covered together.

## Security and review

Treat API descriptions as potentially sensitive: internal server URLs, operation names, schemas, and security configuration can reveal architecture. Publish only intended documents and avoid embedding secrets in examples. A security scheme declared in OpenAPI describes how clients authenticate; it does not configure the resource server or enforce access by itself. For each operation, verify the effective security requirement, including deliberately public operations and overrides.

## Common mistakes

- Assuming a generated document is the same as a tested contract.
- Documenting only 200 responses and leaving clients to guess failures.
- Declaring security globally, then forgetting an operation's override or exception.
- Overusing `oneOf` or complex references that client generators cannot handle.
- Relying on `format` metadata for validation without testing the deployed stack.
- Breaking clients with an additive enum value or a changed default.
- Maintaining hand-authored and generated descriptions separately without drift checks.

## Production notes

Pin the OpenAPI version and tooling versions in the repository. Validate syntax, references, operation IDs, and examples in CI; generate SDKs or docs as reproducible outputs. Diff the public description on every change and classify breaking changes before release. Add integration checks that compare actual status, headers, and body to the published contract. Keep an explicit process for deprecations and client feedback. The goal is not maximal schema complexity: it is a precise interface that supports independent client development and makes incompatible changes visible before they reach production.

## Contract governance and consumer reality

A contract has owners. Establish who approves public schema changes, how long deprecations remain supported, and where clients report problems. A linter can enforce consistency such as operation IDs, descriptions, and error responses, but rules should not substitute for review of actual semantics. Avoid a blanket rule that all responses must share one generic schema if the domain has distinct resource types. Reuse common components when they clarify shared behavior; premature schema reuse creates coupling when two fields that once looked alike evolve differently.

Consumer compatibility is broader than the document. Some clients ignore unknown properties; others deserialize into closed structs and fail. Some clients treat empty arrays and omitted fields differently. Test representative generated clients and SDKs for critical consumers, and record the assumptions they make. Use contract tests with sanitized examples that reflect real usage patterns, including old optional inputs and error handling. Do not store personal data from production payloads in test fixtures; anonymize or synthesize valid cases.

The OpenAPI description is also a security review artifact. It reveals operations that deserve authorization checks, input validation, and rate controls. Include response headers such as `ETag`, `Location`, `Retry-After`, and pagination links when clients need them. Document limits as service policy, including maximum payload and page size, and avoid invented universal numbers. If a specification uses external references, pin or review them so a remote change cannot silently alter the meaning of the build. Contract version and document version are distinct: a patch revision to the description may correct documentation without changing the API contract.

For public APIs, publish a human-readable change log alongside the machine-readable description. Consumers need both an exact schema and a concise explanation of why a change matters to their integration.
