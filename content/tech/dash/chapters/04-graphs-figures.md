# dcc.Graph and Plotly Figure Patterns

`dcc.Graph` is Dash's standard component for displaying a Plotly figure and exposing chart interactions as component properties. It connects Plotly.py's figure model to Dash callbacks, allowing a filter control to produce a graph and a selected point to drive another view. Good graph callbacks use a clear figure-building boundary, keep payloads appropriate to the browser, and treat chart interaction data as user input.

## Figure basics

A Plotly figure consists primarily of `data` traces, `layout` configuration, and optional frames. Plotly Express (`plotly.express`, usually imported as `px`) is a concise high-level API; `plotly.graph_objects` (`go`) gives fine control over trace and layout properties. Both produce objects accepted by `dcc.Graph(figure=...)`.

```python
import plotly.express as px
from dash import Input, Output, callback, dcc, html

app_layout = html.Div([
    dcc.Dropdown(id="region", options=["all", "east", "west"], value="all"),
    dcc.Graph(id="revenue-chart"),
])

@callback(Output("revenue-chart", "figure"), Input("region", "value"))
def update_chart(region):
    frame = load_revenue(region)
    return px.line(frame, x="month", y="revenue", color="product",
                   title="Monthly revenue")
```

For reusable figure logic, write a function that takes a dataframe and presentation options and returns a figure. Keep database access outside the figure builder. This separation allows unit tests for transformations and makes it easier to reuse the figure in a notebook, report, or another page.

## Updating figures

The simplest update is to return a complete figure. It is easy to reason about and appropriate when filters change the dataset or trace structure. For cosmetic changes, returning a full figure may re-serialize more data than necessary. Dash provides `Patch` for partial property updates in supported versions: use it when you can confidently change a small part of an existing property without rebuilding the whole value. `Patch` changes the property tree; it does not magically reduce a large data transfer if the patch still contains a large array.

`dcc.Graph` properties such as `clickData`, `hoverData`, `selectedData`, and `relayoutData` expose interaction information. Use them as callback inputs to filter details, show a selection summary, or synchronize related charts. These payloads may be `None` before an interaction, and their shape depends on the chart and event. Inspect the installed Plotly/Dash component documentation and validate keys before indexing.

```python
@callback(Output("point-detail", "children"),
          Input("revenue-chart", "clickData"))
def show_point(click_data):
    if not click_data or not click_data.get("points"):
        return "Select a point to inspect it."
    point = click_data["points"][0]
    return f"Selected month: {point.get('x')}"
```

Do not trust the displayed point's `customdata` as a credential or permission decision. It is browser input and can be modified. For sensitive records, send a stable key to the server, re-check authorization, and fetch the allowed record there.

## Design and consistency

Set titles, axis labels, legend placement, hover templates, and color choices intentionally. A chart should explain units and time range. Plotly templates provide a shared style baseline; you can choose a template at figure construction or configure app-wide Plotly defaults as appropriate. Use categorical colors consistently across related charts and avoid encoding critical information by color alone. For tables and charts that share filters, factor common filtering logic into a service so they do not drift.

Figures can be created with Plotly Express then adjusted with `fig.update_layout`, `fig.update_traces`, or `fig.update_xaxes`. For advanced traces, `go.Figure` and `go.Scatter`, `go.Bar`, or other graph objects provide explicit control. Preserve data types: dates should be real datetime values when the axis needs time semantics, and numeric values should remain numeric rather than pre-formatted strings.

## Large data and browser cost

Plotly figures are serialized to JSON and sent to the browser. A very large figure increases callback latency, memory use, and browser rendering cost. Aggregate or filter on the server, paginate detailed tables, reduce point counts when analytically safe, and avoid sending unused columns in `custom_data`. Use WebGL-backed traces such as `scattergl` only when appropriate and test browser/device behavior; WebGL has its own resource and feature limits. It is not a substitute for data reduction.

For streaming updates, decide what history the user actually needs. Appending indefinitely grows browser memory. A bounded rolling window or periodic aggregate is usually healthier. If the data must update on a schedule, use an interval only for lightweight checks and prevent overlapping expensive work through caching or background processing.

## Common mistakes

- Returning a dataframe or arbitrary object to `figure` instead of a Plotly-compatible figure.
- Rebuilding a huge figure to change a small title without measuring payload impact.
- Assuming `clickData` is present on first render or has a fixed structure for every trace.
- Passing database primary keys in chart payloads and treating them as authorization.
- Formatting numeric values as strings before plotting, which breaks axes and aggregation.
- Using a chart with excessive points when a server-side aggregate communicates the same result.

## Production notes

Make the figure builder pure when possible and test its data transformations, trace labels, and empty-data behavior. Handle empty results with a valid empty figure and a clear title or annotation, rather than allowing an obscure exception. Match `dcc.Graph` responsiveness and sizing to its container; CSS height constraints matter as much as figure layout. For export or audit workflows, consider generating a server-side artifact from validated query parameters rather than asking the browser to reconstruct the authoritative dataset from a chart.

## Empty states, selection, and linked charts

A figure builder should handle the full input domain: ordinary data, no rows, missing columns, and invalid filters. Empty data can still produce a valid `go.Figure` with a title and annotation explaining that no observations match. That is more informative than a traceback and avoids the false interpretation that an empty chart means zero. For linked charts, decide whether selection in one graph filters the other graph, highlights a related trace, or opens a detail panel. These interactions should use stable record keys and re-query or re-authorize sensitive details on the server. Click payloads can contain values selected from the browser; they are useful interaction hints, not trusted facts.

Plotly Express is convenient for data exploration, but production figures still need explicit axes, labels, units, and hover behavior. A date axis should use actual dates, and a currency chart should communicate currency and scale. Use `category_orders` and consistent color maps when categories must appear in a stable order across pages. Be cautious with automatic legends when category cardinality is high; a long legend can overwhelm a dashboard. A clear aggregation and a small number of meaningful traces often communicate better than a dense scatterplot.

A `Patch` is most valuable when the existing figure shape remains stable and the callback changes a property such as a title, annotation, or bounded trace segment. If a new filter changes every point, returning a fresh figure may be less error-prone. Partial updates have state assumptions: if another callback or page replaced the figure, the patch may no longer describe the intended structure. Test the empty initial state and every structural transition. In either case measure the serialized payload; a small Python object change may still produce a large browser response if it includes large arrays.

