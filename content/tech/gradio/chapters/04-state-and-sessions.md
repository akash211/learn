# State and Session Handling

A browser interface often needs to remember something between events: the selected model, a conversation, a workflow's intermediate result or a per-user preference. In Gradio, `gr.State` is the built-in mechanism for session-scoped Python values. It is convenient for lightweight interaction state, but it is not a database, a cache with a durable contract, or an authorization mechanism.

## Explicitly thread state through events

A `gr.State` component is created alongside visible components and included in an event's inputs and outputs. The callback receives the current state value and returns the updated value. It is not displayed to the user as a normal widget.

```python
with gr.Blocks() as demo:
    history = gr.State([])
    prompt = gr.Textbox()
    transcript = gr.Chatbot()
    send = gr.Button("Send")

    def reply(message, turns):
        turns = turns + [[message, "response"]]
        return turns, turns

    send.click(reply, inputs=[prompt, history], outputs=[transcript, history])
```

This example deliberately returns a new list rather than mutating the original. Copy-on-update makes the flow easier to reason about and avoids surprises if state values are shared or copied in framework-managed ways. State must be compatible with the framework's serialization/copy lifecycle; keep it to simple, bounded Python data such as strings, numbers, small lists and dictionaries. Verify accepted values for the Gradio version in use.

State is tied to a browser session, not necessarily to a verified human identity. A session identifier is not an account system. Do not place secrets, access tokens, unrestricted database objects or security-sensitive decisions in state and assume they are protected. Authentication, authorization and ownership checks belong in a trusted application layer.

## Session lifetime is not durable persistence

Session state can disappear when a session ends, the server restarts, or deployment topology changes. Its exact lifetime and cleanup behavior depend on the app and environment. It should not be the only copy of user work that must survive a refresh or be audited. Persist such information to an appropriate database or object store with an explicit user identity and access policy.

There is an important deployment consequence: process-local memory belongs to one worker. If a deployment runs multiple workers or replicas, a later request may reach another process unless the serving arrangement preserves affinity. Do not assume a state object is shared across workers or replicated. For durable or cross-worker state, use shared storage and treat Gradio state as the current UI's local working context.

## Keep state small and bounded

Conversation history grows with each turn. A session holding the entire transcript, every uploaded object and every intermediate model tensor can consume substantial memory across many users. Store only what the next callback needs. Keep bulky data in a controlled cache or durable store and store a compact reference where appropriate. Bound chat history by turns or tokens, while preserving any audit trail separately if the product needs it.

Model weights are process-level resources, not per-session state. Load a model through a deliberate service lifecycle and reference it from a controlled inference layer. A per-session copy of a large model wastes memory and can exhaust GPU VRAM. Similarly, open files, generators, sockets and database sessions are poor state values: they have cleanup and concurrency behavior that does not fit a serialized UI session.

## State and concurrency

Two events from one user can overlap. A double-click, a `.change()` event during a long run, or multiple browser tabs may cause callbacks to read or update related values in ways the developer did not expect. A state update is not automatically a transaction or compare-and-swap. Design callbacks to tolerate repeat submissions, and serialize or reject conflicting operations when needed. For external side effects, use idempotency keys or application-level locking rather than relying on the visible button being disabled.

Do not mutate a global list as a shortcut for user state. Multiple users can see cross-talk, and concurrent requests can interleave. Conversely, a `gr.State` value should not be treated as globally shared application state. Store each category of data at the correct scope: module/service scope for an immutable model instance, session scope for lightweight UI progress, and durable storage for records that must survive processes or sessions.

## Initial values, cleanup and reset

A state component may have an initial value and can use lifecycle-related options such as a time-to-live or deletion callback, depending on the version. These features can help cleanup, but do not treat them as guaranteed storage eviction schedules or a substitute for testing. Cleanup callbacks should be safe, quick and idempotent; a process crash can skip them. For important resources, use an external lifecycle manager.

A reset button should clear both visible components and associated state consistently. A user-visible clear action is not necessarily equivalent to deleting server-side records. Make the policy explicit: does it clear only the browser conversation, discard a temporary upload, or delete a persisted artifact? Separate interface reset from data deletion so that users are not misled.

## Common mistakes

- Treating `gr.State` as durable storage or as proof of who the user is.
- Mutating a global list or dictionary to remember the current user's conversation.
- Putting a large tensor, model, open file or entire unbounded history in per-session state.
- Assuming process-local state is shared across multiple workers or replicas.
- Treating a reset click as deletion from a database or object store without explicitly implementing it.

## Production notes

Estimate memory as concurrent sessions multiplied by typical state size, then measure under realistic usage. Test restart, multiple tabs, repeated events and multiple worker configurations. Store durable records with an explicit identity and access-control boundary. Gradio state is best thought of as a convenience for carrying small values from one event to another within an interaction, not as an application data architecture.

## Separate session context from identity

A session value can guide the next screen without proving that the person making the request owns a particular record. For instance, a state field might remember which document the user selected, but the callback must still check that the authenticated principal can read that document. Never accept a state-carried identifier as sufficient evidence for access; validate it against the trusted identity and storage layer each time a protected operation occurs.

This separation is especially important when the interface is shared publicly or mounted alongside other routes. UI state is convenient for presentation continuity; identity and permissions are policy. If a browser can alter a value or replay an event, the server must remain correct. Use opaque identifiers only as references, not as secrets. For data that must be private, perform the authorization check close to the database or artifact retrieval, where every caller path is covered.
