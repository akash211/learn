# Mocking Without Self-Deception

A test double is useful only if it preserves the behavior relevant to the test. Mocking can isolate a genuine external boundary and make failure cases deterministic; it can also let code pass while the real integration is broken. The central question is not "how do I mock this?" but "which behavior must remain real for this test to prove its claim?"

## monkeypatch: scoped replacement

Pytest's `monkeypatch` fixture temporarily changes attributes, mappings, environment variables, import paths, or the current directory, then restores them after the test. It is ideal for a small seam such as a clock, environment setting, or a function imported by the module under test.

```python
def test_load_config_uses_environment(monkeypatch):
    monkeypatch.setenv("APP_REGION", "test-region")
    config = load_config()
    assert config.region == "test-region"
```

Patch the name the system under test looks up. If `myapp.service` contains `from myapp.gateway import fetch`, the code calls `myapp.service.fetch`; replacing `myapp.gateway.fetch` after the import may not affect that already-bound name. Patching at the lookup site is both more effective and more honest about module coupling. Prefer `monkeypatch.setattr(module, "name", replacement)` over a dotted string when it improves discoverability. `monkeypatch.context()` creates a narrower patch region when only a small part of a test should see it.

A fake can encode a contract more clearly than a mock: for example, an in-memory repository implementing `get` and `save` with meaningful behavior. If every test asserts a sequence of internal calls, the tests may be specifying the current implementation rather than the public outcome. Use interaction assertions when the interaction itself matters—sending an email once or passing an idempotency key—not as a substitute for observable behavior.

## unittest.mock: precise interactions

Python's `unittest.mock` supplies `Mock`, `MagicMock`, `patch`, and `AsyncMock`. `autospec=True` or `create_autospec` constrains attributes and call signatures against a real object or callable, reducing typos and interface drift. A spec does not emulate behavior; a mock still returns configured values and may have overly permissive semantics.

```python
from unittest.mock import create_autospec

def test_retries_gateway_timeout(monkeypatch):
    gateway = create_autospec(PaymentGateway, instance=True)
    gateway.charge.side_effect = [TimeoutError, ChargeResult("ok")]
    service = PaymentService(gateway)

    result = service.charge_order("order-7")

    assert result.status == "ok"
    assert gateway.charge.call_count == 2
```

Dependency injection makes this cleaner than patching deep globals. If using `patch`, patch where the name is looked up, and keep the context narrow. Beware of mocks that fabricate attributes on access: a misspelled method may create another mock and let the test continue. Use `spec_set` when appropriate, and assert the resulting contract rather than only that a method was called. Avoid asserting call order unless order is part of the API.

For async dependencies, use `AsyncMock` and assert awaited behavior (`assert_awaited_once_with`) rather than merely call behavior. Mocking a coroutine with a regular `Mock` can make a test pass in a synchronous path that production cannot await, or fail for the wrong reason.

## HTTP interception: responses and real clients

For code using `requests`, the `responses` library intercepts HTTP calls and lets a test register expected methods, URLs, status codes, headers, and bodies. It exercises URL construction, request serialization, and response parsing more realistically than mocking `requests.get` itself:

```python
import responses

def test_lookup_sends_account_id():
    with responses.RequestsMock() as rsps:
        rsps.add(
            responses.GET,
            "https://api.example.test/accounts/42",
            json={"id": "42", "active": True},
            status=200,
        )
        account = load_account("42")

    assert account.active is True
    assert len(rsps.calls) == 1
```

The registration must match actual request details; unmatched requests should fail instead of falling through to the network. The test above does not prove DNS, TLS, authentication against the real provider, proxy behavior, or provider schema compatibility. Those claims need a separate controlled integration or contract test. For `httpx`, use `httpx.MockTransport` for a client transport boundary, or an appropriate library such as `respx`; do not confuse these libraries' APIs or assume `responses` intercepts HTTPX traffic.

Test an error response and timeout path as well as success. Ensure tests cannot reach a live endpoint accidentally. A recorded response fixture can become stale; keep its origin and refresh procedure clear, redact secrets, and avoid treating a single captured response as a complete API contract.

## How to detect a dishonest test

Ask whether production code could be broken while the test stays green. A mock that returns the exact final object bypasses the parsing or transformation being tested. A test that asserts a mock was called but never checks the result may pass while the caller discards the response. A mock database that does not enforce constraints cannot prove a uniqueness rule. Those tests may still be useful for a narrow unit-level responsibility, but name their scope accurately and pair them with an integration test for the skipped boundary.

Keep test doubles behaviorally minimal. Over-configured mocks with long chains such as `client.session.query.return_value...` couple the test to the implementation structure. Introduce a small adapter interface or fake when multiple tests need the same meaningful behavior. Do not mock a pure function or standard collection without a reason; real code is often simpler and more reliable.

## Common mistakes

- Patching the definition rather than the symbol used by the module under test.
- Returning a hard-coded success from a mock and claiming the HTTP, database, or serialization integration is tested.
- Allowing unmatched HTTP calls to reach the network.
- Using mocks without specs so misspelled attributes quietly appear.
- Asserting call counts on private helpers when the public behavior is what matters.

## Production notes

Mocks trade realism for control; state exactly which side of the boundary remains real. Favor injected dependencies and narrow monkeypatches, use `responses` for `requests`-level HTTP behavior and the client's own transport tooling for other libraries, then preserve a smaller set of real integration checks. A test suite is credible when every green check has a bounded claim and the skipped boundaries have another way to be exercised.

## Choosing the right seam

Start by drawing the path from test to external effect: domain service, adapter, HTTP library,
network. A unit test can replace the adapter and verify the domain policy. A client test can retain
the real adapter and HTTP library while intercepting its transport. A contract or integration test
can contact a controlled service. Each layer answers a different question. Replacing everything
below the service with a mock may be appropriate for an error branch, but it cannot validate the
HTTP request.

A fake should be simpler than the production implementation. An in-memory repository might store
objects in a dictionary and enforce the handful of semantics the service depends on. If the fake
becomes a partial ORM with transaction emulation, it is probably a second implementation that can
share bugs. Document intentionally unsupported behavior and add an integration test for essential
semantics that the fake omits.

`Mock.side_effect` can be a callable, exception, or sequence of outcomes. It is useful for testing
retry policy, but do not assert only a fixed call count if the real contract is that the operation
is idempotent or bounded. Check the final observable result and relevant request identifiers. For
cleanup logic, force the collaborator to fail and verify resources are still released. This tests
the resilience behavior without turning every internal function call into a brittle specification.

Finally, audit global patch lifetime. A patch that spans multiple tests or is applied at import
time can contaminate the suite. Prefer pytest's fixture cleanup, context managers, or dependency
injection so restoration is guaranteed even when the test raises.
