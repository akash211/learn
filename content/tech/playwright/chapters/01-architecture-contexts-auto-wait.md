# Architecture, Contexts and Auto-Waiting

Playwright's reliability story starts with understanding which process owns each part of a test. The API call you write is not a direct function call into the page's JavaScript runtime. Playwright coordinates a browser process, contexts, pages and frames through a driver connection. This separation explains browser installation, isolation, debugging and why a command can be waiting even when Python itself is idle.

## The browser object model

A typical synchronous Python setup looks like this:

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()
    page.goto("https://example.test")
    browser.close()
```

The `Browser` represents a launched browser process. A `BrowserContext` is an isolated session within that process, with its own cookies, local storage, permissions, viewport, locale and pages. A `Page` is a tab-like document target. A page may also contain frames, each with its own document. Multiple contexts can share one browser process while keeping user state separate; creating a new context is much lighter than launching another browser process.

Think of the lifecycle as **Playwright driver → Browser → Context → Page → Frame**. Close objects at the level you created them. Closing a context disposes of its pages and session state; closing the browser ends its contexts. In fixture-driven tests, pytest-playwright typically manages browser and context lifetime, so avoid closing a fixture-owned browser yourself.

## Context isolation as a test boundary

A fresh context per test gives a clean cookie jar and storage area, preventing one test's login or preference from silently affecting another. It is not a separate operating-system process: contexts share the browser executable and may share CPU and memory pressure. Isolation is about browser profile state, not total resource independence.

Context options let a test make environmental assumptions explicit:

```python
context = browser.new_context(
    viewport={"width": 1280, "height": 800},
    locale="en-US",
    timezone_id="UTC",
    color_scheme="light",
)
```

Explicit options improve repeatability, but they do not reproduce every user's machine. A fixed viewport avoids layout surprises; it should not become an excuse to test only one responsive breakpoint. Contexts can be configured with permissions, device descriptors or storage state. Choose only the settings relevant to the user behavior under test, because unrealistic configuration can hide defects.

## Browser engines and CDP

Playwright supports Chromium, Firefox and WebKit with browser builds selected for Playwright compatibility. The engines expose a common API, but their rendering, fonts, input behavior and feature support can differ. Cross-browser tests should focus on user-visible behavior and run against the engines your product supports, rather than assuming one engine is a perfect proxy for another.

The Chromium DevTools Protocol (CDP) is a browser-specific debugging and control protocol. Playwright's `connect_over_cdp` can attach to an existing Chromium-based browser in scenarios where that integration is needed. CDP is not the normal portable control path, and the CDP connection mode is less full-featured than Playwright's native browser protocol connection. Do not build routine tests around CDP-only behavior if Firefox and WebKit coverage matters. CDP is useful for Chromium diagnostics, attaching to an authorized managed browser, or interacting with a service that specifically exposes a debugging endpoint. Protect that endpoint: anyone who can connect may be able to control the browser and inspect its pages.

## Why auto-wait changes reliability

Traditional scripts often navigate, sleep for a fixed interval and then click. A fixed sleep guesses how long the application needs. If it is too short, the test races; if too long, every run wastes time. Playwright actions instead wait for action-specific readiness. Before `locator.click()`, Playwright checks that the target resolves uniquely, is visible, stable, enabled and able to receive events. If those conditions are not yet true, it retries until the action timeout.

That shifts test code from timing statements to intent:

```python
page.get_by_role("button", name="Save").click()
```

The locator is resolved when the action executes. This matters for frameworks that replace DOM nodes during rendering: storing a raw element handle too early can leave a stale reference, while a locator can resolve the current matching element.

Auto-wait is not a universal wait for the whole application. A click can succeed before an asynchronous save finishes if the click handler returns immediately. Wait for the observable result: a success message, changed status, navigation, or an API response that is part of the contract. Avoid `time.sleep()` as synchronization. Use a web-first assertion or a specific event wait instead. `page.wait_for_load_state()` is also not a substitute for waiting on a single-page application's data to finish rendering.

## Common mistakes

- Reusing one context for unrelated tests and then debugging hidden cookie or local-storage coupling.
- Treating a new context as a new browser process; parallel contexts still compete for host resources.
- Using CDP APIs in a supposedly cross-browser test suite.
- Assuming every click waits for a network request triggered by the click to complete.
- Setting generous global timeouts to conceal slow or ambiguous behavior instead of waiting for a meaningful condition.

## Production notes

Start with one browser process and create a context per test or independent actor. Keep browser lifecycle under a fixture or context manager so exceptions do not leak processes. Set default timeouts deliberately, then use a longer timeout only for a known slow operation. When diagnosing a failure, distinguish driver communication, browser startup, navigation, actionability and application response: they are different layers and have different remedies.

## Navigation and lifecycle boundaries

Navigation is one source of confusion because different events describe different stages. A document can commit before all of its resources finish, and modern single-page applications may update content without a full document navigation at all. `page.goto()` waits according to its configured load state, but the load event is not the same as “all application data is ready.” Conversely, waiting for the network to become completely idle can be inappropriate when analytics, polling or a persistent connection continues in the background. Prefer a locator assertion that names the state the user needs to see.

When a click is expected to navigate, coordinate the wait around the click or assert the resulting URL. This makes the relationship explicit and avoids racing to observe navigation after it already happened. If a click stays on the same document but opens a new page, listen for the popup event on the owning page. A context-level page event can be useful when a new tab is opened indirectly. Always assert that the new page reached the expected state rather than assuming that the event alone means it loaded correctly.

## State and connection modes

Launching a local browser with `browser_type.launch()` is the straightforward path for tests. Playwright can also connect to a browser server using Playwright's own connection protocol; this differs from Chromium's CDP connection. Remote execution changes where binaries, files and network routes exist. For example, a download saved by a remote browser may need to be transferred through supported APIs rather than assumed to exist at the test runner's local path. Check the chosen connection mode and deployment documentation when moving tests to a remote service.

A context is a useful boundary, but avoid relying on undocumented assumptions about process sharing or browser internals. Create contexts through the Playwright API, configure only the capabilities the test needs, and close the context in teardown. This creates an explicit lifecycle that is easier to reproduce in local and CI runs.