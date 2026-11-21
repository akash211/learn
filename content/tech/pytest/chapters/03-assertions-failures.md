# Assertions, Introspection, and Expected Failures

Pytest's plain `assert` is more than syntax sugar. During collection, pytest rewrites test modules so failed comparisons can show the values and intermediate expressions that led to the result. This makes a small, direct assertion often more informative than a custom assertion helper with a generic message.

## Assert observable outcomes

Write assertions against the contract the caller relies on: returned values, externally visible state, exception types, or documented interactions. Avoid checking an implementation detail unless that detail is itself a contract, such as a required idempotency key or a mandated SQL query plan.

```python
def test_total_uses_decimal_rounding():
    result = price_order([Decimal("1.10"), Decimal("2.20")])

    assert result == Decimal("3.30")
```

When a comparison is complex, break it into meaningful assertions or give a small message describing the policy. Pytest can introspect standard comparisons such as `==`, `in`, `is`, and chained comparisons. A hand-written expression such as `assert check_everything(order)` cannot expose what was wrong inside `check_everything`; make a helper return a useful result or keep the important predicate in the test.

Use `pytest.approx` for floating-point tolerances rather than exact equality. It supports scalar and sequence comparisons, and explicit `rel` or `abs` tolerances communicate the acceptable numerical error. For money and decimal business rules, use `Decimal` with a defined rounding policy rather than tolerating float drift.

```python
assert response.elapsed_seconds == pytest.approx(0.25, abs=0.01)
```

## Expected exceptions

`pytest.raises` asserts both that an exception occurs and, optionally, that it has the expected type. Keep the context around only the operation expected to fail. If it wraps extra setup, an unrelated `ValueError` can make the test pass for the wrong reason.

```python
with pytest.raises(ValueError, match="must be positive") as exc_info:
    set_limit(-1)

assert exc_info.value.args
```

`match` uses a regular expression against the exception's string representation. Escape punctuation when matching literal special characters, or assert on structured exception attributes when available. Matching the exact full message can make tests brittle if wording is not a public contract. Be specific about the exception class: `pytest.raises(Exception)` can accept programming errors such as an unexpected `AttributeError`.

For asynchronous code, `pytest.raises` still works inside an async test when placed around `await operation()`. Exceptions raised by background tasks may surface later or as an `ExceptionGroup`; test the API's actual concurrency contract and do not accidentally assert only the first child exception.

## Skip and xfail are distinct

`skip` means a test cannot meaningfully run in the current environment or configuration. Use `pytest.skip()` for a condition discovered at runtime, or `@pytest.mark.skipif(...)` for a known condition. A skipped test is not evidence of a pass. Report skip reasons clearly and keep skip conditions narrow so a broken environment does not silently remove most of the suite.

`xfail` records an expected failure, commonly for a known upstream issue or an unimplemented behavior. Prefer a reason and a condition tied to a real issue. `strict=True` turns an unexpected pass into a suite failure, which prompts removal of stale xfails:

```python
@pytest.mark.xfail(
    reason="upstream issue #1234; remove when fixed",
    strict=True,
)
def test_library_preserves_header_order():
    ...
```

`pytest.xfail()` marks a test as expected to fail at runtime. It stops the test at that point, so assertions after it do not run. Do not use xfail as a softer assertion for behavior your own code must support. Use a normal failing test for a known defect you intend to fix; xfail can otherwise make a permanently broken requirement look accepted.

`pytest.raises` is an assertion about the failure mode; xfail is a temporary expectation about the entire test result. `xfail(raises=SomeError)` can restrict what failure counts as expected. An unrelated exception then fails instead of being recorded as xfailed. When a condition is platform-specific, use a narrow `condition` and explain why that platform is affected.

## Diagnostics beyond assert

On failure, pytest prints captured stdout and stderr and can show logs with `caplog`. `pytest.fail("message")` is useful when a test discovers an invalid state procedurally, but prefer a comparison assertion when possible because it gives structured diffs. `pytest.fail(..., pytrace=False)` suppresses traceback detail for a deliberately user-facing failure message; it is rarely needed in ordinary tests.

For setup-time validation, `pytest.exit()` stops the whole run, which differs from `pytest.fail()` on the current test. Avoid using it to handle a local test failure. Use `--showlocals` when local values are necessary, but remember values may contain credentials or personal data in CI logs. Use `-vv` for expanded IDs and diffs, and `-l` as a shorter spelling for showing locals.

A custom assertion helper is appropriate when it centralizes a domain-specific invariant and emits actionable context. If pytest cannot rewrite assertions in that helper module because of import or compilation conditions, write the helper to raise `AssertionError` with a deliberate message or expose actual and expected values. Do not rely on private pytest internals for custom diff behavior.

## Common mistakes

- Wrapping setup and the call in one `raises` block, allowing the wrong operation to satisfy the assertion.
- Using a broad exception type or matching an entire incidental message.
- Leaving `xfail(strict=False)` around a fix; an unexpected pass can then persist unnoticed.
- Using `skip` to avoid diagnosing a failing test that should run in the current environment.
- Asserting exact float equality or only that a result is truthy when its contents matter.

## Production notes

Treat an assertion failure as a report to a future maintainer. The test name should identify the behavior; the failed expression should identify the mismatch; fixtures and captured output should expose relevant inputs without leaking secrets. A good expected-failure annotation is an exception, not a normal long-term state. Review skips and xfails periodically, and tie each to a condition that can actually disappear.

## Assert sequences, mappings, and approximate values

Pytest gives useful diffs for lists, dictionaries, and nested structures, so compare the smallest
public value that expresses the behavior. When order is meaningful, assert the sequence directly;
when order is explicitly irrelevant, normalize or compare sets carefully. Converting everything
to a set can erase duplicate-count differences, so a multiset or `collections.Counter` may better
express the contract. For dictionaries, assert required keys and values without demanding exact
equality if extra keys are allowed by the API.

For floats, `pytest.approx` supports both relative and absolute tolerances. Relative tolerance is
useful when magnitudes vary, while absolute tolerance is important near zero. Specify tolerances
when the default would hide meaningful error. Comparing two measurements from the same algorithm
can still be misleading if both share a defect; test against a known mathematical or business
invariant. If calculations represent currency, use `Decimal` and explicit quantization rather than
loosening float comparison.

## Failure signals in CI

Captured output helps explain a failure, but it can also expose tokens, customer records, or
payloads. Do not enable `--showlocals` indiscriminately in jobs with sensitive data. Prefer safe
identifiers and sanitized diagnostics. For logs, `caplog.records` lets a test inspect structured
fields without depending on formatter output; only assert on severity or message when that is
observable behavior. `pytest.fail` can end a procedural check with a clear message, but a direct
assertion usually yields a richer diff. Avoid building a generic assertion framework unless it
makes repeated domain failures more actionable.
