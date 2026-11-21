# Headless Browsers and Containers

Headless mode runs a browser without a visible desktop window. It is useful for CI, remote workers, and repeatable tests, but it is still a real browser with rendering, JavaScript, network and resource behavior. Headless should not be treated as a separate correctness mode that magically fixes test design.

## Configure the browser deliberately

With Selenium Python, browser options carry command-line arguments and other startup preferences. Chrome's headless option is commonly enabled with `--headless`; browser-specific options should stay with the browser they configure.

```python
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

options = Options()
options.add_argument("--headless")
options.add_argument("--window-size=1440,1000")
driver = webdriver.Chrome(options=options)
```

An explicit window size reduces surprises in responsive layouts and screenshots. Headless rendering can still differ from a developer's desktop because of fonts, device scale, graphics libraries, locale, time zone, viewport, and browser version. Set only what the test needs, and make relevant environment values consistent between local and CI runs.

## Browser installation and images

A container needs the browser, compatible runtime libraries, fonts, certificates, and a usable driver strategy. A Python package alone does not install every OS dependency required by Chrome or Firefox. Selenium Manager may resolve a driver, but an image that has no network access or lacks the browser binary still needs provisioning. For reproducibility, pin a maintained browser image or a deliberate package version and rebuild it regularly for security updates.

Selenium's official Docker images provide browser and Grid components. Use a known image tag rather than `latest` for release pipelines, and read that image's published requirements for shared memory, architecture and supported capabilities. Container flags are environment-dependent: for example, increasing `/dev/shm` can prevent browser crashes in constrained Docker defaults, but blindly adding privileged mode or disabling sandbox protections is not a safe general fix. Configure container security according to the runner threat model.

## Resource and lifecycle management

Browsers are heavyweight processes. Set a sensible number of concurrent sessions per worker, and ensure `driver.quit()` runs even when test setup fails. Leaked sessions can exhaust memory, file descriptors or Grid slots and create intermittent failures in later tests. Containers also need a bounded timeout and cleanup policy so hung browser processes do not survive indefinitely.

Downloads require special planning. Configure a browser download directory, make it unique per test or worker, and wait for a completed file rather than checking immediately after clicking. Chrome may write a temporary extension while downloading; confirm completion through stable filesystem checks and known download behavior. Remote execution complicates access: the downloaded file may live on the node, not the Python client. Selenium Grid has managed-download capabilities in supported configurations, but verify the Grid and client versions and use the supported transfer mechanism rather than assuming a shared filesystem.

## Debugging headless-only failures

When a test fails only in headless mode, capture a screenshot and browser console or driver logs before changing timeouts. Check viewport-dependent layout, font availability, GPU/rendering settings, permissions, browser version and network policy. Reproduce with the same container image locally if possible. A screenshot can show that a cookie banner or responsive menu covers the target; a log can reveal a browser crash or blocked resource.

Avoid asserting exact pixels unless visual fidelity is the requirement. For ordinary UI tests, assert semantic state—visible text, enabled controls, navigation result—and use screenshots as evidence. If browser policy or a certificate is wrong, fix the environment deliberately instead of disabling security checks in the application under test.

## Common mistakes

- Assuming headless mode removes the need for a display size or consistent browser version.
- Installing Selenium but not the browser's OS dependencies in the image.
- Using mutable image tags that silently change the browser under the test suite.
- Running too many sessions for the container's CPU and memory limits.
- Fixing every startup failure by using privileged containers or disabling sandboxing.
- Looking for a remote download on the client machine when it remains on the Grid node.

## Production notes

A browser container is production infrastructure for your tests. Pin and patch the image, minimize installed packages, avoid secrets in image layers, and use non-root execution where supported. Store only necessary artifacts and give them retention limits. Log the image digest or tag, browser version, session capabilities and CI worker identity. Keep an inexpensive smoke test for driver startup and a representative page interaction.

## Browser profiles and permissions

A browser profile stores more than window preferences: cookies, local storage, cache, extensions and permissions can all affect the result. A clean, temporary profile makes each test more independent and prevents one run's authentication or consent state from leaking into another. If a workflow needs seeded state, create it explicitly through an approved test setup, not by reusing a developer's profile directory. Concurrent sessions must not share one profile path because browser processes can contend over locks and corrupt state.

Container permissions are another hidden source of local/CI differences. Downloads may be denied or written to a directory the browser user cannot access. Certificates and system trust stores can differ from the host. Verify the actual process user, writable directories and network trust configuration inside the running image. Do not solve a certificate problem by disabling verification in the application or by accepting every certificate globally; repair the test environment's trust configuration.

## Keep images supportable

A browser image should have an owner, update cadence, and a tested change process. Record its digest in CI output and rebuild on a predictable schedule for browser and operating-system security updates. Run a representative smoke suite whenever it changes, including a download if the product depends on one. Cache image layers for speed, but do not bake credentials into them. Keep browser logs and crash dumps bounded so repeated failures do not fill ephemeral storage.

## Choose container size from measurements

Browser concurrency should be based on observed memory and CPU per session, not the host's advertised core count. Run a representative peak workload and watch for out-of-memory kills, renderer crashes and long garbage-collection or scheduling pauses. A larger worker pool can reduce throughput if all sessions compete for scarce memory or backend capacity. Separate browser node sizing from test-runner sizing when they scale differently, and set resource requests and limits that match measured behavior. If a runner is killed, inspect container and node events before attributing the failure to a Selenium command.

Headless execution is valuable because it is automatable, not because it is inherently more stable. A controlled image and explicit lifecycle make it repeatable; observability and a minimal security posture make it supportable. When local and CI conditions differ, make the difference visible and reproduce it before adding workarounds.