# Downloads, Uploads, PDFs and Screenshots

Browser tests often cross the boundary between a web page and the local filesystem. Playwright provides event-based APIs for downloads and file selection, and browser APIs for screenshots and printing to PDF. These operations are asynchronous: register the wait before performing the action that triggers the event, then verify the resulting artifact instead of assuming a click was enough.

## Download files

A download is emitted by a page when a user action starts one. Use `expect_download()` to capture it:

```python
with page.expect_download() as download_info:
    page.get_by_role("button", name="Export CSV").click()
download = download_info.value
assert download.suggested_filename == "orders.csv"
download.save_as("artifacts/orders.csv")
```

The browser's temporary download location is managed by the Playwright context. Save the file to a deliberate path if it must persist beyond the context lifetime or be collected as a CI artifact. The suggested filename is metadata, not proof that the content is correct. For CSV or JSON exports, read the saved artifact and assert headers, shape or a known record. For binary outputs, check file existence, size bounds or a meaningful signature where appropriate. Avoid asserting an entire unstable document byte-for-byte unless byte identity is the requirement.

Set the context's `accept_downloads` option if creating a context directly and the chosen API requires it; pytest-playwright configurations can supply a configured page/context. Confirm behavior against the pinned Playwright version. Event waits must wrap the trigger, or a fast download can happen before the test starts waiting.

## Upload files

For a file input, `set_input_files()` assigns the selected file directly:

```python
page.get_by_label("Attach receipt").set_input_files("tests/data/receipt.pdf")
```

For a custom button that opens a file chooser, wait for the chooser around the click, then set the file:

```python
with page.expect_file_chooser() as chooser_info:
    page.get_by_role("button", name="Choose file").click()
chooser_info.value.set_files("tests/data/receipt.pdf")
```

Tests should use small, checked-in fixtures that are safe to distribute and have known contents. To test validation, include empty, wrong-type or oversized fixtures intentionally and verify the UI's response. Do not use a developer's home directory or an external upload as an implicit dependency. If the upload flow uses drag-and-drop or a custom widget, test the actual user behavior separately where feasible, but `set_input_files()` is usually more reliable for exercising server-side processing.

## Screenshots and visual evidence

`page.screenshot(path="artifacts/page.png", full_page=True)` captures a page; `locator.screenshot()` captures a specific element. Screenshots are useful for debugging and visual review, but a single image is not a robust assertion of semantic correctness. Visual regression requires a comparison workflow with controlled viewport, browser version, fonts, device scale factor and dynamic content. Mask timestamps or randomized regions only when their variability is irrelevant, and never mask content whose correctness matters.

Screenshots can include personal data, access tokens rendered into the UI or private records. Use synthetic accounts and restrict artifact storage. Set viewport size deliberately, wait for the relevant element to be visible, and consider reduced motion or font readiness when a visual baseline is being captured. Full-page screenshots may trigger layout changes or capture dynamic regions; take them only when the whole document is the intended artifact.

## PDFs

The Python `page.pdf()` API is available for Chromium and generates a PDF from the page using print media by default. It supports page size, margins, background printing and page ranges, among other options. Firefox and WebKit do not expose the same PDF-printing capability through Playwright's page API, so tests that call `page.pdf()` should use Chromium and state that engine constraint.

PDF layout can differ from screen layout due to print CSS. Use `page.emulate_media(media="print")` when you need to inspect print styling before capture. Verify the generated file with a PDF parser or by checking its metadata and text, and include a visual review for high-value documents. Do not claim that a PDF is correct just because the API returned bytes. For large or sensitive documents, handle outputs like other confidential artifacts.

## Common mistakes

- Waiting for download after the click, making the test miss a fast event.
- Reading a temporary download after the browser context has closed without saving it.
- Selecting a file by absolute path that exists only on one developer machine.
- Treating a screenshot as a complete test of accessibility or functionality.
- Expecting `page.pdf()` to work identically in every browser engine.

## Production notes

Create an `artifacts/` directory during test setup and use deterministic filenames per test or worker to prevent collisions. Validate both the browser event and the file's meaningful contents. In CI, upload only the artifacts needed for diagnosis, set retention limits and ensure that uploaded screenshots and documents contain synthetic data. Pin the browser build for visual comparisons; otherwise pixel differences may reflect an environment update rather than an application change.

## Artifact paths and contents

Relative artifact paths should be rooted in a known test working directory, not wherever a developer happened to invoke pytest. Create the output directory before saving, and include a test-specific identifier or worker index in filenames. If a test runs in a remote browser, check how its download or generated file is transferred back to the runner; do not assume local path semantics across a remote connection. Make the artifact part of test reporting so a failed assertion points to the relevant output.

For text exports, check encoding and newline assumptions only when those are part of the contract. CSV readers can validate headers and row values without coupling to line-ending style. For image or document output, a smoke check of MIME type, file size or signature catches empty artifacts, while a semantic parser can verify important content. For high-value reports, review rendering in a controlled visual test. Keep all expected files small and safe to store in source control; generated output should generally live in an artifact directory rather than be checked in.

## Native dialogs and event ordering

Playwright can handle JavaScript dialogs through page events. A native file chooser is a separate browser event. Register `expect_file_chooser()` before clicking the control that opens it, just as for a download. If a standard file input exists, assigning files directly is simpler and avoids operating-system UI. For a drag-and-drop interface, determine whether the requirement is file selection or the exact drag gesture; choose the API that tests that contract. In all cases, assert the upload's resulting status or record rather than just the act of setting a file.

When an export action opens a new page or popup rather than starting a download directly, wait for the page event and inspect the destination. Do not assume that every file-producing action emits a download event; applications may generate a blob URL or render an inline PDF. Choose the expected event based on observed product behavior and test the outcome accordingly.