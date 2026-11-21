# AI and Agent Nodes

n8n can orchestrate model calls as ordinary workflow steps and can connect AI-oriented nodes to tools and memory components. This makes it useful for retrieval, classification, summarization, extraction and assisted task completion. It does not make a model's output trustworthy simply because the call is represented by a node. Treat prompt inputs as data, validate outputs against a contract, and keep irreversible actions behind explicit controls.

## Calling an LLM API

A direct integration can use the HTTP Request node with a provider's API endpoint, JSON body and authentication configured as a credential. A provider-specific model node may offer a more convenient interface, model selection and output parsing. In both cases, set the model, temperature or other supported generation parameters deliberately, and handle rate limits, timeouts, token limits and provider-specific error responses. API formats change; follow the provider's current documentation rather than copying a stale payload from an example.

Keep system instructions separate from user-controlled content and pass external text as data, not as instructions to the workflow. Prompt injection can appear in emails, web pages, tickets or documents. A prompt that says “ignore instructions” cannot be assumed to neutralize malicious content. Do not provide the model with credentials or unrestricted tools. Use an allowlist of tools and arguments, constrain destinations, validate outputs, and assume that model text can be wrong, malformed or adversarially influenced.

Model output is often probabilistic and may not match the shape a later node expects. Ask for structured output where supported, then parse and validate required fields, types, enum values and length. A parser's successful JSON parse only means syntax is valid, not that a requested action is safe or accurate. Route low-confidence, missing or invalid fields to a retry with a bounded policy or to human review. Keep source references with extracted facts when the task benefits from auditability.

## AI nodes, chains and agents

The exact available node names vary across n8n releases and installed integrations, but common AI components include a model/chat-model node, an AI Agent node, prompt or chain nodes, output parsers, and connectors for vector stores or tools. LangChain-based n8n nodes may expose model, memory and tool ports as distinct connections. Read the node documentation for the exact version before relying on a port or option, since names and behavior have evolved.

A chain is typically a defined sequence: render a prompt, call a model, possibly parse its answer. An agent adds a control loop in which the model can decide whether to invoke one of a set of tools, inspect a result and continue. That flexibility is useful for tasks that need selection among known actions, but it makes execution less predictable. Bound the number of iterations, tool set, runtime and cost; capture tool inputs and outputs safely; and define what happens if the agent stops without a final answer. An agent should not receive broad credentials simply because a tool node can use them.

Memory has a specific meaning in agent frameworks: it can preserve conversation or state across turns. It is not automatically a durable source of truth, a transaction log or a secure authorization system. Define a conversation/session key carefully and consider retention, cross-user isolation and data deletion. A shared memory key or vector index can leak context between users. If the task needs durable business state, store it in an application database with explicit access controls rather than relying on model memory.

## Tool boundaries and human approval

A tool is a capability boundary. A search tool that reads a narrow knowledge base is lower impact than a tool that sends an email, edits CRM records or triggers a payment. Give an agent the smallest available tool set and constrain each tool's parameters. Do not let untrusted model text select an arbitrary URL or query unrestricted systems. For sensitive operations, separate proposal from execution: the model can draft a change, while a deterministic validation node and human approval gate decide whether to apply it.

Human approval should be meaningful. Present the proposed action, its target, the relevant source material and any uncertainty, then require an authenticated approval before the write occurs. Do not treat a model's assertion that a person approved something as approval evidence. Maintain a clear record of which system and user authorized the final action. For simple automations, an explicit workflow branch based on deterministic rules may be safer and cheaper than an agent loop.

## Reliability, evaluation and cost

LLM calls add latency, provider availability and nondeterminism. A retry may produce a different answer and can incur another request charge or duplicate a downstream operation. Retry only the model call or safe stage where possible, and make writes idempotent. Add timeouts and maximum output sizes. Log model name, prompt-template version, request correlation ID, validation outcome and downstream decision where policy permits; avoid storing unnecessary sensitive prompts or responses.

Evaluate representative and adversarial examples before rollout. Test prompt injection, empty context, ambiguous input, malformed structured output, tool errors and provider throttling. Measure task-level outcomes such as extraction accuracy and inappropriate action rate, not only whether the node returned text. Track model and prompt changes as workflow changes. If a provider or model is swapped, re-run evaluations because similar model names do not imply identical behavior.

## Retrieval and data grounding

For retrieval-augmented generation, the workflow typically obtains relevant documents from a search or vector-store component, includes a limited set of passages in model context, and asks for an answer grounded in that material. Retrieval quality depends on source freshness, chunking, metadata filters and query formulation. A model can still invent information or misread retrieved text. Return citations or source IDs that downstream logic can verify, and say when the evidence is insufficient rather than forcing a confident answer.

Treat the index as sensitive data. Apply access filters before retrieval, not only in the prompt, and ensure one user's documents cannot be returned to another user's request. Define how updates and deletions reach the index. Do not assume that deleting a source document automatically removes all of its chunks or embeddings. Evaluate retrieval separately from generation so a missing answer can be traced to missing context rather than blamed on the model alone.

## Common mistakes

- Treating valid JSON as verified facts or authorization.
- Giving an agent broad tools and credentials with no iteration or scope limit.
- Assuming prompt instructions reliably defeat prompt injection in retrieved text.
- Using conversational memory as a secure database or user identity boundary.
- Retrying an agent after it may already have performed a non-idempotent tool action.
- Skipping evaluation when changing model, prompt, retrieval corpus or node version.
