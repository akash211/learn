# Exceptions, Logging and Testing

Three concerns that share a theme: what happens when things go wrong, and how you find out.
Getting them right is mostly discipline — narrow exception handling, structured logs at the
boundary, and tests that fail for one reason.

## The exception hierarchy, briefly

All exceptions derive from `BaseException`. Its four direct children matter:

- `SystemExit`, `KeyboardInterrupt`, `GeneratorExit` — control flow, not errors. Never catch
  them in application code.
- `Exception` — everything you should normally handle.

`except Exception` is therefore a specific decision, not a catch-all: it deliberately excludes
the three above.

```python
try:
    payload = json.loads(raw)
except json.JSONDecodeError as exc:
    raise BadRequest("invalid JSON body") from exc
```

`raise ... from exc` sets `__cause__` and produces "The above exception was the direct cause of
the following exception". Without it you get "During handling of the above exception, another
exception occurred" — the difference is whether the two errors are related or merely sequential.
Chain when translating between layers; use `from None` to suppress noise when the original is
irrelevant to the caller.

## EAFP, and when it is wrong

"It is easier to ask forgiveness than permission" is idiomatic Python: try the operation, catch
the specific failure. `try: d[key] except KeyError` is faster than `if key in d` because it does
one lookup instead of two.

EAFP is wrong when the exceptional path is the common path — a loop where half the lookups miss
will be slower and noisier with exceptions than with `.get()`. It is also wrong when the failure
is ambiguous: catching `KeyError` around a block that does three dict lookups tells you nothing
about which one failed.

## Custom exceptions

Define them per domain, keep them shallow, and include the data needed to debug:

```python
class AppError(Exception):
    """Base for all application errors."""

class ValidationError(AppError):
    def __init__(self, field: str, reason: str):
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason

class UpstreamTimeout(AppError):
    pass
```

A base class lets callers catch "any of mine" without catching programming errors. Do not
inherit from `ValueError` unless you genuinely want `except ValueError` upstream to catch it.

## Exception groups (3.11+)

Concurrent code can fail in several places at once. `ExceptionGroup` carries many exceptions and
`except*` handles them by type:

```python
try:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(fetch(a))
        tg.create_task(fetch(b))
except* TimeoutError as eg:
    log.warning("timeouts: %d", len(eg.exceptions))
except* ValueError as eg:
    log.error("bad payloads: %d", len(eg.exceptions))
```

Each `except*` clause sees the subset matching its type; the rest propagate. This is the correct
way to handle `TaskGroup` failures. Note that `return`, `break` and `continue` are not allowed
inside an `except*` clause, and every clause runs against the same group.

## Logging

The stdlib `logging` module is fine. The failures are configurational.

Rules that prevent most incidents:

1. **One logger per module**, `log = logging.getLogger(__name__)`. Never the root logger from a
   library — you cannot control its level, and you will duplicate handlers under some frameworks.
2. **Configure once, at the entry point** (`logging.config.dictConfig` or `basicConfig` in
   `main`). Importing a module must not configure logging.
3. **Use lazy formatting**: `log.info("user %s", uid)`, not f-strings. The arguments are only
   formatted if the record is emitted, and structured handlers can keep them as fields.
4. **Log at boundaries, not everywhere.** One log per request at INFO with method, path, status,
   duration; one ERROR with the exception at the point where you stop handling it.
5. **Never log and re-raise.** You get duplicate entries and misleading stack traces.
6. **Do not log secrets or full payloads.** URLs with tokens, `Authorization` headers, and PII
   end up in log aggregators with long retention.

```python
import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger(__name__)

try:
    process(batch)
except UpstreamTimeout:
    log.exception("batch failed", extra={"batch_id": batch.id})
    raise
```

`log.exception` is `log.error(..., exc_info=True)`: it attaches the traceback. Use it in the
`except` block that actually handles the failure.

For production, prefer JSON logs (`python-json-logger` or a custom formatter) with a request ID
in a `ContextVar` injected by a filter. Then `grep` becomes a query by field instead of a regex
over prose.

## pytest: the parts that matter

```python
import pytest
from myapp.pricing import quote

@pytest.mark.parametrize(
    "qty, unit, expected",
    [(1, 10.0, 10.0), (10, 10.0, 95.0), (0, 10.0, 0.0)],
)
def test_quote(qty, unit, expected):
    assert quote(qty, unit) == pytest.approx(expected)

def test_rejects_negative():
    with pytest.raises(ValueError, match="quantity"):
        quote(-1, 10.0)
```

Fixtures are dependency injection for tests. Scope them deliberately: `function` (default) for
isolation, `session` for expensive setup (a database container, an HTTP server). A session-scoped
fixture that mutates state is a source of order-dependent failures.

```python
@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("API_URL", "http://testserver")
    return TestClient(app, data_dir=tmp_path)
```

Built-ins worth knowing: `tmp_path` (function-scoped dir), `monkeypatch` (setenv, setattr,
delattr, all auto-undone), `capsys`/`caplog` (capture output and log records), `caplog.at_level`,
`pytest.approx` (float comparison), `pytest.mark.skipif`, `pytest.param(..., id="name")`,
`xfail(strict=True)`.

`conftest.py` holds shared fixtures; it is discovered by directory, not imported explicitly.
Prefer it over a `fixtures.py` import — pytest injects by name and scope-manages properly.

Mock at the boundary you own. `monkeypatch.setattr("myapp.client.requests.get", fake)` patches
your module's reference; patching `requests.get` globally affects everything and hides coupling.
For HTTP, `responses`/`respx`/`httpx.MockTransport` are more honest than mocking the client
object.

Test the contract, not the implementation. A test that asserts on log strings or call counts of
internal helpers breaks on every refactor and catches nothing.

## Common mistakes

- `except:` or `except BaseException:` — swallows `KeyboardInterrupt` and makes Ctrl-C useless.
- `except Exception: pass` — converts a crash into silent corruption.
- Catching `Exception` and returning a default, so a typo in a variable name looks like empty
  data.
- `log.error(str(exc))` without `exc_info`, losing the traceback — the one thing you needed.
- f-strings in log calls, which format eagerly even when the level is disabled.
- Tests that depend on execution order, wall-clock time, or network access.
- Asserting `==` on floats.
- Fixtures with `autouse=True` that patch globals for the whole session.

## Production notes

A good error strategy has three layers: validate at the edge and return a 4xx; handle expected
failures (timeouts, conflicts) with retries or fallbacks and log at WARNING; let everything else
crash the request and log at ERROR with a traceback. Silent recovery is worse than a 500,
because a 500 shows up in metrics.

For tests, keep the suite fast enough to run on every save — under a minute for the unit layer.
Push anything needing a container or network into a marked integration suite. Coverage is a
smell detector, not a goal: 70% with assertions on behaviour beats 95% that executes lines.

Finally, make failures reproducible: log the inputs that caused them (hashed or truncated for
PII), and keep a failing test for every production bug you fix. The regression test is the only
part of the incident review that prevents recurrence.
