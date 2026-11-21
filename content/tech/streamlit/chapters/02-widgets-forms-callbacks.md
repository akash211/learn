# Widgets, Forms, and Callbacks

Widgets are both controls in the browser and inputs to the next Streamlit script run. A `st.selectbox` returns the selected value, a slider returns a number, and a button is true for the run caused by its click. The returned Python value is the simplest way to build a data flow: read controls, compute from their values, then render the result. Keys and callbacks add stable identity and controlled pre-run behavior when that simple pattern is not enough.

## Widget values and identity

```python
import streamlit as st

period = st.selectbox("Period", ["Week", "Month", "Quarter"], key="period")
threshold = st.slider("Minimum", 0, 100, 20, key="minimum")
st.write(f"Showing {period.lower()} values above {threshold}")
```

Each interaction usually reruns the app. The script reads the updated values, so downstream code naturally reacts. A widget key identifies the widget and exposes its value in `st.session_state`; choose a descriptive key, and do not reuse the same key for two widgets in a run. Keys matter when labels are duplicated, widgets are generated from data, or layout changes might otherwise alter identity. They also decouple internal identity from user-facing copy.

A widget can be disabled or conditionally displayed based on other values. Be careful when a widget disappears: its widget-associated state may be cleaned up, so if a value must outlive a page branch, copy it into a separate application-state key before hiding or changing the widget. Avoid modifying a widget's state after its widget has already been instantiated in the current run; initialize or update it before the widget call, often through a callback.

## Choosing the right input

Streamlit has widgets for common scalar, selection, date/time, text, file, and action inputs. Choose based on semantics, not visual novelty: radio buttons suit a few mutually exclusive choices; a select box scales to more; multiselect communicates an arbitrary subset; a slider implies a meaningful bounded range. Use labels and help text to say what the value means and its units. Validate important constraints in the Python layer even if the widget itself restricts normal interaction—API inputs, old session state, or future UI changes can violate assumptions.

For a button, the return value is an event rather than a persistent boolean setting:

```python
if st.button("Run analysis", type="primary"):
    result = analyze()
    st.session_state["last_result"] = result

if "last_result" in st.session_state:
    st.dataframe(st.session_state["last_result"])
```

The second block renders the saved result on later runs. If the result is large or must survive server restarts, choose a cache or durable storage instead of an in-session object.

## Callbacks run before the script body

Most widgets accept `on_change`, and action widgets accept `on_click`. When a callback is configured, an interaction invokes the callback first and then the app script runs from the top. This ordering lets a callback update state that the new run will immediately read.

```python
def reset_filters():
    st.session_state["region"] = "All"
    st.session_state["min_revenue"] = 0

st.selectbox("Region", ["All", "West", "East"], key="region")
st.number_input("Minimum revenue", key="min_revenue", min_value=0)
st.button("Reset", on_click=reset_filters)
```

Initialize keys before use if they may not exist. Use callbacks for small state transitions—reset, toggle, copy a submitted value—not as a replacement for the main program's data flow. A callback runs in the context of the interaction, so avoid hiding long work or complex multi-step business logic in it. Pass callback arguments deliberately; for a value that changes with the widget, read from `st.session_state` using its key rather than capturing an old local value in a closure.

A common mistake is to assign `st.session_state["x"]` after creating the widget with key `x` in the same run. Streamlit owns that widget value once it is instantiated and can raise an exception on post-instantiation mutation. Set it in a callback or before the widget is rendered. Widget keys should also be unique across pages or dynamically created contexts where the relevant widgets coexist.

## Forms batch edits

A form groups widgets whose pending values are submitted together. Until its submit button is pressed, editing a form widget does not trigger a normal app rerun. The submit button returns true in the run that receives the submitted values:

```python
with st.form("query-options"):
    start = st.date_input("Start date")
    end = st.date_input("End date")
    category = st.multiselect("Categories", categories)
    submitted = st.form_submit_button("Load report")

if submitted:
    if start > end:
        st.error("Start date must not follow end date.")
    else:
        st.session_state["report"] = load_report(start, end, category)
```

A form needs a submit button, and only the submit control submits the form. It cannot be used to make every keystroke reactive: that is precisely what forms defer. Use forms for search criteria, configuration panels, and filters whose combination is expensive to recompute. Outside a form, use immediate widgets for responsive exploration. A form batches browser edits; it does not provide atomicity for database writes, rollback, or server-side validation guarantees. Treat submitted values like any other untrusted input.

Callbacks on individual form widgets do not behave as independent immediate submission actions; form values are committed when the form is submitted. Put submit handling on `st.form_submit_button` and keep validation and processing after the submission condition. If you need a reset control inside a form, design how its values are initialized and submitted rather than expecting a separate button to cause an immediate rerun.

## Dynamic widgets and multipage behavior

When producing widgets from a loop, give each a stable unique key, such as a record ID rather than a row index if rows can reorder. Otherwise Streamlit may report duplicate keys or associate a previous value with the wrong record. Keep the key stable for a particular conceptual control. Do not expose sensitive data in keys; they can appear in app internals and debugging output.

Widget values are session state, but there is also page/widget lifecycle. A widget not rendered in a run may have its state removed. If users navigate between pages and you need a selection to persist, store it under an application-owned key and synchronize it intentionally. This is particularly important when the widget belongs to one page but an app-wide filter should remain available elsewhere.

For complex workflows, model the allowed transitions explicitly. Use callback-driven flags or a form submit event to update a small state machine, and render from that state. Do not use a long chain of button conditions as a substitute for durable workflow persistence. For a multi-user approval process, the database should be authoritative; Streamlit state should represent the current user's temporary view.

## Accessibility and usability

Give every widget a meaningful label. A label hidden visually should still have a clear accessible name; do not use empty labels as a spacing hack. Use help text for units, allowed formats, or consequences. Group related inputs with headings, forms, or containers. Keep default values sensible, especially when the app makes expensive queries or potentially destructive changes. Confirm intent before irreversible actions, and distinguish preview from commit.

## Common mistakes

- Expecting a button to remain true after its click-triggered run.
- Duplicating widget keys in loops or separate layout branches.
- Capturing a stale local value in callback arguments when the current widget value lives in Session State.
- Mutating a widget's keyed state after creating the widget in the current run.
- Putting a high-cost query on each keystroke when a form would batch edits.
- Treating form submission as a transaction or a security validation boundary.

## Production notes

Widget code is easiest to test when state transitions and data functions are factored out. Make callbacks deterministic and short; test the Python functions that validate and execute the operation separately from browser interaction. For a destructive action, display a preview or confirmation and make the backend operation idempotent. A well-designed widget is a small contract: a label explains it, a key keeps its identity, and the next run consumes its value predictably.