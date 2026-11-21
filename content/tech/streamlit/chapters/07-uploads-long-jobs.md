# Uploads, Downloads, and Long Jobs

Files and long-running work introduce resource and trust boundaries that a small widget demo can hide. `st.file_uploader` provides uploaded content as a file-like `UploadedFile`; `st.download_button` sends prepared content to a browser. The app still owns validation, memory usage, storage, cleanup, and the consequences of processing a file. A spinner makes waiting visible but does not make a blocking operation cancellable or durable.

## Uploading defensively

```python
uploaded = st.file_uploader("Upload a CSV", type=["csv"])
if uploaded is not None:
    raw = uploaded.getvalue()
    # Example application policy, not Streamlit's universal upload limit.
    if len(raw) > 25 * 1024 * 1024:
        st.error("File exceeds the application limit")
    else:
        frame = parse_csv(raw)
        st.dataframe(frame.head(100))
```

The uploader's allowed extensions and MIME hints are convenience checks, not proof of file contents. A malicious file can have a misleading name or content type. Parse with a safe, appropriate library; reject unexpected structure; limit row counts and decompressed sizes; and avoid writing untrusted filenames directly to a filesystem path. If an upload is persisted, generate an internal name, store it in a controlled location, and define retention and deletion rules.

An `UploadedFile` is file-like and held in the app's memory while in use. Calling `getvalue()` creates bytes in memory; copying it again into another structure multiplies cost. For large uploads, enforce size at the widget/server/proxy layer and stream to controlled storage if the architecture supports it. Do not assume the reverse proxy, hosting platform, and Streamlit app have matching upload limits.

Uploaded data is user-controlled input. Validate encoding, schema, types, formulas, and data volume. Spreadsheet exports can also expose formula-injection risks if untrusted cells are later interpreted by spreadsheet software. Avoid logging raw files or sensitive row values. A filename and uploaded bytes should not be trusted as identity or authorization.

## Downloads and generated artifacts

`st.download_button` offers a browser download from data supplied by the app. Prepare the output intentionally: select columns, set encoding, include a header, and communicate the date or filters represented. Use a media type and filename appropriate to the format. For a small result, bytes or a string can be passed directly. A large export may occupy memory in the app process; generate it with bounded resource use or store it in object storage and return a controlled link through an appropriate service.

A download button's callback and rerun semantics are not a durable background-job system. If generating an export takes a long time, create a job record, return a job identifier, and let the user check progress. Secure the eventual file URL, set expiry/retention, and verify authorization at download time. Do not expose a permanent public URL for private data.

## Spinners, status, and progress

For short synchronous work, `st.spinner` communicates that the app is busy:

```python
with st.spinner("Validating and importing…"):
    result = import_rows(rows)
st.success(f"Imported {result.count} records")
```

`st.status` can show a longer sequence of steps, and progress indicators can report meaningful progress if the work can measure it. A fake percentage that jumps from 0 to 100 is worse than an honest indeterminate spinner. Keep users informed about what is happening and what can be safely retried.

These elements provide UI feedback; they do not move work to a background worker. A blocking Python function occupies the Streamlit session's script execution while it runs. If it times out, disconnects, or the process restarts, an in-memory operation may be lost or left partially completed. Use a queue and external worker for durable, retryable, long-running jobs, with idempotent steps and persisted status. Streamlit can submit work and poll for results.

## Fragments for periodic updates

`st.fragment` can isolate a section that updates independently. Its `run_every` option schedules periodic reruns while the session is active, making it suitable for a modest live status panel. It is not a general scheduler: no active session means no reliable recurring task, and repeated polling can load an API or database. For parallel fragments, shared state and mutable resources require synchronization; parallel fragments have limitations on writing to containers created outside them. Keep periodic fragments read-mostly and bounded.

## Error handling and cleanup

Catch expected parsing and upstream errors at the boundary, show a concise actionable message, and log diagnostic details without exposing secrets or raw sensitive rows. Do not swallow every exception and report success. If a partial import is possible, explain what committed and what did not; prefer a transaction or staged import where available. Clean up temporary files and close short-lived resources using context managers. If the file is kept for a later step, store a reference to managed storage rather than retaining multiple copies of its entire contents in Session State.

## Common mistakes

- Trusting file extension checks as content validation or malware protection.
- Copying large uploads repeatedly into bytes, dataframes, and session state.
- Treating a spinner as asynchronous processing or cancellation support.
- Running a long task in a user session and assuming it survives process restarts.
- Using `run_every` fragments as a durable cron job.
- Returning a public or long-lived download URL for private generated data.

## Production notes

Document supported file formats and limits, enforce limits at every layer, and test adversarial inputs. Use a job queue for work that must finish reliably, and make retry semantics explicit. Downloads and uploads need the same authorization and retention design as any other data endpoint. UI feedback should report real progress, while system design ensures the work is bounded and recoverable.

## Upload lifecycle and retention

An upload has a lifecycle beyond parsing: received, validated, processed, and either discarded or retained under an explicit policy. For a one-time preview, avoid writing it to disk at all. For a multi-step workflow, persist the object in controlled storage and keep only a storage identifier and checksum in the session or job record. Apply access checks each time the object is read, and delete temporary objects on both success and failure. The browser may keep a selected file while the session remains active, but that is not an archival guarantee.

If processing fails, distinguish a validation error that the user can correct from a transient dependency failure that may be retried. Do not silently retry a partially completed import unless each step is safe to repeat. Show the user whether a file was accepted, rejected, or committed, and include a correlation ID for support without exposing its contents. This lifecycle model keeps UI feedback honest and limits sensitive data exposure.

When multiple files are accepted, validate each independently and report which file failed; do not let one malformed item cause an ambiguous partial import. For a batch that must be all-or-nothing, stage the parsed rows and commit them in one explicit database transaction after validation. If partial success is the intended behavior, record per-file outcomes and make that contract visible to the user. Clear temporary objects as soon as the workflow no longer needs them.