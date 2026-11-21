# Architecture, Participants, and Transports

MCP has two useful architectural views. The first is the logical relationship among a host, its clients, and servers. The second is the separation between a data protocol and the transport that carries it. Keeping these views distinct helps avoid a common mistake: assuming a local subprocess and a remote HTTP service have the same trust boundary just because both speak MCP.

## Host, client, and server

The **host** is the AI application: for example, a desktop assistant, an IDE, or a managed agent platform. It owns the user experience and typically coordinates models, context, and policy. The host creates an **MCP client** for each server it connects to. That client handles protocol communication, discovery, and mapping server capabilities into the host's available context or actions. The **MCP server** is the program that provides resources, prompts, and tools, often by adapting an underlying service.

The client/server relationship is one-to-one for a connection. A host with several integrations may run several MCP clients, each with its own connection and negotiated or configured state. The server is not necessarily a separately hosted machine: it may be a child process on the same laptop, or a service reached over a network. “Server” describes its protocol role, not where it lives.

This separation gives each component an ownership boundary. The host should decide what context reaches the model and what calls need approval. The client should implement protocol and transport behavior correctly. The server should validate arguments, enforce permissions, and call downstream services safely. A server must never rely on the host UI as its only authorization check because clients can be misconfigured, replaced, or bypassed.

## Data layer and transport layer

The MCP data layer uses JSON-RPC semantics: requests have methods and identifiers, responses carry results or errors, and notifications communicate events that do not require a normal response. The protocol defines method names and schemas for discovery and capability use. Many applications should use an SDK rather than manually serialize messages, since framing and lifecycle mistakes can be subtle.

The transport layer moves these messages and defines how a connection or exchange is established. It may also carry transport-specific headers and authentication. The same logical tool call can therefore travel through different transports, but it does not follow that every transport has identical security, lifecycle, or deployment properties.

### stdio for a local process

In stdio transport, the host launches a server process and exchanges protocol messages through its standard input and output. It avoids opening a network listener and can use the operating-system process boundary. It is convenient for desktop applications and developer tools.

The server must reserve stdout for protocol framing. Debug logs, progress text, or Python `print()` output on stdout can corrupt the message stream; send diagnostics to stderr or a structured logging channel supported by the SDK. The host process configuration is security-sensitive: environment variables, executable paths, working directory, inherited files, and arguments can give the child substantial access. A local server is not automatically trusted merely because it is local. Review the binary or package, limit its environment and filesystem access where possible, and avoid putting broad secrets into inherited variables.

stdio servers commonly serve a single client process, but exact lifecycle and process management depend on the host. The host may start and stop the server, restart it after a crash, or keep it alive across conversations. Handle graceful shutdown and ensure transient resources close correctly.

### Streamable HTTP for remote services

Streamable HTTP is the current HTTP transport name in modern MCP revisions. It carries client requests over HTTP and can use streaming responses for server messages or incremental results, according to the specific version's rules. It permits a server to serve many clients, so deployment includes ordinary network concerns: TLS termination, routing, authentication, per-user or per-tenant identity, availability, and rate controls.

Some deployed systems and older clients still use the earlier HTTP+SSE transport. Do not treat HTTP+SSE and Streamable HTTP as interchangeable names or assume a host supports both. The exact endpoints, session behavior, permitted HTTP methods, streaming, and version negotiation depend on protocol revision and SDK. Pin and test the selected combination. A reverse proxy must preserve required methods and streaming behavior rather than buffering or timing out long responses unexpectedly.

Remote transport expands the trust boundary. A reachable URL can invoke capabilities from outside the machine; authentication should identify a principal, and authorization should restrict what it can do. Configure TLS, origin and network controls where relevant, finite timeouts, and careful secret storage. Avoid accepting arbitrary caller-supplied URLs as an excuse to make the server a general-purpose network proxy.

| Property | stdio | Streamable HTTP |
| --- | --- | --- |
| Typical placement | Host launches local subprocess | Separately deployed service |
| Primary boundary | Process, host configuration, local OS | Network identity, TLS, gateway, service |
| Common operational issue | stdout contamination, lifecycle, inherited access | auth, proxy streaming, quotas, availability |
| Scaling model | Often one process per host/client | Shared service can handle multiple clients |

## Lifecycle and version compatibility

Protocol versions have changed the startup and negotiation process. Earlier revisions use an initialization handshake and then a connection lifecycle; newer revisions may use per-request version metadata and different discovery behavior. Server implementations may support one revision or multiple “eras.” Therefore do not hard-code a single lifecycle sequence from memory. Use a compatible SDK and read the corresponding versioned specification. At deployment, make client/server version mismatches diagnosable instead of silently interpreting unsupported messages.

Capabilities are not the same as authorization. Capability negotiation tells the peer which protocol features are implemented or supported; it does not say that the current user may read a particular resource or invoke a particular tool. Likewise, a server listing a tool is not proof that every caller can run it. Apply authorization at the point of action and scope results to the authenticated identity.

## Choosing a transport

Choose stdio if the host can launch and supervise a local process, the server needs access to local context, and per-user deployment is acceptable. Choose remote HTTP if a service needs central operations, shared integration logic, or network-separated deployment. A remote endpoint may simplify updates but concentrates security and availability responsibility. A local process may reduce network complexity but inherits the host's machine and user privileges.

Sometimes a hybrid is appropriate: a local MCP server acts as a narrow bridge to a remote API. In that case, decide whether credentials belong in the local process, an OS credential store, or the remote identity flow, and document the data path. Do not assume that wrapping a remote API in stdio makes the API local or removes its authentication requirements.

## Common mistakes

- Treating MCP client and host as synonyms. The host owns application policy; the client is its protocol connector.
- Sending logs to stdout in stdio mode and corrupting framed messages.
- Choosing the old SSE transport from a stale example without checking client support.
- Equating advertised capability with a grant of user permission.
- Exposing a remote HTTP endpoint without TLS, authentication, and per-operation authorization.

## Production notes

Test transport behavior through the actual host or representative SDK client, not only by calling a handler function. Verify process launch arguments, stderr/stdout separation, shutdown, proxy streaming, headers, auth failure, and timeouts. Monitor transport health separately from downstream API health. Keep a compatibility matrix that records host, client SDK, server SDK, protocol revision, transport, and tested capabilities. This small artifact is often more useful than assuming that “MCP-compatible” means every combination interoperates.