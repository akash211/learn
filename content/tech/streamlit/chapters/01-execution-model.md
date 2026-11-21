# The Rerun Execution Model and State

Streamlit looks like ordinary Python because it is ordinary Python, but it does not behave like a command-line script whose local variables live until the process exits. Each browser session has a Streamlit-managed execution context. When a user changes a widget, Streamlit updates that widget's value and normally executes the app script again from top to bottom. Understanding this cycle is the foundation for every state, performance, and side-effect decision.

## A script is a render function

Treat the script as a function that derives the current page from inputs and state:

```python
import streamlit as st

st.title("Revenue explorer")
region = st.selectbox("Region", ["North", "South"])
rows = load_revenue(region)
st.line_chart(rows, x="month", y="revenue")
```

On initial load, the script runs and each `st.*` call emits an element. When the select box changes, the selected value is made available and the script starts again; the new run emits the UI for the new value. The app is not a static HTML page with a small JavaScript event handler attached to every widget. The simple mental model is: **widget event → updated widget state → script run → new UI**.

This has a useful consequence: ordinary Python control flow describes conditional UI. A button's truth value is true for the run triggered by its click; then it returns false on later runs. A branch such as `if st.button("Recalculate"):` can run a calculation once, but a result held only in a local variable disappears after the next rerun. If the value must remain visible, store it in `st.session_state`, a cache, or a durable external system, according to its ownership and lifetime.

## Local variables are temporary; side effects are not

At the beginning of a normal full run, Python re-executes top-level code and creates fresh local bindings. Variables do not automatically persist between runs. A database insert, email, file write, or remote API call, however, is an external side effect: it has already happened and rerunning the same code may do it again. This mismatch is a major source of bugs.

Avoid putting non-idempotent work at top level. Gate an action behind a button or form submission, record the operation's state, and ideally make the remote operation idempotent using a stable request key. A pattern that sends an invoice whenever the script reaches a line is not safe merely because the user clicked once—the user may refresh, submit again, or reconnect. For business-critical work, enqueue a job in a backend with deduplication and durable status rather than treating the Streamlit process as a transaction coordinator.

The script can also read secrets or initialize reusable clients at top level, but consider how often that work happens. Pure declarations and inexpensive UI construction are natural. Reopening a connection, reloading a model, or fetching the same dataset on every widget event calls for resource caching or another explicit lifecycle.

## Full reruns, fragments, and forms

The default is a full app rerun after an interaction. This makes dependent UI consistent: changing a filter recomputes downstream values in order. It can be wasteful for a dashboard where a small control should update one region. `st.fragment` marks a function whose widgets can rerun that fragment independently. The rest of the page remains in place during that fragment rerun.

```python
@st.fragment
def refreshable_metrics():
    window = st.selectbox("Window", ["1h", "24h", "7d"], key="metric-window")
    st.line_chart(load_metrics(window))

refreshable_metrics()
```

Use fragments when the isolation is meaningful, not as a default optimization. State shared with the surrounding script still needs a clear contract. A fragment may be configured to rerun periodically with `run_every`; automatic polling consumes resources and should have a real freshness requirement. Parallel fragments introduce concurrency: shared mutable objects and outside-container writes need particular care. `st.rerun()` explicitly requests another run and can create loops if called without a condition that changes.

A form changes the interaction boundary. Widgets inside `st.form` hold edits in the browser until the user submits. Only then are the values committed together and the script reruns. This avoids one full computation for every field while a user is editing parameters. It is not a database transaction: it batches UI values, not external writes.

## The browser, session, and server

A browser tab connects to a server-side session. Session State is scoped to that session, not shared by all users and not durable storage. If the session is lost, restarted, or expires, in-memory session values should not be treated as a reliable record. A second tab is generally a distinct session context; do not rely on it as a synchronized view of the first tab's edits.

There are several different lifetimes:

| Value | Appropriate home | Lifetime and sharing |
|---|---|---|
| A widget's current selection | Widget state / `st.session_state` | Per app session; tied to widget identity |
| Derived dataframe | `st.cache_data` | Cached across reruns, potentially shared across sessions |
| Database connection or model | `st.cache_resource` | Reused resource; may be shared across sessions |
| User preferences or workflow record | Database or another durable store | Explicit persistence and authorization |
| A temporary computed local | Local variable | One script run only |

The distinction between session-local and globally cached data is a security boundary. A cached function can return the same result to multiple users if the inputs and code match. If results depend on identity, include a safe identity/tenant discriminator in the cache key or avoid cross-user caching. Never assume that a value is private because it was first computed during one user's run.

## UI order and execution flow

Elements appear in the order their commands execute. A conditional branch can omit or replace elements on the next run. Widgets also have identity rules, usually stabilized with a `key`; changing labels or parameters in some ways can make Streamlit treat a widget as a different widget and reset its value. Assign explicit, unique keys for widgets whose identity matters, especially inside repeated layouts or dynamic lists.

The execution model encourages a declarative style but does not mean the script is pure. Make the data flow visible: collect inputs, validate, load/compute, render. Keep write operations in explicit event paths and use status indicators around work. Separate the transformation logic into ordinary Python functions so it can be unit tested without a browser.

## Common mistakes

- Expecting a local variable assigned during one run to survive the next.
- Repeating a payment, insert, or email because a top-level line executes on every rerun.
- Calling `st.rerun()` unconditionally and producing an infinite rerun loop.
- Treating `st.cache_data` as a user-private session store.
- Using fragments before understanding whether the enclosed UI depends on state outside it.
- Assuming that a form submission commits a database transaction.

## Production notes

Instrument expensive functions and external calls separately from UI rendering. A rerun can be expected behavior, not an error; logs that say “the script ran again” do not by themselves indicate duplicate users. For side-effect paths, use idempotency keys and persist job or action status outside session memory. Test both the initial run and interaction-driven reruns, including repeated submission and reconnect scenarios. Once this model is clear, widgets, forms, callbacks, state, and caching become explicit tools for controlling the same execution cycle.