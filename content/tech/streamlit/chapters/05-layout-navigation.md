# Layout and Page Navigation

Streamlit's layout primitives arrange elements in a vertical flow. Start with a clear reading order, then use horizontal grouping where it helps comparison. `st.columns`, `st.container`, `st.tabs`, and `st.sidebar` solve different problems; they are not general-purpose CSS layout replacements. For multipage apps, current code can compose `st.Page` objects with `st.navigation` in a shared entrypoint, or use the conventional `pages/` directory for simpler applications.

## The vertical page and columns

The default page is a sequence of elements. Titles, explanatory text, controls, tables, and charts follow the order of the `st.*` calls. This is a useful constraint: it produces a predictable reading path without a separate component tree. Use `st.columns` for side-by-side comparisons, summary metrics, or controls that belong together:

```python
left, right = st.columns([2, 1], gap="medium")
with left:
    st.subheader("Trend")
    st.line_chart(data, x="date", y="value")
with right:
    st.metric("Latest", latest_value, delta=change)
    st.caption("Compared with the prior period")
```

A ratio controls relative widths, not fixed pixel values. Do not create many narrow columns to force a desktop dashboard onto a phone; the layout can become cramped and less accessible. Prefer a vertical stack or tabs for content that is not meaningfully compared simultaneously. Keep the primary action and essential information visible without requiring a wide viewport.

Nested columns can become difficult to scan and may be awkward on mobile. Avoid building a complex grid through deeply nested layout calls. If a design needs precise responsive rules, custom client interactions, or a component hierarchy beyond Streamlit's layout model, that is evidence to use a frontend framework or another app platform.

## Containers and expanders

`st.container` groups elements and can be useful for placing a block in a logical section, reserving a bordered region, or writing into a defined area later. A container created outside a fragment can be written to from a sequential fragment, but fragment behavior and ordering need deliberate testing. Do not confuse a container with a transactional or stateful component: it organizes output during script execution.

`st.expander` hides secondary details until requested. Use it for diagnostics, raw records, or advanced options, not for critical instructions that most users must see. Expanders can still execute their enclosed Python when the script runs; collapsing the content is not a lazy-computation guarantee. Use a condition or a button when expensive work should not happen until requested.

## Tabs and sidebars

Tabs are useful for genuinely parallel views of the same context, such as chart, table, and methodology. Their content is generally computed as the script executes, even when a tab is not selected, so placing a heavy query in a tab does not necessarily defer that work. Use a selection widget and conditional rendering if only the chosen view should perform an expensive operation. Tab state and widget behavior should be considered during reruns and navigation.

The sidebar is an app-wide home for navigation, filters, and secondary controls. Use `with st.sidebar:` or `st.sidebar` commands to place elements there. Keep the sidebar focused: users should understand which filters affect the current page and whether they apply globally. In a multipage app, add shared controls in the entrypoint before calling the selected page's `.run()` method. Be mindful that a fragment writing to an outside container has documented restrictions when running in parallel.

## Page configuration and navigation

Call `st.set_page_config` near the start of the entrypoint to set title, icon, layout, and related page-level settings. Keep the title concise and the icon recognizable. A wide layout helps analytical tables but can reduce readability for prose; select it intentionally. Page configuration is not an authentication or access-control mechanism.

The conventional multipage model places page scripts in a `pages/` directory beside the entrypoint. It is easy to adopt for a small app and Streamlit discovers those scripts. The newer explicit router API offers more control:

```python
import streamlit as st

st.set_page_config(page_title="Ops", layout="wide")

page = st.navigation([
    st.Page("home.py", title="Overview", icon=":material/home:", default=True),
    st.Page("pages/reports.py", title="Reports", icon=":material/analytics:"),
])
page.run()
```

`st.navigation` returns the current page; call its `.run()` exactly once in the entrypoint. That entrypoint is executed on each rerun and can provide shared chrome or controls. When an app session uses `st.navigation`, the `pages/` directory is ignored for that app, so do not mix the two routing systems and expect them to combine. Each page should have a unique URL path; set it explicitly when inferred names would collide.

`st.page_link` creates links to app pages and `st.switch_page` can navigate programmatically. Navigation is UI organization, not authorization: a hidden page is not a substitute for checking whether the current user may access data or perform an action. Page URLs can be accessed directly, so protect sensitive functions at the data/service boundary.

## Layout is not state

Layout calls define where output appears for a run; state values determine what is rendered. If a user changes a filter in the sidebar, the script reruns and produces a new page. If page navigation hides a widget, that widget's state lifecycle may differ from app-owned state. Keep cross-page filters in explicit shared keys and initialize them consistently. Page-specific widgets should have page-specific keys to avoid accidental collisions.

Elements are emitted in execution order. A placeholder/container can help update a region, but writing output from multiple branches without a clear sequence can create duplicate or confusing content. For long work, pair the layout with `st.status` or a spinner and show the resulting output in a stable area.

## Usability and responsive design

A good dashboard prioritizes the question the user came to answer. Use a heading, a short explanation of data freshness, then the key metric and its context. Put controls near the view they affect; use labels rather than unexplained icons. Avoid color-only distinctions and ensure charts and tables remain interpretable when narrowed. Test the app at realistic screen widths and with long labels and large numbers.

## Common mistakes

- Using columns for every element, creating a cramped dashboard that fails on small screens.
- Assuming a tab prevents unselected content from executing.
- Hiding expensive operations in a collapsed expander and expecting lazy evaluation.
- Combining `st.navigation` with `pages/` directory routing as if both control the same app.
- Treating a hidden page or sidebar visibility as an authorization boundary.
- Building deeply nested columns instead of simplifying the information architecture.

## Production notes

Make navigation predictable and preserve shared filters intentionally. Test deep links, page refresh, and direct page access—not just clicking the menu. Put sensitive permissions in the backend, and ensure each page can render correctly when its own session state is at its initial values. Layout is most successful when it reflects a data story rather than imitating a static marketing site.