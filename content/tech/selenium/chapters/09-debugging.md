# Debugging: Screenshots, Logs and Evidence

A Selenium failure report should answer: what was the test trying to do, which browser session did it use, what state did the page reach, and what was the first useful error? A stack trace without browser context often leaves the team guessing. A screenshot alone may show a symptom but not the command or timing that caused it. Collect a small, consistent evidence set at the point of failure.

## Screenshots and URLs

The WebDriver API supports `save_screenshot(path)` and `get_screenshot_as_file(path)`. Capture before quitting the driver, and use a unique filename that includes the test identifier and worker or run ID. Record `current_url` and `title`; they often reveal a redirect, login page, or unexpected tab. In remote execution, confirm that the artifact path is accessible to the client or use the Grid's supported artifact collection.

```python
try:
    run_checkout(driver)
except Exception:
    driver.save_screenshot("artifacts/checkout-failure.png")
    print("url:", driver.current_url)
    raise
```

Keep evidence collection in a fixture or test hook so it applies consistently. Preserve the original exception and re-raise it. If the browser session is already dead, screenshot collection may fail too; handle that secondary failure without replacing the primary error. Do not capture screenshots indiscriminately if pages contain private data. Restrict access and retention, and redact or avoid sensitive fields where possible.

## Logs and browser state

WebDriver service logs can explain startup failures, driver communication problems, and browser crashes. Browser console logs may expose JavaScript errors, blocked resources or application warnings, although the way to request logging depends on browser and Selenium configuration. Keep logging capabilities explicit and verify support for the remote endpoint. A blank log is not proof that the application had no errors.

Record the Selenium client version, browser and version, platform or container image, capabilities, execution mode, Grid session ID, test name, and timestamps. Include the locator and wait condition in assertion messages. Never record passwords, authorization headers, cookies or full page source by default. Logs can contain secrets embedded in URLs or page text, so sanitize before uploading to a shared artifact store.

## Debug the first failure

Start from the first exception, not the final cascade. A later `NoSuchElementException` may follow a failed navigation or a stale context switch. Classify the failure: session startup, navigation, locator, synchronization, interaction, application assertion, or cleanup. Then reproduce with the same browser image and test data, ideally running the single test once without parallel load.

A `StaleElementReferenceException` suggests the DOM node was replaced or the page navigated. Re-locate after the known transition rather than caching elements across it. An intercepted click suggests an overlay or layout transition; inspect a screenshot and wait for the actual blocker to disappear. A timeout tells you a condition did not become true; log what was expected and inspect whether the selector, application state, or environment was wrong.

## Traces and timelines

Selenium itself does not provide one universal built-in trace format equivalent to every browser automation framework. For detailed timelines, combine driver logs, browser performance/devtools logging where supported, CI timestamps, and application-side request logs. Selenium Grid observability can provide session and node details depending on its deployment. Keep tooling version-specific and do not assume that a Chrome-specific capability works in Firefox or on every remote Grid.

Measure durations around navigation and key actions. Distinguish slow application response from slow test polling or overloaded workers. A test that fails only when parallel may reveal shared test data, resource exhaustion, or a shared driver—not a browser timing mystery. Use screenshots and logs as evidence, then test one hypothesis at a time.

## Common mistakes

- Calling `quit()` in teardown before capturing artifacts.
- Swallowing the original error when screenshot collection also fails.
- Rerunning a flaky test without preserving the original run's artifacts.
- Logging full page source, cookies, tokens, or sensitive form data.
- Treating browser console output as identical across browsers and versions.
- Retrying until green without establishing whether the failure is environmental or product-related.

## Production notes

Artifact collection should be bounded in size, private by default, and tied to a run ID. Keep successful-run artifacts only when they add diagnostic value; retain failure evidence according to a defined policy. Use a CI summary that links the test name, browser, screenshot and relevant logs, and report when an artifact could not be collected. Keep the browser alive long enough to collect evidence, then always close the session.

## Make failures actionable

Failure messages should state what the test expected and the relevant object or operation. A generic assertion that “element was not found” forces someone to reconstruct the scenario; a message that names the result region, expected state, timeout, and current URL points toward an investigation. Add locator details without exposing sensitive input. Keep artifacts named by run and test so a parallel worker cannot overwrite another failure's screenshot. If the CI system truncates logs, upload a concise summary and keep larger artifacts in a restricted store.

A flaky label should not end the investigation. Compare repeated runs and classify whether failures cluster by browser, node, test order, data record, or time of day. Correlation with one node suggests environment health; correlation with one record may reveal test data assumptions; order dependence often points to shared state. A single rerun can provide evidence, but record both outcomes. Avoid retry policies that report only the final green result, since they erase the signal needed to fix the root cause.

For application-side diagnosis, correlate test timestamps or a safe request identifier with server logs. This can distinguish a browser that never sent a request from an API that returned an error or a UI that failed to render a successful response. Do not put credentials or personal information in the correlation identifier.

## Reproduction checklist

Before changing code, write down the browser and driver versions, headless or headed mode, viewport, test data, worker count, and the exact first exception. Run the test in isolation once to see whether concurrency is involved, then repeat only enough to establish a pattern. Compare a passing and failing screenshot or log rather than relying on memory. Change one variable per experiment—such as a missing wait condition or resource limit—and record whether the failure moves. A reproducible case makes it possible to decide whether the fix belongs in a selector, application state, fixture, browser image or Grid configuration.

Some failures are nondeterministic because of external systems outside the browser. If an upstream dependency is unavailable, report that separately from a UI assertion and use an approved stub in deterministic tests. Keep an end-to-end check for the integration boundary, but avoid turning every UI test into an uncontrolled dependency test.

Good debugging turns a browser failure into a reproducible observation. Record the environment, capture the page state before teardown, preserve the first exception, and let the evidence guide the next experiment. Avoid blanket retries and longer sleeps: they hide rather than explain the state transition that failed.