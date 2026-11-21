# Async Rust and the Tokio Mental Model

Async Rust supports many concurrent I/O operations without dedicating one operating-system thread to each operation. The key is to separate a future's description of work from the executor that polls it. Async code is not automatically faster or parallel: it is most useful when tasks spend significant time waiting, and it requires every long-running operation to cooperate with the runtime.

## Futures are lazy state machines

An `async fn` returns a `Future`; calling it constructs a value but does not run the function to completion. The executor polls that future. When it reaches an awaited operation that is not ready, it returns control and arranges to be polled again when progress is possible. The compiler transforms async code into a state machine that stores the values needed across each suspension point.

```rust
async fn fetch_label(id: u64) -> Result<String, Error> {
    let row = database_lookup(id).await?;
    Ok(row.label)
}
```

The function advances only when polled. `.await` is not equivalent to starting a new thread; it waits cooperatively, yielding if the future is pending. To run independent futures concurrently, join or spawn them through a runtime API. Sequential awaits remain sequential if the second operation begins only after the first completes.

## Runtime and Tokio

The standard library defines `Future` but does not provide a general-purpose async I/O runtime. Tokio is a widely used runtime offering an executor, timers, networking, task spawning, synchronization primitives, and blocking-work support. A Tokio application commonly uses `#[tokio::main]` to create a runtime and drive an async `main`; libraries should generally expose async functions without creating a runtime internally, so the application can choose and configure one.

Tokio tasks are lightweight relative to OS threads and are scheduled by runtime worker threads. A task may move between worker threads after suspension, so captured state generally must satisfy `Send + 'static` when using multi-threaded `tokio::spawn`. `tokio::task::spawn_local` allows non-`Send` futures on a local task set, with single-threaded constraints. A task needs to yield at await points; an async function that loops doing CPU work without awaiting can monopolize a runtime worker.

## Blocking and CPU-bound work

Never call long synchronous I/O or CPU-intensive code directly on a runtime worker unless its duration is tightly bounded. Blocking a worker prevents unrelated tasks assigned to it from progressing. Use Tokio's blocking pool for bounded blocking operations (`spawn_blocking`) and cap such work; for sustained CPU parallelism, use a dedicated bounded pool or separate service. `tokio::task::block_in_place` has specific runtime constraints and is not a general fix for arbitrary blocking.

Async libraries should preserve async behavior end to end. Wrapping a synchronous database call in an `async fn` does not make the call nonblocking. Avoid holding a synchronous mutex guard across `.await`: that may block a worker or make the future fail `Send` requirements. Tokio provides async-aware synchronization primitives, though a standard mutex can be appropriate for short, non-awaiting critical sections.

## Cancellation, timeouts, and task lifetime

Dropping a future typically cancels that in-progress computation by dropping its state. Cancellation is cooperative at await boundaries and may occur after an operation has partially affected an external system. Therefore, cancellation safety matters: a timeout around a write does not prove the server did not commit it. Use idempotency keys, transaction semantics, or reconciliation for uncertain outcomes.

A spawned task returns a join handle; dropping the handle detaches the task rather than cancelling it. Keep handles or use a task-tracking/shutdown pattern. Use timeouts around external calls and propagate cancellation intentionally. `select!` can race operations, but dropping losing branches has cancellation semantics that must be understood—for example, reading half of a protocol message and then abandoning the read can leave framing state inconsistent.

## Common mistakes

- Assuming `async fn` runs when called, or that `.await` creates a thread.
- Calling blocking SDKs or expensive CPU loops on a runtime worker.
- Spawning unlimited tasks and allowing memory or downstream pressure to grow without bound.
- Holding a synchronous lock across `.await`.
- Treating timeout or cancellation as proof that a remote side effect did not happen.

## Production notes

Model a Tokio service as a set of cooperative tasks, bounded queues, and external resources. Set limits for concurrent requests, database connections, spawned tasks, and blocking work; a runtime's ability to schedule many tasks does not mean a dependency can accept them. Instrument task latency, queue depth, runtime worker saturation, blocking pool usage, and timeout/cancellation counts. Ensure graceful shutdown stops ingress, signals tasks, and waits within a deadline. Keep runtime selection in the binary, and test with the actual runtime flavor and feature set used in deployment. Async improves concurrency for waiting workloads; it does not remove backpressure, error handling, or capacity planning.

## What the Tokio runtime does

An executor polls futures until they return `Poll::Ready` or `Poll::Pending`. A pending future arranges for its waker to be signaled when progress may be possible; the runtime can schedule it again. Tokio combines an executor with asynchronous I/O resources and timers, allowing a small number of worker threads to serve many waiting tasks. This cooperative model depends on code yielding. A long loop without an `.await`, blocking call, or yield can occupy a worker and delay unrelated work.

The compiler lowers an `async` block into a state machine that stores locals needed after each suspension point. A borrow crossing `.await` must remain valid for the suspended state. `Pin` enables APIs to rely on address stability for futures that are not safe to move after polling; ordinary application code usually uses runtime APIs rather than manually constructing pinned futures. Scheduling does not promise that any task runs at an exact time.

Tokio's multithreaded runtime schedules eligible tasks across workers. A future passed to `tokio::spawn` generally needs `Send + 'static`, because it can be polled on another worker and outlive the current stack frame. `spawn_local` supports non-`Send` tasks on a local runtime. A borrowing future can still be awaited directly within its owner; it simply cannot be detached as if it owned borrowed data.

## Concurrency, cancellation, and blocking

Two sequential awaits are sequential when the second future is created only after the first finishes. To overlap independent work, create both futures and use `tokio::join!`, or spawn tasks when separate scheduling and ownership make sense. `join!` polls multiple futures within the current task; it does not create OS threads. `spawn` creates a separately scheduled task and returns a handle that should be observed or supervised.

Dropping a future is a common cancellation mechanism. A timeout or losing `select!` branch can drop an in-progress operation. Local values are safely dropped, but external effects may have occurred: a server may process a request whose response was not observed. Use idempotency keys, transactions, or reconciliation for uncertain writes. Check library cancellation guarantees for partial I/O. Dropping a Tokio `JoinHandle` detaches the task rather than cancelling it, so explicit cancellation and shutdown coordination may be required.

A synchronous operation does not become asynchronous inside an `async fn`. Prefer async-native I/O clients; offload unavoidable blocking calls through a blocking pool, with bounded submissions. CPU-heavy work may need a dedicated bounded pool. Unbounded spawning increases queueing and memory pressure, and retries can amplify a failing dependency. Measure worker saturation, task latency, queue depth, and downstream waits before tuning thread counts. A runtime is a scheduler, not a substitute for backpressure or resource budgets.

