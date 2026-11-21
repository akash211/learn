# Multi-Page Apps and Routing

A production dashboard often has multiple views with shared navigation, permissions, and state. Dash supports a page registry through `dash.register_page` and `dash.page_container`, as well as manually managed routing with `dcc.Location`. The registry approach reduces routing boilerplate; manual routing gives direct control over URL interpretation. Choose one clear routing model and keep path parsing, page composition, and authorization predictable.

## Dash Pages

A Pages app typically enables pages when constructing the app, defines a shared shell, and places the page container in the layout:

```python
from dash import Dash, html, page_container

app = Dash(__name__, use_pages=True)
app.layout = html.Div([
    html.Nav("Analytics"),
    page_container,
])
```

Each page module calls `dash.register_page` with a module path and optional path/name metadata, then exposes its `layout`. Modules are discovered at startup from the pages directory by default, or from a configured pages folder. Keep registration importable and deterministic. A page layout can be a component tree or callable depending on the app's needs; avoid expensive work at import time. Check the installed Dash docs for page options such as URL path, order, title, and path variables because they are framework-version features.

The page registry provides a convenient place for navigation and metadata, but it does not itself enforce access control. A hidden navigation link is not authorization: users can type a URL or issue a direct request. Protect sensitive callbacks and data access on the server, and consider whether the page should return a safe unauthorized view.

## Manual routing with `dcc.Location`

`dcc.Location` exposes URL properties including `pathname`, `search`, and `hash`. A callback can select a page layout based on the pathname and return it into a content container. Query strings should be parsed with standard URL parsing rather than string splitting. Validate path segments and query parameters as untrusted input.

```python
from dash import Input, Output, callback, dcc, html

app.layout = html.Div([dcc.Location(id="url"), html.Div(id="page")])

@callback(Output("page", "children"), Input("url", "pathname"))
def route(pathname):
    if pathname == "/reports":
        return reports_layout()
    if pathname == "/settings":
        return settings_layout()
    return html.H2("Not found")
```

This pattern is simple for a small app. As routes multiply, a registry or explicit routing table is easier to audit than nested conditionals. Provide a not-found page and decide how trailing slashes, URL case, and unknown query parameters behave. `dcc.Location` can also be an output to navigate after a callback; redirect only after validating the user's requested action.

## Deep links and state

URLs are shareable application state when they represent a meaningful view. Encode non-sensitive filters as query parameters or path components when users need bookmarks, refresh persistence, or links to colleagues. Normalize and validate values when reading them. Do not put credentials, private data, or authorization claims into URLs; they are logged in browser history, proxies, and analytics systems.

Keep transient UI state such as an open dropdown out of the URL unless restoring it is useful. For more complex state, define a compact schema and decide how it is versioned. Callbacks can synchronize URL properties and controls, but bidirectional synchronization can loop or overwrite user edits if initial values and trigger cases are not handled explicitly.

## Shared shell and page boundaries

Keep navigation, global status, and shared providers in the app shell. Page-specific controls and callback logic should live near the relevant page. Shared callbacks can use stable IDs and page-aware logic, but avoid one giant callback that dispatches every route and interaction. Page modules should import service functions rather than importing other page modules, which can create cycles during discovery.

If pages use callbacks referencing components not present in the current page, validate the app's dynamic layout strategy and callback registration settings. Suppressing missing-component validation globally can hide real mistakes. Test direct navigation to every page, page refresh, back/forward navigation, and routes that rely on query strings.

## Common mistakes

- Treating a registered page or hidden link as an access-control mechanism.
- Performing database queries while Python imports each page module.
- Parsing query strings with ad hoc splitting or trusting URL parameters.
- Forgetting direct URL entry and refresh behavior during testing.
- Using duplicate component IDs across pages that may be present together in the shell.
- Synchronizing URL and controls in both directions without defining initial and trigger behavior.

## Production notes

Make route behavior independent of a prior click path: a copied URL should construct the same permitted view after a fresh request. Treat route-level authorization and record-level authorization separately. Include meaningful page titles and accessible navigation. When deploying behind a URL prefix, configure Dash's request and route prefixes consistently with the reverse proxy so assets, callbacks, and page links use the same base path. Add a route smoke test to catch asset-prefix and deep-link failures before release.

## Query strings, redirects, and route evolution

A URL is a public interface that users bookmark, paste into messages, and sometimes keep for years. Treat its schema as an API: use predictable parameter names, accept only documented values, and decide what happens when a parameter is missing or no longer supported. Query parameters are strings and may appear multiple times; parse them with a standard URL parser, validate them, and convert them to domain types. Do not treat a URL-supplied tenant, account, or record ID as proof of permission. Resolve it against the authenticated user's accessible scope.

Redirects after a form or action should preserve the intended public base path and avoid open redirects. If a URL contains a return target, restrict it to an approved local route rather than accepting an arbitrary host. Behind a prefix, generated links, assets, login callbacks, and logout redirects must agree on that base. This is why a route test through the public ingress is more valuable than a unit test that calls a route function directly.

As the app grows, decide which information is global and which is page-local. Navigation and an authenticated user summary belong in the shared shell; a page-specific filter should not unexpectedly change another page's query. If filters are intentionally shared, model them explicitly and document when they reset. Avoid circular imports between page modules: register each page and import common services from a lower-level package. Include a route inventory and a direct-link smoke test in the release checklist. A tidy registry makes it easier to review page ownership, titles, route patterns, and access requirements as the application expands.


## Routing checklist

For each route, record its path, title, page module, required identity scope, and whether its filters are encoded in the URL. Test a known route, an unknown route, a malformed parameter, and a user who is authenticated but lacks access. Make the default route safe and useful, and ensure errors do not reveal whether a protected record exists. If page modules are discovered from the filesystem, keep the folder structure and import names stable; startup should fail visibly on a duplicate or malformed registration. This small inventory is valuable in code review because route behavior, navigation, and authorization otherwise tend to be scattered across layout and callback files.
