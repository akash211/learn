# Test Anatomy, Fixtures, and Scopes

A pytest test is ordinary Python code whose name and location make it discoverable. The framework handles collection, fixture setup, execution, teardown, and reporting. Understanding that lifecycle is more useful than memorising flags: most suite bugs come from unclear boundaries or state that survives longer than intended.

## Discovery and the test function

By default, pytest searches for `test_*.py` and `*_test.py` files, then collects functions named `test_*` and methods with that name inside `Test*` classes. Classes are plain containers; do not define `__init__` on a test class because pytest cannot construct it in the normal way. Configuration in `pyproject.toml` can make discovery explicit:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
python_functions = ["test_*"]
addopts = "-ra"
```

A test should state one behavior and fail in a way a reader can diagnose. Arrange relevant inputs, act through the public seam, then assert the observable contract. The AAA labels need not become comments; they are a thinking aid. If one test has several unrelated reasons to fail, split it. A test is not better because it mirrors every line of the implementation.

```python
def test_discount_applies_only_above_threshold():
    quote = calculate_quote(subtotal=100, discount_code="SAVE10")

    assert quote.total == 90
    assert quote.discount_code == "SAVE10"
```

Pytest imports the module during collection, so module-level side effects happen even when a test is deselected. Keep imports safe: do not start servers, open production connections, or mutate global configuration at import time. A collection error prevents the affected module from running and is distinct from a test failure.

## Fixtures are dependency injection

A fixture is a function decorated with `@pytest.fixture`; a test requests it by naming it as a parameter. Pytest resolves dependencies recursively, runs setup before the consumer, and tears down afterward. This produces explicit test dependencies without a base class or global setup registry.

```python
import pytest

@pytest.fixture
def account():
    return Account(balance=0)

def test_deposit_updates_balance(account):
    account.deposit(25)
    assert account.balance == 25
```

Fixtures can depend on other fixtures. Keep the graph legible: a fixture that silently constructs a database, user, remote service, and application can make the test's real inputs hard to see. Prefer small composable fixtures and put behavior-specific data in the test. Use `@pytest.fixture(name="...")` only when the public fixture name genuinely improves clarity.

Setup can fail before the test body runs. Pytest still tears down fixtures whose setup completed, so resource acquisition and release should be paired carefully. For a resource with a single cleanup action, `yield` is a compact pattern:

```python
@pytest.fixture
def opened_file(tmp_path):
    path = tmp_path / "payload.txt"
    path.write_text("hello", encoding="utf-8")
    with path.open(encoding="utf-8") as handle:
        yield handle
```

The code after `yield` runs during teardown. `request.addfinalizer` is available when cleanup must be registered dynamically, but register it immediately after each successful acquisition. If setup creates three resources and fails on the third, one finalizer after all three acquisitions never gets registered. Context managers inside fixtures often make ownership clearer.

## Scope is lifetime, not convenience

Fixture scope determines reuse: `function` is the default; `class`, `module`, `package`, and `session` last progressively longer. A broader scope reduces repeated setup but shares state among more tests. Scope is therefore an isolation decision, not merely a speed switch.

| Scope | Lifetime | Typical use | Main risk |
|---|---|---|---|
| `function` | One test invocation | Fresh model, temporary directory | Setup cost repeated |
| `class` | One test class | Class-level read-only resource | Neighboring tests share mutation |
| `module` | One test module | Module-local expensive immutable data | Order coupling within module |
| `package` | Package subtree | Package-wide resource with controlled ownership | Wider hidden coupling |
| `session` | Entire pytest process | Container or immutable configuration | State leakage and long cleanup |

A session-scoped client may be valid if it is immutable or reset for every consumer. A session-scoped database is not automatically safe: rows, sequences, transactions, and connection state may leak. Pair broader-scoped infrastructure with function-scoped state reset or transaction rollback. Avoid session-scoped fixtures that return mutable objects callers are free to change.

Fixture scopes also constrain dependencies: a session fixture cannot depend on a function-scoped fixture because that shorter-lived value would expire while the longer fixture remains alive. Pytest reports a scope mismatch. Dynamic scope can be chosen with a callable scope parameter, but it should solve a real environment problem, not obscure fixture lifetime.

## Autouse and built-in fixtures

`autouse=True` runs a fixture for every test in its visibility area without an explicit request. It is useful for a small invariant such as resetting a narrowly scoped global, but too much autouse setup hides the actual dependency graph. Prefer requesting `monkeypatch`, `tmp_path`, or a project fixture by name in the test that needs it.

Useful built-ins include `tmp_path` for a per-test `pathlib.Path`, `monkeypatch` for temporary attribute, environment, or path changes, `capsys` and `capfd` for output, `caplog` for log records, and `request` for fixture metadata. Pytest undoes monkeypatch changes and removes temporary directories according to fixture lifetime. Do not assume the temporary directory is suitable for concurrent processes unless you choose unique paths or coordinate access.

## Common mistakes

- Using a broad-scoped mutable fixture and relying on test execution order.
- Acquiring a resource before `yield` but leaving no cleanup if setup later raises.
- Calling a fixture function directly. Request it as a test or fixture parameter so pytest manages dependencies and teardown.
- Naming a helper `test_*` unintentionally, causing collection.
- Treating fixture setup failure as a failing assertion; inspect the setup traceback and fixture chain.

## Production notes

Run `pytest --fixtures -q` to inspect visible fixtures and `pytest --setup-show` to see setup and teardown order. When scope expansion is proposed to speed a suite, first measure setup cost, then establish an explicit reset boundary. Reliable suites make ownership visible: each resource has one creator, a clear consumer lifetime, and a teardown path exercised on both success and failure.

## Fixture graph and test diagnosis

Pytest fixtures form a directed dependency graph. If `client` requests `app`, and `app` requests
`settings`, pytest sets up dependencies before dependents and tears them down in reverse order.
This reverse order is important: a client should close before the server or event loop it uses is
shut down. When teardown order is unclear, `--setup-show` prints fixture setup and finalization
for each test; use it before adding more fixture dependencies.

A fixture's return value is cached within its scope, not necessarily for the entire suite. A
function-scoped fixture requested twice by the same test and its fixture dependencies normally
resolves to the same value during that test invocation. This lets several consumers share one
transaction or temporary directory without global storage. If a test needs two independent
instances, make a factory fixture that returns a creator function rather than requesting the same
fixture twice.

Keep fixture names descriptive but avoid generic names that imply different behavior in nested
conftest files. A local fixture can intentionally override a parent fixture, but this can surprise
readers; document overrides and use them sparingly. Prefer explicit parameters over autouse for
important dependencies, because the function signature then acts as a compact setup inventory.

When a fixture fails, pytest classifies it as a setup error, not as an assertion failure in the
test body. Read the traceback from the first failing fixture dependency and repair the smallest
setup boundary. A later test may not run at all if a broader fixture failed, so one setup error can
produce multiple reported errors. This distinction helps separate broken infrastructure from a
behavioral regression.
