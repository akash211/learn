# API Versioning Strategies

An API version is a compatibility promise about observable behavior, not merely a label in a URL. A change can break a client even when the server still parses its request: a renamed field, changed default, narrowed enum, different error status, or altered ordering can invalidate assumptions in production. Versioning provides a way to coordinate incompatible evolution, but every long-lived version adds implementation, testing, and support cost. The better first question is whether the change can be made compatible.

## Define compatibility from the client's perspective

A change is usually compatible when existing valid requests keep working and existing clients can continue interpreting responses correctly. Adding an optional response field is often compatible for tolerant clients, but generated clients with strict deserialization may reject it. Adding a new enum value can break exhaustive switches. Making an optional request field required, changing a field type, changing default sorting, changing the meaning of a status, or removing a field is generally breaking. The actual client ecosystem matters more than a theoretical schema diff.

Keep request and response evolution rules explicit. For input objects, servers can often accept new optional fields and ignore unknown fields when safe; strict rejection can catch typos but may hinder forward compatibility. For output objects, clients should generally tolerate unknown fields, while servers should avoid silently changing the meaning or type of known fields. Never repurpose an existing field to mean something else. If semantics change, add a new field or operation and deprecate the old one with a migration path.

## Common versioning approaches

| Strategy | Example | Strengths | Costs and risks |
|---|---|---|---|
| URI major version | `/v2/orders` | Visible, easy to route, cache, document, and test | Duplicated route surface; query and shared-resource semantics need care |
| Media type / representation version | `Accept: application/vnd.example.v2+json` | Version tied to representation negotiation | Less visible in URLs; tooling and caches must handle `Vary: Accept` correctly |
| Header version | `API-Version: 2025-01-01` | Keeps resource URI stable; can support date-based contracts | Hidden in ordinary links; every client must set it; cache key must include it |
| No explicit major version | additive evolution and deprecation | Lowest permanent surface and simplest consumer path | Requires disciplined compatibility policy and reliable change communication |

There is no universal winner. URI versioning is often easiest for public APIs and humans debugging requests. Header or media type negotiation can keep resource identifiers stable but must be supported throughout caches, logs, gateways, SDKs, and documentation. A date-based version is useful only if the provider actually preserves the behavior associated with each date; a date string without that policy is not versioning.

Choose a granularity intentionally. Version the public contract as a coherent unit rather than independently versioning every field. Avoid putting a version in every resource identifier unless each resource really has a separate lifecycle. A `/v2` API can still return a representation of the same order resource; the version selects a contract view, not necessarily a second order in the domain.

## Prefer compatible evolution

Before declaring a breaking release, consider whether you can add a new optional field, introduce a new endpoint, accept both old and new inputs during migration, or return both values temporarily. Compatibility shims should have a sunset plan; forever-support for deprecated behavior turns a temporary bridge into permanent complexity. Keep changes additive, document defaults, and do not assume “optional” means harmless: optional response data, enum values, media types, and ordering assumptions can all affect clients.

For a genuine breaking change, operate versions side by side long enough for consumers to migrate. Publish migration notes that explain behavior changes and concrete before/after examples. Give clients a way to identify the version they are using and make deprecation visible in documentation and response metadata where appropriate. Announce an end-of-support date that is realistic for the slowest important consumers. If consumers are internal, still coordinate: independently deployed teams have the same compatibility problem as external customers.

## Versioning and deployment

A version boundary should map to explicit request parsing, validation, and response serialization. Avoid scattering `if api_version` conditionals throughout business logic; normalize version-specific requests into a stable internal command and render version-specific responses at the boundary. This lets domain behavior remain shared while old clients see their supported contract. However, if a version changes core business semantics, do not hide the change in serialization alone.

Test old and new versions against the same business invariants. Contract tests should include success, validation, authorization, not-found, concurrency, and pagination behavior—not just the happy-path schema. Run them in CI with fixtures representing real clients. Track traffic by API version and client identity so a deprecation decision is based on observed usage rather than guesswork. Do not log credentials or sensitive payloads to obtain this telemetry.

## Common mistakes

- Treating any addition as automatically non-breaking without checking strict clients and enum handling.
- Calling a breaking change “minor” because the URL stayed the same.
- Creating a new version for every small field addition, multiplying test and support burden.
- Publishing `/v3` but leaving the meaning of its compatibility guarantees undocumented.
- Supporting old versions indefinitely without owners, usage data, or a retirement mechanism.
- Duplicating business logic per version and allowing behavior to drift accidentally.
- Assuming a generated SDK version is the same thing as the server API contract version.

## Production notes

Write a compatibility policy before launch: what changes are allowed without a new major contract, how deprecations are communicated, how long old versions are supported, and how client usage is measured. Automate schema-diff checks but review their output with client behavior in mind. For a new incompatible release, migrate a representative client end to end and verify authentication, errors, retries, and cache behavior as well as data shape. Versioning is a tool for planned change, not a substitute for owning compatibility.

## Deprecation is part of the contract

A deprecation notice is useful only when consumers can act on it. Pair the notice with the replacement operation, a migration example, a date or support window, and a channel for questions. A sunset date should not be introduced silently in a response header or changelog that clients are unlikely to inspect. For a public interface, provide a stable version policy page and notify registered consumers through the channels they opted into. Measure remaining usage with privacy-conscious, low-cardinality telemetry. Never use a caller-supplied version value as a reason to bypass current security policy; old contract versions receive the same authorization and data protection as new ones.

A release checklist should include an explicit compatibility classification, migration instructions, and the name of the team responsible for operating the old contract. That ownership matters after the original authors have moved on.
