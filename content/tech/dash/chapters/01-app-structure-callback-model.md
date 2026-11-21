# App Structure and the Callback Model

Dash apps are declarative at the UI boundary and ordinary Python at the computation boundary. A layout creates the initial component tree; callbacks connect component properties into a dependency graph. The browser displays components and captures user events, while the server evaluates Python callbacks and sends changed property values back. This chapter builds a mental model that scales beyond a first chart.

## The smallest useful application

```python
from dash import Dash, Input, Output, dcc, html

app = Dash(__name__)
app.layout = html.Div([
    dcc.Dropdown(id="metric", options=["sales", "orders"], value="sales"),
    html.Div(id="summary"),
])

@app.callback(Output("summary", "children"), Input("metric", "value"))
def show_summary(metric):
    return f"Selected metric: {metric}"

if __name__ == "__main__":
    app.run(debug=True)
```

A component is a Python object that serializes into a browser-side component with named properties. `id` identifies a component in the callback graph; `value`, `children`, `figure`, `disabled`, and `style` are examples of properties. The app object registers routes and callback metadata. `app.layout` supplies the page tree. The `if __name__` guard matters when workers import the module: importing should construct the app, not start a development server.

`app.run(debug=True)` is for local development, not production. Debug mode enables a reloader and developer diagnostics; use a WSGI server such as Gunicorn for deployment. Keep app construction in an importable module and separate data access, transformations, and presentation into ordinary functions. A common layout is `app.py` for creation and server exposure, `layout.py` or page modules for component trees, `callbacks/` for registrations, and `services/` for domain logic. That is a convention, not a framework requirement.

## Components and properties are the API

Dash's core components include `dcc.Dropdown`, `dcc.DatePickerRange`, `dcc.Store`, `dcc.Graph`, `dcc.Location`, and `dcc.Upload`; HTML-like tags live in `dash.html`. A callback does not receive a DOM node. It receives the values of declared properties and returns values for declared output properties. The component library validates property names and types, and the browser performs rendering.

Treat component IDs as stable identifiers, not visible labels. In a small app a string is convenient. In a reusable component or generated list, a structured dictionary ID supports pattern matching, covered later. Avoid duplicate IDs in the rendered component tree unless deliberately using pattern-matching IDs. IDs are part of the callback contract; changing one can disconnect callbacks.

The browser/server boundary has practical consequences. Python callback code cannot directly inspect browser DOM state unless that state is represented by component properties or explicitly sent to a clientside callback. Large data values returned to the browser consume serialization and network resources. Conversely, browser input is untrusted: validate it before using it in SQL, file paths, authorization decisions, or costly calculations.

## The callback graph

A callback is declared with one or more `Output` dependencies and `Input` dependencies. Dash records the graph and triggers the function when an input property's value changes. If callback A writes a property that callback B reads, Dash can schedule B after A. The graph is explicit and helps the framework understand which updates can be computed; it is not a general-purpose Python event bus.

```python
from dash import callback, Input, Output

@callback(Output("result", "children"), Input("search", "value"))
def render_result(query):
    return lookup_and_format(query)
```

`@app.callback` and the module-level `@callback` are both real APIs. The module-level form is handy for pages, while `app.callback` makes the owning app explicit. Callback functions should be deterministic with respect to their declared arguments and external state. Avoid depending on mutable module globals for per-user selections: in a multi-worker deployment, workers do not share memory reliably, and users can interfere with each other.

When the user changes an input, the browser sends a request containing the changed values required by the dependency. The server invokes the Python function and responds with output properties. Dash handles the callback transport; you generally do not write these requests yourself. This request/response cycle means a callback can have network latency and multiple users can execute callbacks concurrently. Keep UI callbacks short or move long work to a background mechanism.

## Layouts and import order

A static layout is a component tree assigned directly to `app.layout`. A callable layout can create a fresh tree per page request, useful for request-aware structure, but must remain cheap and should not be mistaken for a secure authorization boundary. The app's callback definitions should be registered during application startup, before requests use the app. Avoid conditional callback registration based on a user's current selection: the graph is application configuration, not per-request state.

Keep presentation composition separate from expensive data loading. Importing the app should not query an entire warehouse or perform a long API call. If a layout needs options from a source, load only a small, bounded set or retrieve it through a callback. Long import times delay every worker start and can cause deployment failures.

## Common mistakes

- Returning a Python object that is not serializable as the target property expects.
- Reusing one fixed ID for every item in a repeated component list.
- Treating a callback as a local function call that runs in the browser.
- Putting user-specific state in a global variable and assuming workers share it safely.
- Starting the development server at import time, so each worker or test starts another server.
- Placing costly database or network work in module import or layout construction.

## Production notes

The callback graph is also a design tool. Draw the data path: controls provide query parameters, domain functions retrieve and transform data, and outputs update presentation properties. If two outputs need the same expensive result, factor the shared operation into a service and consider caching rather than duplicating the work. Keep callbacks thin, with validation and error handling at the boundaries and testable business logic outside the decorator.

Run the app locally with debug mode only during development; test the deployed WSGI configuration separately. Use `app.run()` as a development entry point and expose the Dash/Flask server object to the production process manager. Pin compatible Dash and component-library versions, because component packages evolve independently. At startup, log the app version and configuration, but never log secrets or full sensitive callback payloads.

## A practical callback boundary

A useful way to review a callback is to ask what belongs at each boundary. The browser owns presentation state and user gestures; the callback adapter translates component values into a domain request; the service layer validates the request and performs authorized work; the output adapter converts the result into component properties. Keeping those responsibilities separate makes it possible to replace a dropdown, test a query function without a browser, and review permission checks without tracing a large layout. A callback should not be the only place where a business rule exists if that rule also applies to an API or export.

Be explicit about data flow. If a chart depends on a date range and a tenant, both belong in the declared dependencies or in a trusted server-side identity context. A hidden global, a prior callback's incidental side effect, or the current browser page is not an adequate input contract. If a callback needs a result produced elsewhere, model that dependency with a component property or use a shared service/cache with defined scope. This gives Dash enough information to schedule updates and gives reviewers a way to understand why an output changed.

Application structure should also account for import behavior. WSGI workers import the module independently; tests and command-line tools may do the same. Creating the app and registering callbacks during import is expected, but starting a server, launching a one-off report, or reading a large table at import time is not. Keep startup deterministic and cheap. A clean startup makes autoscaling, worker replacement, unit tests, and local development more predictable, while the actual user request remains the point where authorized data is fetched.

