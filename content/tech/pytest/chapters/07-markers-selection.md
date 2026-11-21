# Markers, Selection, and Test Organisation

Markers attach metadata to tests. Pytest's built-in markers include `skip`, `skipif`, `xfail`, `parametrize`, and `usefixtures`; project-defined markers can classify integration, slow, or platform-specific tests. They become useful when classification drives an explicit execution policy rather than just decorating tests.

## Register and apply markers

Register custom markers in configuration so misspellings trigger a warning or error instead of silently creating a new label:

```toml
[tool.pytest.ini_options]
markers = [
  "integration: exercises external services or containers",
  "slow: takes longer than the quick feedback budget",
  "requires_network: needs an explicitly available network service",
]
```

Apply a marker to a test with `@pytest.mark.integration`, or to a class when all its tests share the category. Markers can also be applied to individual parameter sets using `pytest.param(..., marks=...)`. `pytestmark = pytest.mark.integration` at module level marks every test in that module. Avoid broad class or module markers when a handful of tests have different requirements.

Marker names should describe test properties, not execution commands or teams. A `slow` marker does not by itself make a test slower, and an `integration` marker does not start a database. Document what qualifies and what setup is required. A marker that no CI workflow or developer command uses is just metadata.

## Selection is composable

Use node IDs for exact tests and `-k` for substring or boolean-expression selection:

```bash
pytest tests/unit/test_prices.py::test_rounding
pytest -k 'payment and not integration'
```

`-m` selects by marker expression:

```bash
pytest -m 'not slow and not integration'
pytest -m 'integration or requires_network'
```

Pytest marker expressions can combine names with `and`, `or`, `not`, and parentheses. `-k` matches parts of names and parent node IDs, so its selection may include more cases than expected; inspect with `--collect-only`. `-m` operates on markers and is usually the better fit for suite categories. `--ignore` and `--ignore-glob` exclude paths, while `--deselect` can remove specific node IDs. Exclusion should be visible and intentional: silently excluding a directory from the default suite can create a false sense of coverage.

Common feedback loops include `pytest -q` for ordinary runs, `pytest -x` to stop after the first failure, `pytest --lf` to rerun last failures, and `pytest --ff` to run last failures first. `--lf` state is local to a pytest cache directory and can become stale; it is a convenience, not the sole record of what CI tested. `--collect-only -q` verifies how the current invocation interprets paths and markers.

## Organize suites by speed and dependency

A useful structure often separates `unit`, `integration`, and perhaps `e2e` directories, while keeping each test close to its relevant feature. The labels should reflect dependency and confidence boundaries. Unit tests run in-process with controlled collaborators; integration tests cross a real boundary such as a database driver or HTTP stack; end-to-end tests exercise a broader user-visible flow. The categories are not universal, so state the project's definition.

Default test selection should normally include the fast, deterministic checks. Slower suites can run in a separate CI job or on a schedule, but integration tests that protect a critical contract must still gate an appropriate deployment path. Do not mark a test slow merely because it is flaky or poorly controlled; fix unnecessary waiting and isolate nondeterminism.

A marker is not access control. Any developer or CI process can run a test without the marker selection you intended. If a test requires credentials or can mutate a real system, make the safety boundary explicit in fixture configuration and environment checks, and use isolated test accounts. A command such as `pytest -m integration` is not a guarantee that production cannot be touched.

## Expected failure and skip selection

`skipif` and `xfail` are markers but communicate different semantics. A skip says the test is not applicable or cannot run under this condition; xfail says the behavior is expected to fail and should be reviewed. Include a reason, and make expected failures strict where appropriate. Skipped tests should be visible in the summary (`-ra`) and should not accumulate without owners or removal conditions.

Use `pytest -rA` to show all non-passing test reasons, including pass, skip, xfail, and xpass categories; `-ra` is a concise default for extra summaries. Avoid quiet flags so aggressive that CI hides the distinction between skip and pass. For CI, JUnit XML (`--junitxml=...`) can feed reports, but verify the report artifact is retained even when pytest exits nonzero.

## Common mistakes

- Using a custom marker without registering or documenting it.
- Assuming a marker automatically provisions, skips, or isolates external dependencies.
- Relying on `-k` when exact test selection is needed and matching too many cases.
- Excluding slow or integration tests from every required CI path.
- Treating `--lf` as deterministic CI selection or as a substitute for a complete run.

## Production notes

Make test categories map to actual workflows: a quick command for local feedback, a full required CI gate, and clearly owned scheduled or environment-specific suites. Show collection and deselection summaries in CI so an accidentally empty suite fails visibly. If test selection is complicated enough that contributors need tribal knowledge, simplify the marker vocabulary and publish copyable commands in the repository's contributor documentation.

## Selection policy and safety

Marker filters are command-line policy, not guarantees about test safety. A test that can delete data
or send a real email must protect itself in its fixtures: require an explicit test endpoint, validate
the target, and use disposable credentials. A marker such as `destructive` can prevent accidental
selection in common commands, but a direct node-ID invocation can bypass the normal filter. Fail
closed when required safety configuration is absent.

For required CI suites, make their collection result visible. A job that runs `pytest -m
integration` can exit successfully with no selected tests if the marker was renamed or registration
was broken. Check collection counts, use a dedicated test path, or add a small policy check that
asserts expected categories are represented. Avoid fragile hard-coded counts when normal test
changes are frequent; a lower bound or explicit sentinel test may be more maintainable.

The pytest cache powers conveniences such as last-failed selection and may also be used by plugins.
Treat it as disposable local state, not as a durable CI database. If CI caches it, stale node IDs
can create confusing behavior; clear or isolate caches when diagnosing selection anomalies. For
incident triage, record the exact command and resulting node IDs so another engineer can reproduce
what was and was not run.

## Marker inheritance and review

Markers applied to a class or module are inherited by contained test items, while parameter-set
marks can distinguish individual cases. This lets a file group related integration tests without
copying a decorator onto every function. Be careful when combining marks: the selection expression
can match any attached mark, so a test carrying both `integration` and `slow` may be selected by
`-m integration` even if the quick path excludes slow tests separately. Verify the combined policy
with collection output rather than reasoning from one decorator in isolation.

When renaming a marker, update configuration, test annotations, CI commands, and contributor
documentation together. Unknown marker warnings should be treated as configuration defects. A
short periodic audit of registered markers reveals obsolete categories and tests that no workflow
runs. Remove unused markers instead of preserving a large taxonomy that no one understands.
