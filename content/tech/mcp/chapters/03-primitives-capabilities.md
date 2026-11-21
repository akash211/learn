# Tools, Resources, Prompts, and Capabilities

The three server primitives describe different ways to provide value to a client. They are not merely labels for three kinds of function. Choosing the right one clarifies user expectations, access control, and how data enters a model interaction.

## Tools: actions with arguments

A tool represents an operation the client can invoke. It has a name, a description, and an input schema; revisions and SDKs may also support output schemas, annotations, structured results, or other metadata. A client discovers tools and can make their definitions available to a model as callable functions. The model may propose an invocation, but the host decides whether to execute it, whether to request approval, and how to present the result.

Tools should model meaningful tasks: `search_incidents`, `get_invoice_status`, or `create_draft_reply` communicates more intent than an opaque `query` or `execute` operation. A tool can have side effects, even if its name sounds harmless. Make read/write behavior clear, validate all arguments server-side, enforce authorization, and consider idempotency for retries. Tool annotations are descriptive hints, not a security boundary; a malicious or misconfigured client can ignore them.

A typical call carries a tool name and structured arguments. The result may contain text, structured content, resource links, or error information depending on protocol version and SDK. The host then decides what to display or send back to a model. Be explicit about whether a “successful” result means an action completed or merely a request was accepted for later processing.

## Resources: addressable context

Resources are data addressed by URIs. They may represent static or changing documents, records, configuration, or other context suitable for a client to read. Resources can have metadata such as a name, description, and MIME type. Some servers provide resource templates when the concrete URI depends on parameters. Clients can list or read resources, and some versions support update notifications or subscriptions.

A resource is not always a file and is not necessarily safe to put directly into a model prompt. It may contain confidential fields, stale data, instructions, HTML, code, or attacker-controlled text. Apply access checks to resource listing and reading, and minimize the content returned. URI parsing must not permit path traversal, cross-tenant reads, or arbitrary network fetches. Be careful about caching: a shared cache must not serve a user-specific result to another principal.

Resources suit explicit retrieval of information. If retrieving the information requires an action, complex arguments, or policy decision, a tool may express that task better. A resource template can make well-defined addressable content discoverable without exposing a general-purpose query interpreter.

## Prompts: reusable interaction templates

Prompts are reusable templates the server offers for a client or user to invoke. They can include arguments and return a structured set of prompt messages or content. For example, a service might provide a “summarize deployment incident” template that includes placeholders for an incident identifier and desired audience.

Prompts are not executable tools and do not force a host to use a particular system instruction. The host decides how to integrate a returned prompt into the conversation and whether it is trusted. A prompt template can nevertheless influence model behavior, so treat its origin and changes as part of the security boundary. Do not put secrets in prompt text, and do not use a prompt as a substitute for server authorization. A prompt that instructs the model to call a privileged tool has no authority to grant that permission.

## Capabilities and discovery

MCP capability exchange lets each side advertise supported protocol features. The exact initialization or discovery flow is version-dependent: legacy revisions commonly use an initialization handshake in which client and server exchange capabilities and then signal readiness; newer revisions may use per-request metadata and a discovery method. Optional features such as resource subscriptions, list-change notifications, roots, sampling, or elicitation are not universally supported. Read the specification and SDK documentation for the pinned version, and do not infer support merely because a server implements a related primitive.

Capability negotiation answers “what protocol behavior is supported?” It does not answer “what should this user be permitted to do?” Authorization is tied to identity, tenant, and operation. A server may expose a read tool only for certain tenants, or filter a resource list per principal. Clients should handle absent optional capabilities gracefully. Servers should avoid advertising unsupported features and should reject unsupported requests predictably.

Discovery is also an evolving detail. In some revisions, clients list primitives through methods such as `tools/list`, `resources/list`, and `prompts/list`. Servers can signal that lists changed if the relevant feature is supported. Pagination may be necessary for large registries. A host should not assume that the first returned page contains every item. Tool names and schemas should be stable enough for the host's model context, and changes should be tested because they can alter downstream behavior.

## Selecting the right primitive

Ask what the user is trying to do. If the operation changes state or requires parameters and a decision, provide a tool. If the user needs to reference or inspect a bounded piece of information, provide a resource. If the workflow benefits from reusable guidance or a parameterized message template, provide a prompt. Some useful integrations offer more than one primitive over the same domain—for example, a database schema resource, a read-only query tool, and a prompt describing common analysis patterns. Keep their permissions and data paths consistent.

Avoid duplicating the same action as both an unconstrained tool and a resource. Avoid turning a resource into a tunnel for arbitrary commands or queries. If there is a legitimate operation that both reads and changes state, model them separately where it helps distinguish permission and user approval. Primitive choice is a contract decision, not just SDK syntax.

## Common mistakes

- Believing a model's tool call is executed automatically by the protocol. The host mediates and may require consent.
- Treating a tool's read-only annotation as enforcement. The implementation and downstream credentials enforce it.
- Assuming resources are trusted instructions. Resource content can be untrusted data.
- Assuming prompts control the model or authorize tools. They are content returned to a host.
- Treating capability metadata as a permission grant or assuming all optional features exist.

## Production notes

Maintain an inventory of primitives with purpose, data classification, side-effect level, required scopes, and owner. Include schema tests to detect accidental compatibility breaks, and authorization tests to prove that listings and reads are scoped. If a capability list changes dynamically, define how the host refreshes it and what stale definitions mean. Keep prompts and resource templates under the same review, versioning, and supply-chain controls as code: both can shape what an agent sees even though neither is an executable function.