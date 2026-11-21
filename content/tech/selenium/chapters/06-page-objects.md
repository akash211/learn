# Page Objects and Framework Structure

A Selenium suite begins as a few commands and quickly becomes difficult to maintain if every test repeats selectors, waits and navigation steps. A page-object pattern moves page-specific mechanics behind a small interface. Tests can then express a user journey in terms of the behavior they care about, while one class owns the details of locating and operating the page.

## What belongs in a page object

A page object commonly holds the driver and exposes operations or state that make sense for the page: opening a known route, filling a search form, submitting it, and reading the displayed results. It should not duplicate the entire DOM as a giant set of getters. A useful object hides volatile selectors and synchronizes where page transitions occur, but it keeps assertions about business outcomes in the test unless the team has a clear reason to centralize them.

```python
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

class LoginPage:
    def __init__(self, driver):
        self.driver = driver
        self.wait = WebDriverWait(driver, 10)

    def sign_in(self, username, password):
        self.wait.until(EC.visibility_of_element_located((By.ID, "username"))).send_keys(username)
        self.driver.find_element(By.ID, "password").send_keys(password)
        self.driver.find_element(By.CSS_SELECTOR, "button[type='submit']").click()
        return AccountPage(self.driver)
```

Returning the destination page can make transitions explicit, but it should not imply success before the destination is ready. The destination object's constructor should usually be cheap; wait for a meaningful condition in its method or a dedicated readiness assertion. Otherwise, an object can be created while the browser remains on the old page.

## Page, component and test responsibilities

A page object represents a page or meaningful state boundary. Reusable widgets—navigation, date picker, modal, table—may be component objects scoped to a root element. Tests own scenarios, fixtures, expected outcomes and data. This division limits duplication without creating a second application framework.

Use pytest fixtures to create and tear down one driver per test or per deliberate isolation boundary. Function-scoped sessions are slower but reduce hidden state and make failures easier to reproduce. If session reuse is needed for performance, reset storage, cookies, tabs and test data explicitly. Never share a single WebDriver concurrently across test threads: commands can interleave and switch browser state unexpectedly.

## Structure that scales

A modest Python project can separate `pages/`, reusable components, fixtures, test data, and tests. Keep configuration such as base URL, browser choice, and timeouts centralized, and pass it into the driver factory. Avoid importing application-specific environment configuration into every page object. Tests should run against controlled environments and should not embed production credentials.

```text
tests/
  conftest.py
  test_checkout.py
pages/
  login.py
  catalog.py
components/
  navigation.py
```

Name methods for user-observable actions (`search_for`, `add_item`) rather than raw mechanical steps (`click_button_3`). If a method has a broad side effect, make it explicit. Avoid `click()` wrappers that accept arbitrary selectors from every test; they re-expose the low-level implementation and defeat the abstraction.

## Assertion boundaries

A page object can expose `is_loaded()` or a specific result value, but the test should generally state why that result matters. A method like `assert_user_is_admin()` hides the expectation and makes a reusable page object encode a particular scenario. Some teams prefer assertion methods for a consistent framework; whichever style is chosen, keep the rule consistent and ensure failure messages identify the expected state and relevant page.

Do not return raw `WebElement` objects broadly. They are tied to a live page and can become stale after re-rendering. If a test needs a low-level inspection for an unusual case, a narrow escape hatch is acceptable, but it should not become the routine API.

## Common mistakes

- One enormous `BasePage` that contains selectors and behavior for every page.
- Page objects that expose every element but provide no meaningful abstraction.
- Returning a destination page before waiting for its defining state.
- Putting every assertion in a page class, making scenario intent hard to see.
- Sharing a browser driver across tests that run in parallel.
- Building a generic click DSL that hides locators but not coupling.

## Production notes

Refactor only when duplication makes change expensive. A suite with a few stable tests may need only fixtures and small helpers. When the UI changes, a page object should concentrate repair to a component boundary; if a single selector change requires edits in dozens of tests, the abstraction is too thin. Conversely, if changing one page method changes unrelated workflows, the object likely owns too much.

Tag or organize tests around stable capabilities—critical paths, browser compatibility, or a slower smoke set—rather than layering many custom test frameworks on pytest. Keep fixture scope, test data cleanup, and driver ownership visible. Add artifacts and timeouts through shared fixtures so each test gets the same diagnostics.

## Test data and configuration boundaries

A page class should not decide which production account, tenant, or backend record a test uses. Supply test data from fixtures or factories and pass values into page operations. That makes cases repeatable and prevents UI helpers from depending on global environment variables. Likewise, the browser factory should own options, remote endpoints and headless configuration; page objects should not start additional browser sessions. A clear ownership graph makes teardown reliable and makes it easier to run the same tests locally or against Grid.

When a workflow spans several pages, keep each page focused and let a test or a small journey-level helper orchestrate the sequence. Avoid putting the entire purchase or onboarding scenario into a single page object; that couples it to every step and makes reuse difficult. If a repeated journey genuinely deserves an abstraction, name it for the business process and keep its assertions and side effects explicit. Tests should still make the critical outcome easy to read.

## Keep abstractions observable

Page-object methods should expose enough information for useful failure messages. A method that waits for a page transition can raise with the expected destination and current URL rather than translating every failure into “page not loaded.” Avoid generic exception handling that returns `None` or a false value for unrelated failures; that moves the error away from its cause. Use small return types when a workflow produces meaningful data, and keep browser state changes explicit in method names. When a method's behavior becomes hard to summarize in one sentence, split it into page-level actions and leave orchestration in the test.

Page objects are a maintenance technique, not a Selenium requirement. Their value is measured by how clearly tests communicate behavior and how cheaply UI changes are repaired. A small, explicit object model usually outlives an elaborate hierarchy of base classes, factories and mixins.

Review abstractions with a practical question: can a reader see the important user action and expected outcome without jumping through many layers? If not, simplify the method chain or move scenario-specific decisions back into the test. Clear ownership makes both failures and UI changes cheaper to understand.