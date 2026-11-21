# Streaming, Partial Output, and Validation

Streaming lets a caller consume model output before the complete agent run finishes. It can improve perceived latency and support interactive user interfaces, but it changes what “output” means at each point in time. A partial JSON fragment is not yet a validated domain object. Applications must distinguish provisional text from a completed, validated result and define how cancellation, errors and client disconnects are handled.

## Stream APIs and their lifecycle

PydanticAI exposes async streaming interfaces such as `agent.run_stream(...)` and event-oriented streaming APIs; precise methods and convenience helpers can evolve, so check the installed version. Streaming commonly uses an async context manager. The caller should keep the context open while consuming the stream so the run, provider response and any tool activity are managed for the intended lifetime.

```python
async with agent.run_stream(prompt, deps=deps) as response:
    async for text in response.stream_text():
        yield text
```

This illustrates text streaming, not a universal guarantee about provider chunk boundaries. Chunks may split words or arrive in uneven sizes. For structured outputs, supported streaming result helpers can expose partial values or validated outputs, but a partial value may be incomplete and should be marked provisional. Do not write each partial object to durable state or trigger an irreversible action before final validation.

## Streaming structured results

Pydantic's partial validation facilities can accept incomplete model data during generation, with some constraints necessarily deferred until completion. Fields may be absent simply because the model has not generated them yet. A consumer should use these values for display or progress only when the UI communicates provisional status. Once the stream completes, consume the final result and enforce all business rules.

Some types or validators cannot be meaningfully evaluated on a partial object. Cross-field checks, totals, and end-of-stream conditions require the whole value. Provider APIs also differ in whether structured data can be streamed in the requested mode. Build a fallback path that waits for the final structured result when partial streaming is unavailable.

## Backpressure and web transports

An agent streaming response can be forwarded through an HTTP streaming response or server-sent events, but the transport is separate from the model. A slow browser can keep an application task and provider stream open. Bound concurrent runs, configure upstream and proxy timeouts, propagate cancellation when the client disconnects, and avoid holding a database transaction for the entire model stream. If events are buffered, bound each queue and define what happens when it fills.

Do not assume that a web response can change its status after headers or body bytes have been sent. A provider error halfway through a stream results in a truncated interaction from the client's perspective. Consider event types for progress, partial content, final content and failure, with request IDs and a clear completion marker. For resumability, the application needs its own persistence and replay semantics; SSE framing alone is not durable delivery.

## Safety and content handling

Partial text is untrusted. Escape it for the target format and avoid executing markup, commands or embedded links while it streams. If output is subject to moderation, policy or confidentiality checks, streaming directly to the user can disclose content before the final check. The design may need buffering, incremental checks, or no streaming for that workflow. A latency optimization should not bypass a safety boundary.

Tool calls can occur within an agent run. A streaming UI should not imply that textual chunks are the whole run or that the model has already finished. Present tool activity carefully and avoid exposing internal tool arguments or results that the user is not authorized to see.

## Common mistakes

- Treating partial structured data as final validated output.
- Assuming chunks align to words, sentences or JSON field boundaries.
- Keeping DB sessions or locks open for the full stream duration.
- Failing to propagate cancellation or bound slow-client queues.
- Streaming sensitive content before moderation or authorization checks.

## Production notes

Test first-token latency, complete-run latency, disconnect behavior, upstream timeout, proxy buffering and provider failure mid-stream. Measure active streams and resource lifetimes. Decide whether a stream is allowed to end with a visible error event or must be buffered until safe completion. Partial validation is a user-experience feature; the final contract remains the fully validated output and application policy.

## Serving a stream without leaking resource scope

A streamed endpoint should distinguish connection lifetime from request computation. Authenticate, authorize and fetch required state before streaming where possible. Do not yield a generator that keeps a transaction or lock open while a user reads slowly. If the agent needs to call tools during generation, those services should have bounded lifetimes and cancellation behavior independent of the browser socket. Use server and reverse-proxy settings that permit streaming and avoid accidental buffering when low latency matters.

Define event semantics. A client should know whether an item is provisional, whether the run completed, and whether an error ended the stream. If the browser disconnects, cancel the work where safe and close the upstream provider response. Add a cap on simultaneous streams and a backpressure strategy; an unbounded in-memory queue turns slow clients into a memory-growth problem. Streaming infrastructure is an end-to-end property involving provider, ASGI server and proxy, not just one method call.

## Validate before irreversible effects

Partial structured output can support a progressive interface—for example, showing extracted fields as they arrive—but label it “draft” until complete. Cross-field validators or business checks may only make sense once all fields have arrived. The caller should wait for final result state before publishing, dispatching a payment or saving a canonical record. If content must be screened, consider buffering or incremental policy checks before disclosure; streaming immediately can release unsafe content irreversibly.

Measure time to first token and full completion separately. Faster first-token delivery can coexist with longer total time, more tokens or slower cancellation. Add integration tests for partial fragments, provider error midstream, slow readers, disconnect and proxy idle timeout. Make the product's promised completion semantics stronger than what a raw stream transport guarantees.

## Operational checklist

Translate this chapter's concepts into acceptance criteria. Decide what input is trusted, what is merely proposed by the model, and where the application rejects or transforms it. Name the owner and lifetime of each client or session. A reviewer should distinguish local validation, domain policy, tool, provider and transport failures, and know what the caller observes.

Write one happy-path test, one invalid-input test, and one failure or cancellation test around Streaming, Partial Output, and Validation. Use a fake dependency to assert behavior, not only generated prose. State what model doubles prove; real-model behavior needs separate evaluation. Include a syntactically valid but semantically unacceptable result, since schema-only tests miss that gap.

Before deployment, set timeouts and resource limits, review logs for sensitive data, and confirm retries cannot duplicate side effects. Track success and rejection outcomes for upgrades. Pin compatible packages and rerun tests when provider integration, output schema, prompt or transport changes. These checks make the contract operational without assuming the framework supplies application policy.
