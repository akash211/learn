# Waits, Synchronisation and Flakiness

A browser command and the page's response to that command happen on different schedules. Clicking a link may start navigation; submitting a form may trigger an asynchronous request; a framework may replace a node after rendering. A test that assumes the next state exists immediately races the application. Fixed sleeps appear to solve the race, but mostly move it around.

## Implicit waits

`driver.implicitly_wait(seconds)` sets a session-wide timeout for element-location calls. When a lookup finds no element, the driver polls until it appears or the timeout expires. It can reduce immediate lookup failures in simple suites, but it applies broadly and gives little control over which state the test needs.

Implicit waits do not mean “wait for the page to be ready.” They do not wait for an element to be clickable, for an animation to end, or for application data to finish loading if the target element already exists. A lookup that returns an early placeholder can still lead to a failure on the next action.

## Explicit waits and expected conditions

`WebDriverWait` polls a condition until it returns a truthy value or a timeout occurs. `expected_conditions` (`EC`) provides common conditions such as presence, visibility, clickability, staleness, alert presence, and a title containing text.

```python
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

wait = WebDriverWait(driver, 10)
submit = wait.until(
    EC.element_to_be_clickable((By.CSS_SELECTOR, "button[type='submit']"))
)
submit.click()
wait.until(EC.visibility_of_element_located((By.ID, "confirmation")))
```

Choose the condition that matches the next operation. `presence_of_element_located` means the node exists in the DOM; it may be hidden. `visibility_of_element_located` additionally checks visibility and non-zero dimensions. `element_to_be_clickable` checks visibility and enabled state, but cannot guarantee an overlay will not intercept a click one millisecond later. A wait is synchronization, not a promise that all future work will succeed.

Wait for a result after the action, not merely before it. To test a successful save, wait for a visible confirmation or for the form to transition to its expected state. A `staleness_of(old_element)` condition is useful when an interaction is expected to replace a node. Avoid waiting on a generic `document.readyState` as the only condition: many modern pages continue fetching and rendering after the initial document load.

## Fluent waits and custom predicates

In Selenium Python, `WebDriverWait` accepts a polling frequency and an `ignored_exceptions` tuple, allowing a fluent-wait style of configuration. The conceptual distinction in many tutorials is that a fluent wait customizes polling and ignored exceptions; the Python API commonly implements that customization on `WebDriverWait` rather than requiring a separate `FluentWait` class.

A custom predicate can encode a domain-specific readiness condition:

```python
def results_loaded(driver):
    rows = driver.find_elements(By.CSS_SELECTOR, "[data-testid='result-row']")
    busy = driver.find_elements(By.CSS_SELECTOR, "[aria-busy='true']")
    return rows if rows and not busy else False

rows = WebDriverWait(driver, 15, poll_frequency=0.25).until(results_loaded)
```

Predicates should be quick, repeatable and safe to evaluate multiple times. Do not make them click buttons or submit forms; polling would repeat the side effect. Keep ignored exceptions narrow. Ignoring `NoSuchElementException` can be appropriate for a presence predicate, but ignoring all exceptions can turn a real programming or session error into a confusing timeout.

## Do not mix implicit and explicit waits casually

Combining implicit and explicit waits can produce longer and less predictable delays because each poll of an explicit condition may itself wait during element lookup. The simple policy for most suites is to leave implicit wait at zero and use explicit waits around state transitions. If a project deliberately chooses otherwise, measure and document the timing behavior rather than assuming timeouts add neatly.

## Why fixed sleeps are flaky

`time.sleep(2)` always waits two seconds. If the server takes three seconds, the test fails; if it takes 100 ms, the test wastes 1.9 seconds. Network variance, CPU load, animations, and CI contention ensure that a sleep selected from a local run is not a dependable readiness signal. A sleep can be appropriate for a known external throttle or a debugging experiment, but not as the primary synchronization strategy.

## Common mistakes

- Waiting for presence and then assuming the element is visible or enabled.
- Waiting before a click but never asserting the resulting state.
- Retrying the same click after a timeout without checking whether the first click succeeded.
- Ignoring `StaleElementReferenceException` globally instead of locating the replacement node.
- Setting a large implicit timeout and then wrapping every action in a second long wait.
- Waiting for `sleep` duration based on a fast local machine.

## Production notes

Use short, condition-specific timeouts with useful failure messages and preserve the timeout exception's context. A page that never becomes ready is a product, network, or test problem to diagnose—not evidence that every wait should be doubled. For slow backends, choose a timeout consistent with a service-level expectation and collect timing data. Make waits local to transitions so their purpose is visible in code review.

## Choosing timeouts and polling

A timeout should reflect the slowest acceptable response for that interaction, not serve as a way to conceal a hanging page. A short, focused wait around a normal transition gives a useful failure point; one enormous timeout across the whole suite delays diagnosis and often hides the step that stalled. Poll frequency is a trade-off: very frequent remote polling can add load and network chatter, while very slow polling increases detection delay. The default is usually adequate; customize it only after observing a real need.

When a wait fails, report the condition in domain terms. “Expected search results to appear within 10 seconds” is more useful than a bare timeout. Include enough state to distinguish an empty result set from a missing container or a still-busy page. Do not put an action inside a wait predicate: since it is repeatedly called, a click or submit could be sent multiple times. Predicates should read state and return either a useful truthy value or false.

## Navigation strategy

WebDriver page-load strategies govern when navigation commands return relative to document readiness, but they are not application synchronization. A page may set a document state while still fetching data, and a single-page application may change route without a full navigation. Configure a non-default strategy only when its trade-offs are understood, then wait for the page-specific signal that matters. Avoid polling a condition that only reflects a browser lifecycle event if the actual assertion depends on a later application request.

The practical rule is to wait for evidence. Locate a form control when it is actionable, interact once, then wait for the state that proves the action had the intended effect. This aligns the test with observable behavior and makes timing failures explainable.

When debugging, note the elapsed time and condition that timed out; a longer timeout is justified only when the expected product response legitimately takes longer.