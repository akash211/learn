# Multiple Outputs and Pattern-Matching IDs

Interactive interfaces often update more than one property at a time and often repeat the same control for a collection of records. Dash supports both cases directly: callbacks can declare multiple outputs, and pattern-matching callbacks select component IDs by their dictionary structure instead of enumerating every instance.

## Multiple outputs

A callback may declare several `Output`s and return values in matching order:

```python
from dash import Input, Output, callback, html

@callback(
    Output("status", "children"),
    Output("export", "disabled"),
    Input("query", "value"),
)
def check_query(query):
    valid = bool(query and query.strip())
    return ("Ready" if valid else "Enter a query", not valid)
```

Use one callback when outputs are consequences of the same calculation or must change consistently. This avoids duplicate expensive work and prevents a status message and action button from disagreeing. Output order is part of the callback contract; keep it readable, and consider named intermediate values before returning a tuple. For selective preservation use `dash.no_update` for an individual output. Raise `PreventUpdate` when every output should remain untouched.

Dash also supports duplicate outputs when explicitly enabled with `allow_duplicate=True` on an output, subject to the framework's rules about initial calls. This should be exceptional. Two callbacks writing the same property create ordering and ownership questions; a single callback that owns the property is usually easier to reason about. If multiple events update one logical value, route them to one callback or use a deliberate state-reduction pattern.

## Dictionary IDs

For dynamic controls, use a dictionary ID that describes each instance:

```python
from dash import ALL, Input, Output, callback, html

items = ["north", "south", "west"]
layout = html.Div([
    html.Button(f"Refresh {name}", id={"type": "refresh", "key": name})
    for name in items
] + [html.Div(id="messages")])

@callback(Output("messages", "children"),
          Input({"type": "refresh", "key": ALL}, "n_clicks"))
def report_clicks(clicks):
    return f"Refresh buttons: {clicks}"
```

A pattern ID is a dictionary whose keys and values define a matchable shape. `MATCH`, `ALL`, and `ALLSMALLER` are the principal pattern selectors. `ALL` gathers a property from every matching component and passes a list of values. `MATCH` pairs a matching input and output instance, useful when each row has its own output. `ALLSMALLER` selects components whose matched numeric index is smaller than a target index, supporting ordered or cumulative interactions.

`MATCH` requires compatible patterns on the callback's outputs and inputs so Dash can identify the matching instance. `ALL` can be used with fixed outputs to aggregate values. The values returned for wildcard outputs must conform to the matched output structure. Consult the callback reference for exact combinations and constraints; wildcard signatures are expressive, but not every arbitrary mix of selectors is valid.

## Dynamic lists and stable identity

A typical use is a filter row users can add or remove. Give each row a stable key, construct its components with IDs like `{"type": "filter-value", "index": row_id}`, then match the input and output by index. Do not use the current list position as an identity if removing an earlier row changes what later rows mean. Stable identifiers preserve meaning when the list is reordered.

When `ALL` returns a list, the order corresponds to matching components in the rendered layout, not a database guarantee. If each value must be associated with a record, include its stable key in the data model and resolve it explicitly. Avoid creating an unbounded number of components: a user can create a huge DOM and large callback payloads. Apply sensible limits and use server-side pagination for large collections.

Pattern callbacks reduce registration boilerplate, but can make callbacks hard to understand if IDs are inconsistent. Define a small ID schema in one place, for example `{"type": "filter-value", "index": ...}`, and reuse it. Keep the `type` value specific enough to avoid matching unrelated component families.

## Choosing callback boundaries

A single multi-output callback is a good fit when outputs share validation, computation, or a transaction-like view of the same result. Separate callbacks make sense when outputs have different triggers, expensive operations, or failure behavior. Pattern matching is a good fit for repeated controls; fixed IDs are simpler for a fixed toolbar. A shared callback that handles every button via `ctx.triggered_id` may be concise for a handful of actions, but distinct callbacks can isolate permissions and side effects.

`dash.ctx.triggered_id` returns a dictionary for a dictionary ID. `ctx.triggered_prop_ids` exposes changed component-property IDs, which can be useful for multiple pattern matches. Don't stringify IDs and later parse them; preserve structured IDs as structured values. Test both one-instance and many-instance cases, plus adding and removing components.

## Common mistakes

- Returning values in a different order from the declared outputs.
- Writing a multi-output callback that combines unrelated actions and becomes a large branch tree.
- Using several callbacks to own the same property without a clear `allow_duplicate` strategy.
- Assuming list position is a durable record identifier.
- Treating `ALL` input values as if they were keyed to business records automatically.
- Using broad dictionary patterns that also match controls from another part of the app.

## Production notes

Pattern callbacks still run on the server unless implemented with a clientside callback. Their input and output values cross the browser/server boundary, so payload size grows with the number of components. Prefer compact values, stable IDs, and bounded lists. Add focused tests for matching behavior and deletion/reordering because those are where identity bugs surface. If the user can dynamically construct arbitrary filters, validate the accepted field and operator against an allowlist before forming queries; component IDs are routing metadata, never authorization.

## Stable identity is more important than list order

Dynamic components are frequently connected to records that have a durable identity: a saved filter, a selected asset, or a row in an editable report. Give each instance a key from that domain or generate a UUID when the user creates it, and preserve the key when the visual order changes. The `index` field in a pattern ID is simply a dictionary key name; it need not mean array position. A callback can use `ctx.triggered_id` to discover the dictionary identifying the event, but should still verify that the referenced item exists in the current server-side model and belongs to the user. Browser component existence does not prove an item is valid.

An `ALL` dependency is convenient when the callback computes a summary over several controls. Think about empty matches, newly inserted controls with unset values, and removal while a request is in flight. Normalize values before combining them, and distinguish a missing value from a valid zero or empty string. For a `MATCH` callback, test that every instance updates only its corresponding output; a mistaken wildcard shape can couple rows in surprising ways. Keep the component factory and its ID generation in one module so the shape is not hand-typed differently across layout and callback code.

Multiple outputs also benefit from a deliberate failure policy. One callback can return a safe status message and preserve a previously valid chart with `no_update`, or can clear outputs when a query is invalid. Decide which behavior avoids misleading users. If a callback writes a record and updates the UI, remember that the record write and UI response are not one atomic operation: a network timeout can occur after the write. Use an idempotent service operation and a durable confirmation key for important mutations.

