# Session State Patterns

`st.session_state` is a dictionary-like object that holds values for one Streamlit session across script reruns. It is the mechanism for remembering user choices and in-progress UI state when local variables are recreated. It is not a database, a process-wide cache, or a guarantee of persistence after a session ends. Use it with explicit ownership: name keys, initialize them, and distinguish application state from values owned by widgets.

## Initialize state deliberately

A key can be accessed by attribute or item syntax, but item syntax makes dynamic keys and missing-key checks clearer. Initialize keys before use:

```python
import streamlit as st

if "count" not in st.session_state:
    st.session_state["count"] = 0

if st.button("Add one"):
    st.session_state["count"] += 1

st.write("Count:", st.session_state["count"])
```

The first run seeds the count. A button click triggers a rerun, and the updated value remains in the session. Without initialization, reading an absent key raises a helpful exception. Do not scatter implicit initialization through many branches: centralize a small set of defaults at the start of the relevant page or in an initialization function. Then readers can see the state shape.

Use namespaced, descriptive keys such as `filters.region` or `workflow.step` only if your team convention supports them—Session State is a flat mapping, so dotted names are just strings, not nested objects. Avoid storing large datasets unnecessarily; session state can keep objects alive for the whole session and multiply memory use across concurrent users.

## Widget state versus application state

Giving a widget `key="region"` connects its current value to `st.session_state["region"]`. Streamlit maintains that widget-associated key as part of widget lifecycle. An app-owned key is different: it is your own durable-within-session value, independent of whether a particular widget is currently rendered.

For example, a filter widget might disappear when the user switches views. If its chosen value must still be applied later, copy it into an app-owned key in a callback or before changing pages. When a widget is not rendered, its associated state can be cleaned up. Treat UI presence and application ownership as separate concerns, especially in multipage apps and conditional forms.

Do not assign to a widget's key after the widget has been instantiated in the current run. Update it before rendering, or in a callback that executes before the rerun body:

```python
def clear_query():
    st.session_state["query"] = ""

st.text_input("Search", key="query")
st.button("Clear", on_click=clear_query)
```

The callback updates the value before the next script body creates the text input. If initialization is needed, do it before the widget call as well.

## Model a workflow as state transitions

Session State is useful for small, interactive workflows: a wizard step, a selected record, a preview result, or a temporary confirmation flag. Rather than relying on transient button truth values, store the current stage:

```python
if "step" not in st.session_state:
    st.session_state.step = "choose"

if st.session_state.step == "choose":
    choice = st.selectbox("Plan", ["Basic", "Pro"], key="plan")
    if st.button("Preview"):
        st.session_state.step = "preview"
        st.session_state.chosen_plan = choice

if st.session_state.step == "preview":
    st.write("Selected:", st.session_state.chosen_plan)
    if st.button("Back"):
        st.session_state.step = "choose"
```

This is a state machine: define valid states, transitions, and what each state renders. For critical workflows, persist authoritative state in a database, with user and authorization checks. Session State is volatile, per-session UI context; it should not be the only record that a user approved a payment or completed a compliance task.

Store values, not open-ended side effects. A `last_result` dataframe may suit a short-lived analysis, while the fact that an export was approved belongs in durable storage. Use stable record IDs instead of row numbers to keep selections correct if data order changes.

## Callbacks, forms, and synchronization

A widget callback runs before the app script reruns. This makes callbacks convenient for setting flags, resetting related fields, and copying values. Keep the callback narrow and deterministic. For a form, individual edits are buffered until submission, so process the submitted values after the submit button returns true; do not expect each field callback to fire as the user edits.

When two controls depend on each other, define the update sequence explicitly. For example, a country change can reset a city key before the city widget is rendered. If that city is invalid for the new country, validate it rather than leaving a stale value. Avoid clever synchronization in which every widget callback changes several unrelated controls; small explicit transitions are easier to reason about and test.

Reruns caused by a callback are still reruns. A callback should not make an external API call merely to populate a transient label if the operation may be repeated. Put slow computations behind an explicit submit or button path, and cache pure reads where appropriate.

## Multipage state and session boundaries

In apps using `st.navigation` and `st.Page`, pages run in the same app session during normal navigation, but page and widget lifecycles can affect keys. A shared filter can be app state while page-local inputs remain widgets. Use consistent keys and initialize shared state in the entrypoint before `page.run()` if every page depends on it. Keep the state contract documented; otherwise each page may create contradictory defaults.

A URL opened in another browser session is not a way to retrieve the original in-memory state. Session State is not a cross-session communication mechanism. Similarly, a cached object can be shared across sessions, while Session State is scoped to one session. If users need to resume a workflow on another device, persist a server-side record keyed by an authenticated principal and workflow ID.

Do not assume a session maps one-to-one with a person. Authentication and authorization must be implemented by the deployment or app's identity integration, and server-side data access must check the current user's permissions. A session-local variable containing a user name is not proof of identity.

## Testing and debugging

Extract state transitions into plain functions when practical:

```python
def next_step(state, event):
    if state == "choose" and event == "preview":
        return "preview"
    return state
```

Pure functions are easy to unit test. For app-level tests, Streamlit's testing facilities can run an app script and interact with widgets, but tests should verify behavior rather than internal implementation details. During debugging, inspect a small set of keys rather than dumping session state indiscriminately; it may contain private or large values.

## Common mistakes

- Treating Session State as persistent storage that survives a server restart or lost session.
- Confusing a widget's key with an app-owned record that should survive the widget disappearing.
- Reusing keys across widgets, or mutating widget state after the widget is created in the current run.
- Storing a large dataframe per session when a cached query or durable reference would use less memory.
- Using a session value as identity or authorization evidence.
- Representing a multi-step critical workflow only in volatile in-memory state.

## Production notes

Session State improves continuity, but it shifts memory cost to active sessions. Prefer compact IDs, filters, and UI flags over duplicate copies of large data. Keep user-specific data scoped and verify permissions on every backend operation. For resumable or consequential workflows, persist events or records externally and treat Session State as a convenient projection of the current screen, not the source of truth.