# Assertions and pytest-playwright

Browser automation becomes a test when it checks an explicit outcome. Playwright's Python package supplies browser APIs; pytest supplies discovery, fixtures, parametrization and reporting; `pytest-playwright` connects them with convenient fixtures and options. These layers are distinct. Python projects do not use the JavaScript Playwright Test runner simply because both products share the Playwright name.

## Web-first assertions

Use Playwright's `expect` assertions for browser state that can become true asynchronously:

```python
from playwright.sync_api import expect

def test_checkout_confirmation(page):
    page.goto("https://shop.example.test/checkout")
    page.get_by_label("Email").fill("buyer@example.test")
    page.get_by_role("button", name="Place order").click()
    expect(page.get_by_role("heading", name="Order received")).to_be_visible()
```

A web-first assertion polls until the condition passes or its timeout expires. This is different from reading a value once and asserting with Python's `assert`. `expect(locator).to_have_text(...)`, `to_be_visible()`, `to_be_enabled()`, `to_have_attribute()` and `to_have_count()` are useful examples. Use plain Python assertions for already-materialized values or calculations; use Playwright assertions for state that may change in the page.

Each check should answer a user-relevant question. Avoid asserting every CSS class or exact DOM shape when the contract is a visible label and result. Conversely, test important negative outcomes explicitly: validation errors, disabled submission, or an unauthorized page. A test that only reaches a URL can pass even when its content is broken.

## The Python test runner

Install `playwright` and `pytest-playwright` in the project environment, then install browser binaries with the Playwright CLI. A common test uses a plugin-provided `page` fixture:

```python
def test_search(page):
    page.goto("https://app.example.test")
    page.get_by_role("searchbox", name="Search").fill("invoice")
    page.get_by_role("button", name="Search").click()
    expect(page.get_by_role("list", name="Results")).to_be_visible()
```

The plugin also exposes fixtures such as `browser`, `context` and `new_page`, plus pytest options for browser selection, headless mode, base URL, tracing and video depending on plugin version. Consult `pytest --help` in the pinned environment and the plugin documentation rather than copying options across versions. The `page` fixture is typically function-scoped; a fresh page and context help test independence. Avoid making a module-scoped logged-in context mutable across tests unless you deliberately design and reset that shared state.

Pytest's ordinary tools remain valuable. Use parametrization for the same behavior across browsers or input cases, markers to separate slow end-to-end coverage, and fixtures for test data setup. Keep setup fast and deterministic. Browser tests are usually fewer and slower than unit tests, so run focused tests during development and the appropriate wider suite in CI.

## Sync versus async API

The synchronous API is ergonomic for ordinary pytest tests and is the default in many examples. Use `playwright.async_api` when the surrounding application or test harness is asynchronous, and `pytest-asyncio` or another compatible async test setup as appropriate. Do not mix sync and async Playwright objects in one test. An event loop already running in a notebook or async framework can make a synchronous API unsuitable in that environment.

A test should also avoid concurrent operations on the same page unless the operations are designed to coordinate. In async code, `asyncio.gather` can schedule separate browser operations, but races on one page can still make results order-dependent. Parallelize independent contexts or tests instead of overlapping actions on a single page.

## Timeout and failure meaning

A timeout is evidence that a condition did not become true within the configured budget. Increasing the timeout may be correct for a known slow environment, but it should not be the first fix. Determine whether the locator was wrong, the page state never changed, a request failed, or the environment was overloaded. Set default action and navigation timeouts with the expected application and CI latency in mind; use a narrowly scoped longer timeout when the behavior has a justified bound.

Do not replace a web-first assertion with `assert locator.is_visible()`. The latter returns a snapshot boolean and fails immediately, which reintroduces the race that Playwright's assertion is meant to avoid. Similarly, do not assert on `page.url` immediately after a click if navigation is asynchronous; use a URL assertion or wait for the navigation pattern the application guarantees.

## Common mistakes

- Using Python `assert` on an immediate locator snapshot where a retrying assertion is needed.
- Treating `pytest-playwright` and the JavaScript `@playwright/test` package as interchangeable.
- Sharing stateful browser fixtures across cases and creating order-dependent tests.
- Testing implementation details while missing the visible result a user depends on.
- Catching every exception and converting a broken test into a pass or vague failure.

## Production notes

Pin Python dependencies and install browser binaries in a reproducible environment. Keep the end-to-end suite focused on important cross-component paths; test most business logic below the browser boundary. Name tests for the outcome they verify, and make failure output actionable through traces or screenshots. A stable test has deterministic data, isolated state and a precise assertion—not an arbitrarily long timeout.

## Assert transitions, not implementation trivia

A useful browser test usually establishes a starting condition, performs an action and observes a result. The assertion should distinguish success from failure in terms that the user or API contract understands. For an edit form, that might be that the saved name appears in the profile and remains after a reload. Merely asserting that the Save button is enabled does not verify that persistence worked. If persistence is an important property, reload or revisit the record and check it again.

For navigation, Playwright offers URL assertions that retry, and locator assertions can verify the destination's meaningful content. Avoid asserting the exact URL if query parameter order or an irrelevant tracking parameter varies; assert the stable route or relevant query value. For a dialog, use the dialog event handler because a native JavaScript dialog can block page execution until accepted or dismissed. Tests should register the handler before the user action that opens it.

## Pytest organization

Use pytest markers for categories such as `smoke`, `slow` or `requires_network`, and configure marker declarations so they are not silently misspelled. Keep the suite's default selection intentional: a developer should know whether `pytest` runs the full end-to-end suite or a fast subset. Parameterize a test when the same behavior is verified for a compact set of inputs, such as valid and invalid form values. Do not create giant parameter matrices that make failures hard to identify; each parameter should contribute a meaningful case.

Fixtures are best used for stable preconditions, while the test body should make the behavior under test visible. A fixture that signs in, navigates, changes a preference and creates data can obscure what a test actually depends on. Break complex setup into named fixtures or use a supported API-level test setup, then verify the browser begins in the expected state. This separation makes failures easier to classify and reduces repeated setup code without turning the test into magic.