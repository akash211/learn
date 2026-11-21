# Network Interception and Mocking

Browser tests often depend on APIs that are slow, costly, nondeterministic or outside the team's control. Playwright can observe, modify, fulfill or abort network requests. This allows a test to control a dependency boundary while preserving the browser's rendering and interaction behavior. Mocking is useful when it isolates the behavior under test; it is misleading when the test only proves that its own fabricated response renders.

## Observe and wait for a request

Pages and contexts emit request and response events. A response can be awaited alongside the action that triggers it:

```python
with page.expect_response("**/api/orders") as response_info:
    page.get_by_role("button", name="Refresh orders").click()
response = response_info.value
assert response.status == 200
```

This pattern ties the wait to the triggering action, reducing the chance of missing a fast response. Match the intended request carefully: a broad wildcard may capture a background poll or another call to the same route. For a request with a specific method, URL and payload, provide a predicate function. Do not wait for a response the UI does not actually need; assertions on the rendered result often test the user's contract more directly.

For diagnostics, `page.on("request")`, `page.on("response")` and `page.on("requestfailed")` can capture useful metadata. Register listeners before navigation or before the action of interest. Remember that event callbacks can run frequently, and bodies may contain sensitive values. Prefer selective logging of method, URL path and status over dumping all headers and payloads.

## Route interception

`page.route()` or `context.route()` installs a handler before matching requests proceed. A handler may call `route.continue_()` to send the request onward, `route.fulfill()` to return a controlled response, or `route.abort()` to simulate a failed request. Install routes before the page triggers the request. Context-level routes apply to pages in that context, which is useful for shared behavior; page-level routes make scope narrower.

```python
def test_empty_orders(page):
    page.route(
        "**/api/orders",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body='{"items": []}',
        ),
    )
    page.goto("https://app.example.test/orders")
    expect(page.get_by_text("No orders yet")).to_be_visible()
```

The page is real, but the server response is deliberately synthetic. This test is strong for the empty-state rendering contract and weak evidence about backend integration. Maintain separate tests that exercise the real service contract. A mock should be explicit in the test name or fixture so reviewers can see which system boundary is simulated.

Handlers can inspect the request and choose a response by URL, method or posted data. For an error path, use an appropriate status or abort and assert the UI's recovery behavior. For modified real responses, `route.fetch()` can retrieve the upstream response, then `fulfill()` can return it with selected changes. Use this carefully: modifying a production-like response can produce behavior that no actual server emits.

## Ordering, caching and service workers

Interception affects timing and browser behavior. Register it before navigation to avoid a race. Service workers can intercept network requests before Playwright routing sees them; the context option to block service workers can simplify routing tests, but it changes the application environment. Use it when the test objective is to control network calls, and separately verify service-worker behavior if it matters to the product.

A route handler can leave requests unresolved if it neither continues, fulfills nor aborts, causing hangs until timeouts. Keep handlers deterministic, fast and narrowly matched. Clean up routes if they are installed in a shared context; function-scoped test contexts usually make teardown simpler than manually removing every handler.

## Mock only the boundary you mean to mock

Mocking a third-party API can make a test stable and avoid creating real accounts, but response shape and error semantics should be derived from an owned contract or documented fixture, not a guess. Version fixtures and keep them representative. A test that mocks every request to `**/*` can accidentally hide missing calls, broken assets or routing mistakes. Prefer one known endpoint and let unrelated requests proceed or fail loudly according to test policy.

Do not use request interception to evade authentication, paywalls, bot protection or other access controls on third-party sites. In production automation, interception does not grant permission to collect or alter data; respect applicable terms, privacy obligations and rate limits. For your own application, use a test environment and controlled test accounts.

## Common mistakes

- Registering the route after `goto()` has already sent the request.
- Matching too broadly and fulfilling unrelated API calls with the same fake body.
- Treating a mocked browser test as evidence that server integration works.
- Forgetting the effect of service workers or cache on observed requests.
- Logging complete request bodies, authorization headers or personal information in CI.

## Production notes

Use the smallest possible interception surface and make each mock's contract visible. Keep a small number of integration tests against a real test service, complementing fast deterministic UI cases. When network behavior is the subject, assert the request and response deliberately; when user behavior is the subject, prefer assertions on the rendered outcome. Diagnose routing failures from trace and request events before expanding timeout budgets.

## Route patterns and handler design

A route can be installed on a page or on its browser context. Choose the narrowest scope that covers the intended requests. A page route is appropriate for a one-page test; a context route can cover an authentication redirect or shared API contract across multiple pages. Route patterns may use glob-style URL matching, regular expressions or a predicate. In a predicate, inspect the request object and return a boolean for the exact method and endpoint. Avoid a pattern like `**/*` unless the test intentionally controls every request.

Keep handlers short and deterministic. If a handler awaits an external service, it has reintroduced the instability the mock was meant to remove. If a request is supposed to proceed, call `route.continue_()`; if it should be answered, provide a valid status, headers and body to `fulfill()`; if testing an offline error, explicitly abort. A handler that returns without resolving the route can stall the page and lead to confusing action timeouts.

## Contract and test layering

A fake response should be a well-formed example of the documented API schema. If the application expects a collection envelope, return that envelope rather than a bare list simply because it is easier to type. Shared fixture builders can reduce drift, but update them alongside the service contract and add schema validation where appropriate. Keep success, empty, authorization and server-error conditions distinct; the user-visible outcomes should not all be represented by an empty result.

A robust test portfolio has layers. Unit tests can validate response transformation, route-mocked UI tests can exercise rendering for rare states, and a smaller integration set can exercise real service communication. These layers help isolate failures and control cost. Do not make every browser test depend on a live third party, but also do not let mocks become the only evidence that integration still works. Review trace data and route logs with the same privacy precautions as any other test artifact.