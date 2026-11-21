# CI, Containers and Selenium Migration

A browser suite that works only on a developer laptop is not reproducible. Continuous integration needs a compatible Python package, the matching Playwright browser binaries, operating-system libraries, predictable test data and enough resources for the chosen worker count. Treat those pieces as one versioned environment rather than debugging a missing-browser error after every dependency update.

## Install the package and browsers

The `playwright` Python package contains the API and driver integration; browser binaries are installed separately with the Playwright CLI. A normal setup pins the Python dependency, then runs `playwright install` for the engines required by the suite. On Linux images, `playwright install --with-deps` can install supported browser system dependencies where the environment permits package-manager changes. Keep the Playwright package and browser versions aligned by installing browsers from the same pinned environment.

Install only the engines you use in CI to reduce image size and setup time. A test matrix that covers Chromium, Firefox and WebKit must install each required engine. Browser caches can speed up jobs, but cache keys should include operating system and Playwright version; using binaries from a mismatched version can fail in confusing ways. The official Playwright container images provide browsers and dependencies for specific releases, but the image tag still needs to match the project's package version. Read the image documentation and pin a version or digest according to the team's update policy.

Containers need writable locations for browser profiles, temporary files and downloaded artifacts. Run as a non-root user where practical. Browser sandbox settings and shared memory requirements differ by environment; do not copy a permissive launch flag from an unrelated CI example without understanding the security effect. Give the container sufficient `/dev/shm` or configure the environment deliberately when Chromium crashes under load.

## Make CI deterministic

Pin Python, pytest, pytest-playwright and Playwright. Install the required browser binaries during image build or an explicit setup step. Use synthetic test data, stable URLs, explicit locale and viewport when relevant, and a base URL configuration that points to a controlled test deployment. Set timeouts with CI latency in mind but keep them bounded. Emit test reports and collect traces or screenshots on failure, with artifact retention and access controls.

Parallelism is a resource decision: a container with a small memory limit may fail with fewer browsers than a laptop. Set xdist workers deliberately, monitor memory and CPU, and separate environment failures from application assertions. Avoid using an unconstrained `--workers auto` in a tightly limited runner. If tests access a shared staging environment, cap concurrency and ensure they do not mutate shared customer-like data.

A useful CI split is fast unit and component tests on every change, followed by a focused browser smoke suite and broader cross-browser jobs according to risk. Keep the stage that gives developers rapid feedback short. Publish enough diagnostics to reproduce a failure locally, including the exact browser and package versions.

## Selenium comparison for migration

Selenium is based on the WebDriver protocol and has a broad ecosystem, language support and established remote Grid deployments. Playwright offers its own automation protocol, browser-managed installation, contexts, auto-waiting locators and integrated tracing. These are different trade-offs, not a universal speed ranking. Selenium may be the better choice when a team depends on WebDriver-compatible infrastructure, language bindings outside Playwright's supported set or a mature Grid. Playwright may fit well when its browser support, Python API, context isolation and debugging workflow match the project.

Inventory before migrating: languages, browsers and versions, remote execution, test reports, custom capabilities, downloads, authentication, mobile emulation, grids, CI constraints and existing test ownership. Select a representative test with realistic selectors, waits, fixtures and artifact requirements. Port it and compare maintenance cost, observability, resource use and coverage—not just lines of code or one benchmark.

A migration should be incremental. Keep both suites runnable while translating high-value flows, avoid rewriting every test before proving the infrastructure, and define a criterion for removing old coverage. Selenium concepts such as a WebDriver session and explicit waits do not map one-to-one to Playwright's browser/context/page model. Rework the test around Playwright's locator and auto-wait semantics rather than mechanically replacing method names. Avoid mixing two automation stacks in one test unless a transition has a clear boundary.

## Common mistakes

- Installing a Playwright package version that does not match the cached browser binaries.
- Assuming a container image eliminates the need to pin versions or collect artifacts.
- Running too many browser workers for the container's memory and shared resources.
- Disabling browser security constraints without understanding the threat model.
- Migrating by translating selectors line-by-line and preserving Selenium's wait workarounds.

## Production notes

Build CI images reproducibly and update browser versions intentionally. Validate startup with a small smoke test that launches the target engine and loads a controlled page. Capture traces on failure and test artifact handling for sensitive information. For migration, compare capabilities and operating costs with a representative slice, then move in stages. Keep Selenium if it remains the right fit; choosing Playwright is a technical decision, not a goal in itself.

## Container security and artifact hygiene

Browser containers execute complex native software and should run with the least privilege compatible with the environment. Avoid disabling browser sandboxing or running privileged containers as a blanket workaround for launch failures. Diagnose the container's user, capabilities, shared memory and dependency setup, then choose a supported configuration. The test target should be controlled; do not mount production secrets or broad host directories into a browser worker that only needs test artifacts.

Trace, video, screenshot and download files can contain sensitive page content. Store them outside public build logs, use restricted access and set retention. Remove temporary downloads and auth state after the job. When testing uploads, use checked-in synthetic fixtures. CI secrets should be injected at runtime and not printed as command-line arguments or debug logs. A container image gives reproducibility, not automatic confidentiality.

## Establish a release gate

A browser upgrade or migration should have a small gate before the full suite: install the engine, launch it, navigate to a controlled page, perform one interaction and collect a trace from an intentional failure. This catches packaging and artifact issues early. Then run a representative cross-browser subset, followed by the full suite in staged parallelism. Track baseline duration, flake rate and resource use so regressions are visible.

For Selenium migration, map each old test to a user outcome and mark whether it is still required. A coverage matrix can track browser engines and critical workflows across old and new suites. Do not count translated test files alone as parity: confirm equivalent assertions, permissions and failure states. Retire old tests only after their intended behavior is covered and the new suite has run reliably in CI for an agreed period. This keeps tool choice subordinate to product coverage and operational evidence.