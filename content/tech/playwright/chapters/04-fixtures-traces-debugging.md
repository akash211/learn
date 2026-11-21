# Fixtures, Traces and Debugging

A browser test that fails once in CI and passes locally is not finished; it is an investigation waiting to happen. Good fixture boundaries prevent state leaks, and a useful trace turns a failure into a timeline of what the browser actually did. Pytest-playwright provides most lifecycle plumbing, while pytest remains responsible for dependency injection, fixture scopes and teardown.

## Fixture boundaries

A pytest fixture is a function that provides a dependency to a test. Fixtures can depend on other fixtures, and pytest creates and tears them down according to scope. The Playwright plugin supplies familiar browser fixtures: `browser`, `context`, `page`, and `new_page` among others. The exact list and supported options can vary by installed plugin release, so inspect the version's help and documentation.

Prefer function-scoped browser state for tests that should be independent. A fresh context separates cookies and local storage; a fresh page separates navigation and page-level event handlers. Reusing a browser process is generally cheaper than launching one per test while retaining context isolation. A broad-scoped fixture can be appropriate for immutable test data or expensive service setup, but not as an excuse to share a logged-in session that tests mutate.

A custom fixture can wrap an application-specific precondition:

```python
import pytest

@pytest.fixture
def signed_in_page(page):
    page.goto("https://app.example.test/login")
    page.get_by_label("Email").fill("test-user@example.test")
    page.get_by_label("Password").fill("from-test-secret-store")
    page.get_by_role("button", name="Sign in").click()
    return page
```

The example shows fixture composition, not a recommended way to store real credentials. Prefer a test authentication route, API-assisted setup or an approved secret mechanism. Setup should either establish a clear invariant or fail near the cause. Do not hide setup exceptions, and avoid fixtures that perform surprising actions merely because their name is short.

Fixture finalizers and `yield` fixtures handle cleanup even when a test raises. Use a `with sync_playwright()` block for direct API scripts, and let pytest-playwright own the lifecycle of plugin fixtures. Never close a plugin-managed browser in a test unless the test explicitly owns that browser; doing so can cause unrelated cases to fail later.

## Trace as a timeline

A Playwright trace can record actions, snapshots of the DOM, screenshots and network activity, allowing a test's execution to be inspected after it finishes. In Python, the plugin supports tracing options; a common approach is to enable traces on failure using plugin configuration or pytest command-line options supported by the installed release. There is also a lower-level API: `context.tracing.start(...)`, followed by test actions and `context.tracing.stop(path="trace.zip")`.

A trace viewer is more than a screenshot. It lets you step through actions, compare before and after snapshots, inspect locator resolution, and relate a visible delay to network requests or navigation. This helps distinguish “the button never appeared” from “the click happened but the server response failed.” Treat traces as sensitive artifacts: they may contain screenshots, page text, URLs, request data or user information. Store and retain them according to the same privacy rules as test logs.

A practical workflow is to keep tracing disabled or failure-only for routine runs, then enable always-on recording for a short local reproduction. Preserve the failed trace, test output and environment details together. A trace from a different browser build or app revision may be misleading.

## Debugging from evidence

Start at the first failed action or assertion in the test report. Check whether the locator matched what you intended, whether the browser was on the expected page, and whether a prior request or console error changed the flow. Use `page.on("console", ...)` and `page.on("pageerror", ...)` when application JavaScript errors are relevant. Network events can reveal failed calls, but logging every request in a large suite creates noisy and potentially sensitive output.

Use Playwright Inspector or `PWDEBUG=1` during local development where supported. The inspector can pause execution and expose locator suggestions, but passing under an interactive debugger is not proof of deterministic behavior: the pause changes timing. Re-run without debugging after fixing the root cause.

A good failure message names the intended condition and includes the actual state when useful. If waiting for a toast, assert its text. If waiting for a route, use a URL assertion. Avoid a custom retry loop around an action that already retries; it can mask a persistent bug and multiply test duration.

## Common mistakes

- Setting session scope on mutable contexts, then relying on test execution order.
- Starting a trace without stopping it or saving it outside the test's artifact directory.
- Treating a passing debug run as proof that a timing race is fixed.
- Capturing all network payloads in CI without redacting personal or secret data.
- Adding sleeps after a flaky test instead of inspecting its trace and state transitions.

## Production notes

For large suites, collect traces on failure and keep a bounded retention period. Include browser version, Python and plugin versions, test identifier, worker and commit in the artifact metadata. Separate product defects from infrastructure failures: a browser crash, missing executable or resource exhaustion should be reported distinctly from an assertion mismatch. Stable fixture scopes and actionable evidence reduce the time from red CI to a verified fix.

## Build reusable fixtures with explicit scope

A fixture can depend on the plugin's `page` fixture and return a page already navigated to a route, but be precise about what the test inherits. For example, a `dashboard_page` fixture can navigate to the dashboard and assert a loaded heading before handing control to the test. It should not silently perform the key action that a test is supposed to verify. A fixture that uses `yield` may perform cleanup afterward, but cleanup should be safe if setup failed halfway through.

Pytest fixture scope is not a performance toggle without consequences. Function scope creates a fresh dependency for each test; module or session scope shares it. Sharing an immutable API client can be safe, while sharing a browser context that accumulates cookies, handlers or open pages is risky. If a wider scope is necessary, define reset behavior and make it testable. Keep fixtures composable so a test can request only what it needs.

## Distinguish common failure classes

A locator timeout usually means the expected element was absent, ambiguous or not actionable in the allowed period. A navigation timeout can indicate a slow response, an incorrect route or a background page that never reaches the chosen event. A browser launch failure points to installation, system dependencies, sandbox configuration or resource constraints, not a bad locator. A failed setup fixture should be reported as setup failure rather than attributed to the test's assertion. Categorizing the first failure prevents teams from responding to every red test by raising a global timeout.

When using traces, preserve the first failure's evidence before a retry replaces it. A trace viewer can also show which action consumed the most time. Keep a short reproduction command and the exact pytest node ID in the issue. If the failure is specific to CI, compare browser and package versions, resource limits, locale, viewport and network routes with local runs; do not assume the code path is identical just because the test name is the same.