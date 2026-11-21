# Production: Deployment, Concurrency, and Versioning

A graph that works in a notebook is not yet a production workflow. Production readiness depends on how it is invoked, how state is stored, how concurrent requests are isolated, what happens when deployments change, and how errors and resource use are managed. LangGraph provides execution and persistence primitives, but service-level concerns—authentication, authorization, rate limiting, data retention, incident response, and deployment topology—remain the application's responsibility.

## Deployment and durability

Compile the graph during application initialization with the configured nodes, tools, and checkpointer. Avoid rebuilding mutable graph definitions per request unless there is a clear reason; process-level reuse makes configuration and testing easier. Separate graph construction from dependency configuration so tests can inject fake models, tools, and savers. Keep secrets in a secret manager or environment-specific configuration, never in graph state or user-visible traces.

Select a checkpointer based on persistence guarantees and operational constraints. An in-memory saver is not a durable production store. A database-backed saver requires connection management, schema initialization or migrations as documented, backups, access controls, and capacity monitoring. When a hosted agent runtime supplies persistence and execution infrastructure, use its supported operational model rather than assuming all local APIs map identically to the service.

Treat each `thread_id` as a key into state. Authenticate the caller and authorize access to the thread on every operation. Generate IDs with sufficient uniqueness and bounded length. Do not let two unrelated tenants collide in a namespace. A user should not be able to read, resume, or fork a thread simply by guessing its identifier. Store business ownership and lifecycle metadata in an application layer where access policy can be enforced.

## Concurrency and shared state

Multiple requests may execute at once, and the same thread may receive competing updates. Define how requests for one thread are serialized or rejected. A checkpointer persists checkpoints, but it does not eliminate application-level races between simultaneous clients. If two users submit separate inputs to the same conversation at once, decide whether the service queues them, uses optimistic concurrency, or returns a conflict. Do not assume a last-write-wins state field will preserve both independent updates.

Parallel nodes within one graph super-step have their own merge semantics. Reducers should be safe for concurrent writes, and downstream nodes should not depend on incidental completion order. Limit concurrency for tools and providers, and apply backpressure at service boundaries. A large fan-out can otherwise create a burst of requests even when each individual graph run appears small. Bound per-run workers and aggregate results by stable IDs.

Use explicit request deadlines and cancellation. A model or tool node that waits indefinitely can occupy worker capacity and leave a thread in an ambiguous status. Keep retry backoff within the caller's deadline. For long-running workflows, consider an asynchronous job model: return a job or thread reference, process work in a background worker, persist progress, and expose polling or notifications. Do not hold an HTTP connection open for a human approval that may take hours.

## State size, privacy, and retention

Every checkpoint stores some form of graph state and execution metadata. Large message histories, full documents, image payloads, or raw API responses can make persistence and trace storage expensive and slow to inspect. Store references to large durable objects where appropriate, and keep only the minimum context needed to continue. Summarize or prune conversation history deliberately, preserving the facts and provenance that future nodes need.

State and traces can contain sensitive data. Define encryption, access controls, tenant isolation, retention windows, deletion workflows, and backup policy. Removing a user record from the primary database may not remove copies in checkpoint stores or trace systems unless the application explicitly coordinates deletion. Minimize data before persistence; retention policy is easier when state was small from the beginning.

## Versioning and active threads

Graph topology, node names, state keys, reducer behavior, prompts, model choices, and tool schemas can all change. Active threads may be paused between steps and later resumed using newer code. Additive schema changes are generally easier than renaming or changing the meaning of existing fields. A paused thread may be about to execute a node by its saved name, so removing or renaming that node can break resumption. A value that used to mean “draft” may be misinterpreted if the new code gives it a different meaning.

Use backward-compatible changes where possible: add optional fields with defaults, keep existing nodes available during a migration window, and make new code understand old state. If a breaking change is required, identify affected threads and choose a migration, version-pinned resume, explicit restart, or manual resolution strategy. Store a graph or workflow version in application metadata and in state when useful, then route old threads to compatible logic. Do not assume that a newly deployed graph automatically upgrades every checkpoint safely.

Prompt and tool changes also affect business behavior even when the Python state schema is unchanged. Record prompt version, model identifier or deployment, tool manifest version, and policy version with each run. Use feature flags or canary cohorts to compare behavior before changing all traffic. Keep a rollback path that accounts for state already written by the new code.

## Example invocation and limits

A production-facing invocation should carry a stable thread identifier and explicit run limits appropriate to the workflow. The following fragment illustrates the config shape; durable storage and API-level authorization are intentionally left to the service configuration.

```python
config = {
    "configurable": {"thread_id": authorized_thread_id},
    "recursion_limit": 40,
}

result = graph.invoke(
    {"question": validated_question},
    config=config,
)
```

The recursion limit is a runtime guard on graph super-steps. The chosen value is illustrative, not a recommended universal number; set it from the intended topology and test the exhausted behavior. Also implement a task-specific loop budget, tool-call limit, deadline, and provider quota if the use case needs them. Put `thread_id` under `configurable`; do not put `recursion_limit` there. The HTTP service still must verify that `authorized_thread_id` belongs to the authenticated caller.

## Operational failure handling

Classify failures at the service boundary: invalid input, unauthorized action, transient provider error, checkpointer unavailable, recursion limit, tool failure, and human approval pending are different outcomes. Return stable client responses without leaking stack traces. A checkpointer outage may prevent safe continuation and may require backpressure; silently running without persistence would violate the workflow's contract. Retry the operation only when its side effects and checkpoint semantics are understood.

Create dashboards for active and pending threads, checkpoint storage, error categories, model/tool call counts, and latency distributions. Establish alerts for aged interrupts, rapidly growing state, checkpoint failures, and abnormal loop counts. Build runbooks to inspect a thread safely and resume or cancel it through authorized paths. Backups and restore tests matter: a database that has never been restored is not a proven recovery plan.

## Common mistakes

- **Assuming checkpoints provide exactly-once effects.** They store graph state, not distributed transactions with external APIs.
- **Allowing concurrent inputs to race on a single thread.** Define ordering, locking, or conflict behavior.
- **Persisting full payloads indefinitely.** Limit state and implement retention and deletion across stores and traces.
- **Renaming a node while paused runs depend on it.** Keep compatibility or migrate those threads deliberately.
- **Treating a recursion limit as a complete resource budget.** Add deadlines, model/tool budgets, and service-level concurrency controls.

## Production checklist

Before launch, confirm the graph compiles with production dependencies, checkpointer setup and restore have been exercised, thread authorization is enforced, and state size and retention have been reviewed. Test simultaneous requests, worker restarts, provider timeouts, interrupt resumption, stale approvals, and a deployment with old paused threads. Verify idempotency for every external effect. Pin library versions, monitor changes in current LangGraph APIs, and evaluate graph behavior on a versioned dataset before rollout. Production reliability comes from these explicit contracts around the graph, not from the fact that it compiled successfully.
