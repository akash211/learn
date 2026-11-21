# conftest.py, Plugins, and Test Layout

A test suite's directory structure is an interface: it controls discovery, fixture visibility, imports, and the boundary between fast tests and environment-dependent tests. Pytest offers flexible conventions, but flexibility can turn into accidental coupling if fixtures and configuration appear from distant directories without being visible to readers.

## Where conftest.py fits

A `conftest.py` file is a local plugin automatically discovered by pytest for the directory tree beneath it. Fixtures declared there can be requested by name by tests in that subtree; tests do not import `conftest.py` directly. A root `conftest.py` is visible across the suite, while a nested one can specialize a package or integration area.

```text
tests/
  conftest.py              # shared lightweight fixtures
  unit/
    test_pricing.py
  integration/
    conftest.py            # database/service fixtures only here
    test_orders.py
```

This layout keeps heavyweight fixtures out of tests that do not need them. Avoid putting every fixture in the root file: visibility is convenient but makes fixture names collide and encourages hidden dependencies. Put a fixture near the tests that use it, then move it upward only when reuse is real. The same principle applies to helper modules: unlike fixtures in conftest, helpers are ordinary Python and should be imported from a stable package path.

Pytest finds conftest files based on the collected test's directory context. A test under a nested subtree can see parent conftest fixtures; a sibling tree does not see the nested file. This explains why running one file directly can behave differently from running tests under a different root or with a different invocation. Use the intended project root and inspect fixture lookup when a fixture unexpectedly disappears.

Do not call fixtures as functions or import them from conftest. If setup logic is also useful to production code, extract a normal helper in an application or test-support module, and have the fixture call it. This keeps pytest lifecycle management separate from reusable logic.

## Plugins and configuration

Plugins register hooks, fixtures, command-line options, and reporting behavior. Built-in functionality is part of pytest; external plugins must be installed and enabled in the environment. Common examples include `pytest-cov` for coverage.py integration, `pytest-xdist` for parallel execution, `pytest-asyncio` or `anyio` for async tests, and `pytest-randomly` for randomized order. `responses` is a separate HTTP mocking library, not a pytest plugin by itself, though it provides a context manager/decorator that works in tests.

Configuration can live in `pyproject.toml` under `[tool.pytest.ini_options]`, or supported pytest configuration files such as `pytest.ini` or `tox.ini`. Choose one authoritative file and avoid conflicting settings. `addopts` is useful for defaults like `-ra`, but hidden global flags can surprise contributors and CI. Register custom markers in configuration to avoid unknown-marker warnings:

```toml
[tool.pytest.ini_options]
addopts = "-ra"
testpaths = ["tests"]
markers = [
  "integration: requires external services or containers",
  "slow: longer-running test excluded from quick feedback",
]
```

The `pytest_plugins` variable can load a plugin from a conftest or test module, but plugin loading in a non-root conftest has restrictions and may fail after initial configuration. Prefer declaring installed plugins in the environment and letting entry-point discovery load them. For optional dependencies, use explicit setup documentation or guarded imports with a clear skip, rather than mysterious import errors during collection.

Hooks such as `pytest_collection_modifyitems` can implement suite-wide policy, but they are extension points with lifecycle implications. Before writing a hook, check if built-in marker selection or an existing plugin already expresses the need. Keep custom hooks small, documented, and tested as framework code.

## Import and package layout

A common arrangement is `src/` for the application package and `tests/` at the repository root. Tests should import the installed package in editable mode or use a configured import path; they should not mutate `sys.path` in each test module. Running `python -m pytest` can differ from invoking the `pytest` console script because Python module execution includes the current directory on `sys.path`. Use one standard invocation in docs and CI, and ensure packaging configuration is correct rather than relying on an accidental import path.

Tests can live alongside code or in a centralized tree. Co-located tests make ownership clear in some libraries; a centralized tree is often easier for integration environments and package-level conventions. The critical property is repeatable collection and imports from a clean checkout, not the specific directory shape. Use `pytest --collect-only -q` to inspect the collected node IDs.

## Common mistakes

- Importing `conftest.py` as a module, which can load a different copy or bypass fixture resolution.
- Keeping all fixtures at repository root, creating a global fixture namespace and hiding resource costs.
- Loading plugins implicitly from a developer's global Python environment but not declaring project dependencies.
- Customizing `sys.path` in test modules instead of fixing package installation and invocation.
- Defining hooks for behavior pytest's built-in flags already support.

## Production notes

Review fixture visibility as you review module imports: ask whether a test's dependencies are local and understandable. Run collection from the repository root in a clean project environment, and verify optional plugin versions explicitly when they affect semantics. Put shared policy in configuration, specific resources in narrow conftest files, and application logic in ordinary importable modules. That separation makes the suite portable across editors, local shells, and CI runners.

## Import mode and repeatable collection

Pytest's import behavior can depend on whether test directories are packages, the selected import
mode, and how the command is invoked. Prefer a project configuration that is stable in the clean
checkout, and avoid duplicate module basenames if the tests are imported as top-level modules. A
`src` layout with an installed package often prevents tests from accidentally importing a source
copy merely because the working directory happens to be the repository root. Choose and document
one invocation, commonly `python -m pytest` or the installed `pytest` command, then use it in CI
and contributor instructions consistently.

Collection itself executes Python imports and plugin hooks. If collection unexpectedly hangs,
look for work performed during module import, plugin startup, or custom collection hooks. If a
plugin is missing, pytest may raise an import or unknown-option error before it can run tests. A
fresh environment is therefore a useful test of packaging and configuration, not just a deployment
formality. Keep optional dependencies in clearly named extras or CI groups and explain whether
missing dependencies should skip an optional suite or fail a required one.

Treat hooks as shared infrastructure code. A hook that mutates `items` can silently deselect or
reorder tests for every contributor. If selection policy is necessary, unit-test the hook or use
built-in markers and flags. Keep marker registration near pytest settings so editors, local runs,
and CI see the same vocabulary. Review plugin upgrades by collecting a representative subset and
checking warnings, node IDs, and fixture setup before broad rollout.
