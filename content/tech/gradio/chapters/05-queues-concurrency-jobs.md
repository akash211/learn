# Queues, Concurrency and Long-Running Jobs

A Gradio event is a request to run Python work, and several users can trigger that work at once. If every request can enter a GPU model simultaneously, the process can run out of memory or overload a downstream service. Gradio's queue coordinates event execution and browser updates, but it is not a durable distributed job scheduler. Understand what it controls before using it as a production work system.

## Queue events and control concurrency

Queueing is enabled for an app with `demo.queue()`. Event listeners can configure queue behavior, including a concurrency limit in supported Gradio releases. In Gradio 4/5, configuration details and defaults can vary, so set the behavior you require explicitly and consult the version-specific API. A conceptual example:

```python
with gr.Blocks() as demo:
    output = gr.Textbox()
    run = gr.Button("Run")
    run.click(
        fn=run_model,
        inputs=gr.Textbox(),
        outputs=output,
        concurrency_limit=1,
    )

demo.queue()
```

In a real layout, retain the input component reference rather than constructing it inline. The important point is that a per-event concurrency setting caps simultaneous executions of that event in the queue-aware app; it does not impose a GPU-wide limit across other event functions, other applications, or other processes. Multiple listeners that call the same model may need a shared concurrency group or a common inference service so they cannot independently overcommit a resource.

A queue is useful when the work should wait rather than fail immediately, and when browser clients benefit from status updates. It does not make work faster. An overloaded service with arrivals faster than completions accumulates waiting time; queueing simply makes the backlog visible. Decide what users should see when they wait, how long requests remain useful, and whether old jobs should be rejected or superseded.

## Concurrency is about the resource, not the button

Concurrency limits should follow the scarce resource. A CPU-bound Python callback may contend for interpreter time; a native library may release the GIL; a GPU model may be limited by VRAM, batch size, kernel occupancy or model-specific safety; a remote API may impose rate limits. The right cap depends on measured throughput and memory, not a generic rule such as “one worker per core.”

Separate resource classes. A lightweight text validation callback can run concurrently with a slow GPU inference call. Setting one low global concurrency cap can unnecessarily serialize unrelated work. Conversely, giving each event an independent high cap can allow too many simultaneous model calls. Route all work that consumes the same scarce resource through one controlled boundary, or use the serving platform's scheduler.

`batch=True` callbacks in supported patterns can process batches of inputs together, potentially improving accelerator utilization. Batching also changes latency and callback shape: inputs are batched collections and outputs must be aligned batches. It is useful only when the model supports batch inference and the queue can form batches within acceptable wait time. Test corner cases such as different media sizes and a partially filled batch.

## Long-running work and progress

For work lasting seconds or minutes, provide meaningful progress, intermediate output or status. `gr.Progress()` can report stages from a callback; streaming generators can produce partial results. These address different needs. Progress communicates work remaining; streaming shows usable output. Neither makes arbitrary work cancellable or durable.

A browser request is a poor durable job record. The user may close the tab, the process may restart, or a proxy may time out. If jobs must survive disconnects, be resumed, or be audited, create a job record in durable storage, enqueue it in a worker system, and let the Gradio app poll or subscribe to status. Store results in object storage or another durable backend and show a controlled reference. Gradio can be the job submission and inspection UI without being the job queue of record.

For a simpler in-process task, identify cleanup behavior: what happens after exception, timeout or client cancellation? Use `try/finally` for temporary resources. Make retries safe and avoid performing irreversible side effects before validating inputs. If a callback can create a billable external operation, apply rate limits, authorization and idempotency independently of UI queueing.

## Queue capacity and overload policy

Queue length and concurrency are different. Concurrency controls how much work is executing; a queue limit, when supported and configured, controls how much may wait. A long queue can turn overload into stale work and poor latency. Choose an explicit overload response: reject, ask the user to retry, replace an earlier pending request, or persist the task for later processing. The right policy depends on whether each submission is valuable and whether input remains valid over time.

Observe queue wait time separately from service time. High wait with stable processing time means capacity or arrival rate is the issue; high processing time points to model or data-path behavior. Track queue depth, active tasks, failure/cancel counts, GPU memory and time-to-first-result. Avoid logging sensitive prompts or uploaded content merely to troubleshoot throughput.

## Deployment boundaries

The queue belongs to the running Gradio application and its configured process architecture. Do not assume it coordinates independent replicas or survives a deployment restart. If scaling out, know whether requests are sticky, whether each process loads a separate model, and where queued tasks live. A process-local queue can multiply GPU consumption when every worker loads weights. For a single GPU and one model, a single inference process behind a controlled queue may be safer than multiple web workers.

Queue configuration is not a substitute for web-server timeouts or infrastructure capacity. Align reverse-proxy timeouts, Gradio stream behavior, worker lifetime and application limits. Make readiness indicate that required models are loaded, or accept traffic only after a deliberate warm-up. These decisions are deployment-specific; test them under the actual ASGI server, container and accelerator setup.

## Common mistakes

- Assuming `demo.queue()` makes the queue durable or shared between replicas.
- Tuning a listener's concurrency without considering other callbacks that use the same GPU or remote service.
- Increasing concurrency because users wait, when the resource is already saturated and per-request latency will worsen.
- Using an unbounded waiting backlog for requests that become stale or expensive.
- Believing a cancelled browser event necessarily interrupts a native model call or rolls back side effects.

## Production notes

Load-test with realistic model sizes and concurrent users. Record throughput, queue wait, p95/p99 execution time, peak VRAM and failure behavior. Test restart and disconnect scenarios, not only a successful run in a notebook. Use Gradio's queue for interactive coordination where its lifecycle fits; use a task broker and worker service when the application needs durable, cross-process job semantics.

A useful capacity test varies arrival rate as well as concurrency. Run a short burst, a sustained workload and a burst followed by quiet time; observe whether queue depth returns to baseline and whether tail latency degrades gracefully. If every arrival is accepted while completions fall behind, the queue can grow until users abandon the work or the process runs out of memory. Apply a backlog policy and communicate it to the interface. For jobs that can be superseded—for example, repeated previews of a changed slider value—cancel or coalesce stale pending work rather than spending accelerator time on results no user will inspect.
