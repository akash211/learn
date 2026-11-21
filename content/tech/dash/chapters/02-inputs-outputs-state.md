# Inputs, Outputs, State, and Initial Calls

The callback declaration is a contract: `Input` values trigger recalculation, `State` values are read when a trigger occurs, and `Output` values are written back to components. Choosing these roles correctly prevents accidental reruns, makes forms understandable, and clarifies which values are committed versus merely edited.

## Input versus State

```python
from dash import Input, Output, State, callback, html

@callback(
    Output("greeting", "children"),
    Input("submit", "n_clicks"),
    State("name", "value"),
    prevent_initial_call=True,
)
def greet(n_clicks, name):
    if not n_clicks:
        return "Enter a name and submit."
    return f"Hello, {name or 'there'}!"
```

The submit button's `n_clicks` is an `Input`; changing it requests a new callback. The name is `State`: the function reads its current value on submit, but typing alone does not trigger a request. Use `Input` for values whose change should recompute or refresh the output. Use `State` for values sampled only when another event commits an action, such as form fields on submit, a selection when a download button is clicked, or pagination settings when a refresh is pressed.

A callback can have multiple inputs and states. Their positional arguments appear in the same declaration order: all declared `Input`s followed by declared `State`s. Prefer meaningful names and small callbacks over relying on long positional lists. If a callback has no meaningful trigger, reconsider its interaction design rather than turning every field into an input by habit.

## Outputs, returns, and deliberate no-change

Each `Output(component_id, property)` corresponds to a returned value. One output receives a scalar return. Multiple outputs receive a tuple/list in matching order. The value must be valid for the target property. For example, `children` can contain text or components, while `dcc.Graph.figure` expects a Plotly figure representation.

Use `dash.no_update` to leave a particular output unchanged while updating another output. Raise `dash.exceptions.PreventUpdate` to prevent all outputs from changing. These are not interchangeable: `no_update` is useful for an invalid form where you want to show an error but preserve existing results; `PreventUpdate` means the triggering event should cause no response update at all.

```python
from dash import Input, Output, callback, no_update

@callback(
    Output("result", "children"),
    Output("error", "children"),
    Input("submit", "n_clicks"),
    prevent_initial_call=True,
)
def validate(_clicks):
    value = read_and_validate_form()
    if value is None:
        return no_update, "Choose a valid value."
    return f"Result: {value}", ""
```

Avoid using falsy checks as an implicit validity rule: `0`, an empty string, and `None` can mean different things. Define domain validation explicitly and provide a visible error path. A callback exception otherwise becomes a failed request; users should see a safe message, and logs should preserve enough diagnostic context without exposing sensitive submitted data.

## Initial calls and `prevent_initial_call`

On initial page load, Dash may call callbacks to populate outputs based on the initial layout. That behavior is often desirable: a chart can render from a default filter without requiring a click. Setting `prevent_initial_call=True` on a callback suppresses its initial invocation when the callback's input and output are present together at page initialization. This is useful for submit actions, expensive work that should wait for a user choice, or an output that should remain blank until explicitly requested.

The precise initial-call behavior interacts with dynamically inserted components. If an input or output is added after initial load, Dash may need to execute callbacks to bring the new component into a consistent state. Do not treat `prevent_initial_call` as a security or cost-control mechanism; validate inputs and put resource limits on the operation itself. Verify dynamic layouts with the Dash version and component lifecycle used by the app.

A common pattern is a default value plus an initial render: set the control's `value`, leave the callback's initial call enabled, and make the callback handle the default. For a form submit, use `prevent_initial_call=True` so loading the page does not behave like the user submitted it.

## Trigger context and multiple triggers

When several inputs are declared, any changed input can trigger the function. Use `dash.ctx.triggered_id` (available in current Dash releases) to identify the component ID that caused the callback. `ctx.triggered_prop_ids` can identify all changed component-property pairs, particularly when more than one change is reported. Avoid inferring the cause from whichever argument happens to be nonempty: values may stay truthy from a previous event.

This is useful when two buttons share one callback, for example “apply” and “reset.” However, separate callbacks can be clearer when actions have different validation or side effects. Keep trigger-specific branches small and explicit. If multiple inputs can change together, define what that means rather than assuming one event always wins.

## Component properties and validation

Properties differ by component and may be read-only or only meaningful for certain component states. Check the component reference for the installed version. Inputs such as `n_clicks` typically start at `None` or zero; dropdowns have a value or may have no selection; `dcc.DatePickerRange` has start and end dates that can be unset. Treat all user-controlled values as optional and validate type, range, and allowed values on the server.

For repeated controls, IDs may be dictionaries and the corresponding dependencies use pattern-matching selectors. A `State` property is also useful for current client state held in `dcc.Store`. Do not send large datasets through callback arguments without considering JSON transfer size and browser memory.

## Common mistakes

- Making every edited field an `Input` when the intended interaction is “submit once.”
- Declaring the submit button as `State`, so changing its click count never triggers the callback.
- Forgetting to align multiple output return values with their declared order.
- Returning `None` when the intent is “keep the previous value”; use `no_update` where appropriate.
- Assuming `prevent_initial_call` prevents later calls caused by dynamic component insertion.
- Treating callback arguments as trusted because the UI normally constrains them.

## Production notes

Use callback signatures that communicate intent: triggers first, then sampled state. Separate parsing and validation from the callback so those functions can be tested directly. For actions with external side effects—sending an email, changing a record, launching a job—make the operation idempotent where possible and guard against duplicate submissions. A button click count is a UI event indicator, not a durable transaction ID. For expensive submit actions, show a loading state and consider a background callback; for ordinary interactions, keep the response quick and return a useful output on every valid path.

## Forms as a transaction boundary

The Input-versus-State decision is clearest when a form represents an operation. Text fields usually change many times before a user commits; using each as an Input can issue a request for every keystroke, expose partially completed values to downstream work, and make errors appear before the user has finished. A submit button as Input and fields as State creates a deliberate boundary. The callback should still handle an empty submission, a repeated click, and a request that arrives after the user has changed the form. For a costly operation, disable the button while the request runs and use an idempotency key for external side effects rather than assuming the browser sends exactly one request.

For live search, the opposite choice may be right: a field is an Input because each edit should update a small result. Debounce behavior, minimum query length, and cancellation then become product decisions. Keep the database query bounded and avoid displaying stale results as if they matched the current text. A request identifier or explicit query echo can help show which result corresponds to the latest input. These patterns reinforce that `Input` and `State` are not performance decorations; they express the interaction users are meant to experience.

