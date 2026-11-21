# Interface and Blocks

Gradio turns Python callables into browser interactions. The main design choice is whether the app is a direct function form or a composed interface. `gr.Interface` is an intentionally concise wrapper; `gr.Blocks` is the lower-level composition API used when layout, control flow or multiple callbacks matter. Both use the same component system and can expose callable functions through the app's API.

## Start with Interface when the interaction is one function

`Interface` expresses a mapping from a list of inputs to a list of outputs. Its `fn` is ordinary Python; `inputs` and `outputs` declare how values are collected from the browser and presented. Strings such as `"textbox"` are convenient shorthands, while component instances expose configuration like labels, defaults and choices.

```python
import gradio as gr

def classify(text):
    return {"positive": 0.82, "negative": 0.18}

app = gr.Interface(
    fn=classify,
    inputs=gr.Textbox(lines=3, label="Review"),
    outputs=gr.Label(num_top_classes=2),
    title="Review classifier",
)

if __name__ == "__main__":
    app.launch()
```

The mapping is positional: the browser's values are passed to the function in declared input order, and returned values correspond to outputs. With one input/output, a scalar value is natural; multiple components generally require a tuple/list-like result of matching shape. A mismatch is a programming error surfaced during event execution, not a data conversion policy. Be explicit about `None`, error handling and whether empty submissions are valid.

`Interface` also provides useful demo-oriented conveniences such as examples and description text. These do not replace application-level data governance: examples should be safe to publish, and an uploaded input may contain sensitive material. Treat the interface as a transport and presentation layer, not a trust boundary.

## Blocks is a layout plus an event graph

Inside `with gr.Blocks() as demo:`, component constructors register elements in a layout tree. Layout primitives such as `Row`, `Column`, `Tab`, `Group` and `Accordion` organize the browser view. Components may also be referenced later to bind event listeners. The key mental model is two related structures: the visual layout and the graph of events connecting inputs, Python functions and outputs.

```python
with gr.Blocks() as demo:
    text = gr.Textbox(label="Text")
    result = gr.Textbox(label="Result")
    run = gr.Button("Analyze")
    run.click(fn=classify, inputs=text, outputs=result)
```

Event binding is not ordinary Python invocation. `run.click(...)` registers a callback that will execute after a browser action. `inputs` and `outputs` define the data flow, and the returned component values are serialized back to the page. This separation makes the declaration readable but can obscure control flow if callbacks mutate global variables or depend on implicit ordering. Prefer explicit values and explicit state components.

Blocks can express chains with `.then()`, independent listeners with component events such as `.change()` and `.submit()`, and conditional work through event options such as `trigger_mode`, `concurrency_limit` or cancellation where supported by the installed Gradio version. Check the version's docs when relying on recently added options. Do not assume that a UI event enforces authorization or that hiding a component makes its values trustworthy.

## Organize for the user and for the callback graph

A useful Blocks app makes the workflow legible: collect inputs, show the action, then display results and status. Use tabs when tasks are genuinely distinct, not as a substitute for hierarchy. Give components meaningful labels and descriptions; label quality is especially important for file uploads and advanced model parameters. Separate expensive inference from cheap validation so that an invalid request does not load or invoke a model unnecessarily.

A callback should usually have a narrow job and return the visible results it owns. If the page has a submit button, a status field, and a result panel, make those explicit outputs rather than manipulating the DOM. For dynamic choices, a callback can return an update/configuration value for a component supported by the API, but avoid scattering application state across UI configuration changes.

`gr.ChatInterface` is a higher-level helper for a common conversation pattern. Use it when its turn handling and component options fit. Use Blocks with a `gr.Chatbot` when the app needs custom controls, branching, citations, review actions or a richer conversation layout. Do not choose the lowest-level option by default: abstraction is useful when it removes code without hiding important behavior.

## Launch and separate construction from serving

`demo.launch()` starts Gradio's local server and is useful for development. The returned app object can also be mounted into an ASGI application; launching is not required for every deployment model. Keep expensive model initialization deliberate: module-level loading avoids loading once per request, but can make imports slow and can allocate a GPU model before the process is ready. A startup lifecycle or managed model service may be more appropriate when readiness, warmup, reloads or multiple workers matter.

Guard local launch code with `if __name__ == "__main__":` so importing the module does not unexpectedly bind a port. Keep environment-specific settings—host, port, auth and asset paths—outside the callback logic. A public URL, even a temporary one, changes the threat model: validate inputs, protect secrets and avoid exposing local files.

## Common mistakes

- Returning a dict from a function whose output component expects a plain string, or returning the right values in the wrong order.
- Expecting the Python body of a `with gr.Blocks()` block to run on every click; it builds the app once, while event callbacks run later.
- Using global mutable variables for per-user conversation or workflow state.
- Loading a large model repeatedly inside the callback instead of controlling lifecycle and concurrency.
- Treating a demo's hidden controls, examples or temporary sharing URL as security features.

## Production notes

Start with a single callable and test its input/output contract independently of Gradio. Then bind it to the UI and test serialization with realistic values, including empty inputs and failures. Use Blocks once interactions become multi-step. Keep the UI layer small enough to replace: model logic should remain importable and testable without launching a browser. Gradio's strength is rapid interaction design; clarity in Python boundaries is what keeps that speed from becoming a maintenance problem.

## A small design exercise

Before expanding a prototype, write down the input/output contract in plain Python: what is required, what may be absent, what errors are expected, and what the function returns. Then map each user action to exactly one event and list the components it reads and updates. This simple exercise exposes accidental dependencies, such as a result callback silently reading a global variable or a submit event firing on every keystroke.

For example, a review tool might have an upload event for parsing, a button event for scoring, and a separate button for accepting a result. Each should have a distinct callback and visible status. Avoid hiding consequential actions inside a component change event. This makes it easier to test the model separately, reason about retries, and explain to a user why an operation did or did not run. It also gives you a concrete checklist when changing component types or adding another workflow branch.
