# Performance and Memory on Large Data

Streamlit's Python code may be fast while the app still feels slow. A rerun can repeat I/O, serialize data, build chart specifications, send payloads to the browser, and ask the browser to lay out thousands of cells. Performance work starts by measuring those stages and reducing unnecessary work, not by adding caches to every function.

## Find the dominant cost

Measure representative interactions: initial load, changing a filter, switching pages, submitting a form, and refreshing a chart. Record query duration, transformation duration, result row/column counts, serialization time if measurable, cache hit behavior, and process memory. A slow dashboard may be network-bound, Python-bound, or browser-bound. `time.perf_counter()` around pure functions and database timing logs often reveal the first bottleneck; browser developer tools can reveal a large response or rendering delay.

Separate work into stages:

1. **Acquire** only the required data, with a timeout and query limits.
2. **Transform** using vectorized operations or database-side aggregation where appropriate.
3. **Render** a compact result with clear columns and chart data.
4. **Cache** reusable pure outputs with correct inputs and freshness.

A button or form can defer a costly query until the user commits criteria. `st.fragment` can isolate an independently updating region, while not eliminating the cost of the work inside it. Avoid polling every few seconds unless data freshness justifies the constant load.

## Reduce data before it reaches the app

The most reliable optimization is often moving filtering, aggregation, and pagination to the database or service. A dataframe containing millions of rows consumes memory, takes time to serialize, and produces a huge browser payload. Select needed columns and a bounded time window. Paginate results and use server-side sorting/filtering rather than loading the entire table. For charts, aggregate to the visual resolution or sample with a stated strategy; rendering every point is rarely useful.

Use efficient data types and avoid holding duplicate representations. A CSV upload may exist as an uploaded buffer, copied bytes, parsed dataframe, transformed dataframe, and cached return value simultaneously. Free local references when no longer needed, but understand that the Python allocator may retain memory for reuse rather than immediately returning it to the operating system. Test peak memory during transformations, not only after completion.

## Caching helps—and costs memory

`st.cache_data` can avoid repeating a query or transformation, but each distinct parameter combination can create an entry. `max_entries` limits the number of entries, not their total size. TTL supports freshness but entries may still occupy memory until eviction/cleanup behavior. Cached values are serialized and copied on retrieval, so a cache hit can still have cost. Keep cache keys low-cardinality, set bounds based on real result sizes, and include relevant data versions.

`st.cache_resource` retains a shared resource such as a model, so its memory cost is typically once per app process, not once per user. Session State, however, is per session: keeping a 500 MB dataframe in each active user's state can exhaust memory quickly. Prefer small IDs and filters in session state, and retrieve or cache shared data carefully. If each user's data is private, design isolation rather than simply moving it into a shared cache.

## Rerun-aware interface design

Every immediate widget event may cause data work. If multiple fields define one expensive query, use a form. If one dashboard region is independent, a fragment can reduce rerendering elsewhere. If users need a manual refresh, provide a button and label the timestamp. Tabs can improve navigation but should not be assumed to lazily execute their contents. Place expensive computation behind explicit conditions.

Use progressive disclosure for detail: display summary metrics first, then fetch full records when requested. Avoid repeated independent calls that each load the same dataset. Compute shared results once per run and derive several visualizations from them. Where one user action triggers several simultaneous slow upstream calls, use bounded concurrency, cancellation/timeouts, and a clear partial-failure policy rather than creating unbounded tasks.

## Memory across users

The deployment process serves multiple sessions. Shared caches and resources reduce duplicate initialization but increase concurrency and sharing concerns. Session-local data multiplies by active sessions. A loaded machine-learning model may be a deliberate large resource; document its startup and memory profile, and avoid loading another copy per rerun. If parallel fragments access it, verify thread-safety and serialize access if necessary.

Monitor resident memory, active sessions, request rates, and cache behavior at the process/container level. Load-test with realistic simultaneous users and datasets. A local one-user demo may stay within memory limits while a hosted app with several sessions fails. Container memory limits should include Python, native libraries, model allocations, and temporary peaks.

## Common mistakes

- Loading the whole warehouse table into pandas and relying on a widget to filter it.
- Assuming cache hits are free or `max_entries` is a byte limit.
- Putting large per-user dataframes in Session State.
- Making every control trigger a costly query instead of batching with a form.
- Sending dense chart data to the browser without aggregation or profiling.
- Diagnosing memory from RSS alone without distinguishing retained objects, native allocations, and allocator reuse.

## Production notes

Set explicit size limits and budgets for queries, uploads, cached results, and concurrent work. Measure startup, reruns, peak memory, and browser payloads in a production-like deployment. Build backpressure into database pools and upstream calls. If a data volume requires custom virtualized grids, streaming, or distributed computation for routine user interactions, Streamlit's simplicity may no longer offset the architectural limits; move heavy processing behind a service and return bounded results.

## Load and capacity testing

Test both warm and cold behavior. A warm cache can hide expensive startup, model loading, or query planning that every new process pays after deployment. A cold start test also reveals dependency downloads or initialization that make the app appear unavailable. Then test concurrent sessions using realistic behavior: one person changing a filter rapidly, another exporting, and others navigating between pages. Observe memory peaks, database pool saturation, and upstream request rates rather than only average latency.

Set budgets for each layer: maximum query rows, upload size, cached result cardinality, session-retained data, and concurrent background work. The values should follow product requirements and measured host capacity, not arbitrary defaults. Include temporary copies and native-library allocations in memory estimates. A cached model may fit once but fail if each worker loads its own copy; conversely, a shared resource may serialize requests if the library is not concurrency-safe. Document the chosen trade-off and add alerts before saturation. Performance is a workload property, so repeat these tests when dataset shape, libraries, or hosting topology changes.

A useful baseline records a few percentiles for common actions and a peak-memory figure for both cold and warm paths. Compare those measurements after a dependency upgrade or a new visualization feature. Keep load tests safe for production data: use representative synthetic data or a staging copy, limit concurrency intentionally, and ensure a test cannot trigger real emails, payments, or irreversible writes. These safeguards make performance regressions reproducible without turning a benchmark into an incident.