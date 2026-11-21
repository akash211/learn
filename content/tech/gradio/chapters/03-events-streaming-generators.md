# Events, Streaming and Generators

Gradio's event API registers Python functions that run in response to browser actions. Streaming uses the same callback boundary but yields successive outputs instead of returning one final value. These ideas let a page behave like an application rather than a static form, while making execution order and cancellation more important.

## Bind a callback to a browser event

Components expose event methods such as `.click()`, `.submit()`, `.change()`, `.input()` and specialized events. A listener declares the function, inputs and outputs:

```python
with gr.Blocks() as demo:
    prompt = gr.Textbox()
    answer = gr.Textbox()
    submit = gr.Button("Run")
    submit.click(fn=generate, inputs=prompt, outputs=answer)
```

The binding is registered when the app is constructed; it does not execute `generate` at that point. The browser later sends serialized inputs, the server calls the Python function, and outputs are serialized back. A callback may return a single value or a collection aligned to its output list. Keep that correspondence explicit; returning an output in the wrong slot is a common bug.

Event options allow a listener to participate in a chain (`.then()`), run after success, run even after an earlier event's failure with supported options, or be triggered by user interaction. These options shape a dependency graph, not a transaction. If callback A changes a database and callback B fails, Gradio does not roll back A. Make state-changing steps idempotent where possible and show status at each meaningful boundary.

When a callback returns a new value or component configuration, think about its effect on downstream listeners. A `.change()` event may fire in response to value changes in the page; avoid accidental feedback loops where a callback updates a component that triggers itself repeatedly. Separate automatic reactive updates from explicit submit actions when the work is expensive.

## Yielding progressive output

A Python generator callback can yield intermediate results. This is useful for token-by-token text, progress-aware processing, incremental images or partial results. The browser receives updates as they are produced; it does not make the underlying model faster. It changes perceived latency and allows users to see activity before completion.

```python
def respond(prompt):
    partial = ""
    for token in model_stream(prompt):
        partial += token
        yield partial
```

The yielded object must be valid for the output component. A `Textbox` may display partial text; a `Chatbot` expects a compatible conversation value. Recomputing the entire output on each yield may cost time and bandwidth, so choose a representation and update frequency deliberately. For text generation, accumulate and yield the current string or use a chat handler pattern supported by the installed Gradio version. For more complex data, verify the component's incremental update semantics.

A generator suspends between yields, retaining its local frame and resources. It can hold a model reference, file handle, GPU allocation or upstream connection for the whole stream. Use `try/finally` to release resources and handle client disconnect or cancellation paths where supported. Never assume the generator will always reach its final statement. Avoid unbounded buffering: a stream should yield useful chunks rather than save the entire response and send it at the end.

## Async functions and event callbacks

Gradio supports asynchronous callback patterns, but `async def` does not magically make synchronous model inference nonblocking. An event loop runs other tasks only when the callback awaits an operation that yields control. A blocking CPU call or synchronous network call inside the coroutine can stall the event loop. For I/O-bound libraries, use async clients when appropriate; otherwise move blocking I/O to a thread or a managed worker. CPU-heavy Python work may require a process or external inference service, considering model memory and serialization cost.

Do not assume that streaming and async support are interchangeable. A generator is an output protocol; async execution is a scheduling model. Test the exact callback signature accepted by your installed Gradio version and the component response it produces. A synchronous generator can still yield incremental outputs; async generators require a compatible event handler path. Keep the inference code independently testable so interface integration can be exercised without downloading a model.

## Progress is not the same as streaming

Use `gr.Progress()` or the supported progress callback mechanism to report stages such as loading, preprocessing and inference. Progress indicators communicate completion estimates only if the work can report meaningful progress. They do not send partial model output. Conversely, yielding partial output does not automatically provide a percentage or cancellation policy.

For a multi-stage pipeline, either make one callback report progress and final output, or build a chain with intermediate status components. The former has a simple request boundary; the latter exposes each stage and can make failures easier to diagnose. Avoid pretending a fixed percentage is meaningful for work with unknown duration. Include a clear status for queued, running, completed and failed states when users may wait.

## Failure, cancellation and duplicate submissions

An exception in a callback becomes a failed event, but raw tracebacks should not be the user interface. Log a request identifier and diagnostic details server-side; return a concise, safe message for expected validation and dependency failures. If a user can submit repeatedly, decide whether a new run cancels an old one, queues behind it or runs concurrently. Event options including concurrency controls and cancellation are version-sensitive; consult the installed API before depending on them.

Cancellation is cooperative: a UI request cannot forcibly stop arbitrary Python code or an uninterruptible native inference call. Check cancellation between work units where supported, close upstream streams, and ensure cleanup. For expensive external jobs, use a durable job system with status and cancellation semantics rather than relying on a browser connection as the only record of execution.

## Common mistakes

- Binding a function and expecting it to run while the Blocks layout is being constructed.
- Returning a generator object to a callback that expects a final value, or yielding data incompatible with the output component.
- Blocking an async callback with synchronous I/O and assuming `async` makes it concurrent.
- Loading or buffering all generated output before the first yield, defeating the purpose of streaming.
- Relying on a browser disconnect to stop GPU work and free resources immediately.

## Production notes

Test streams with a slow fake model, a deliberate exception mid-stream and a disconnect/cancel case. Measure time to first useful output and total time separately. Yielding too often can overwhelm transport and rendering; yielding too rarely feels like a hang. The right cadence depends on the model and output representation. Streaming is a product behavior with resource-lifecycle implications, so treat it as part of the concurrency design rather than a cosmetic callback feature.

## Keep event dependencies understandable

An event chain should communicate which result depends on which earlier result. If a workflow has a parse step, a validation step and a model step, either connect them explicitly or combine them in one callback with clear progress reporting. Avoid long chains whose intermediate values are implicit or whose failures leave the page in a confusing partial state. When a downstream listener depends on a value, pass that value through a declared component or state input rather than reaching into a hidden global.

During testing, exercise both the happy path and each failure boundary. Verify what happens when an upstream callback returns no value, a user edits an input while work is running, or a second event arrives before the first finishes. Set event behavior to match intent and document any ordering guarantees you rely on. This discipline reduces race conditions and makes the graph maintainable as the interface grows.
