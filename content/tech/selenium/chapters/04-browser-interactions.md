# Forms, Alerts, Frames and Windows

WebDriver models a browser session with a current browsing context. A page can contain ordinary inputs, native select controls, JavaScript dialogs, embedded frames, and multiple windows or tabs. Each interaction has a specific API and context. Many apparent Selenium mysteries are simply commands sent to the wrong context.

## Text fields, checkboxes and buttons

For standard controls, locate the element, wait for the appropriate state, interact, and verify the result. Use `clear()` before `send_keys()` when replacing a field value; do not assume typing overwrites existing content. For checkboxes and radio buttons, inspect `is_selected()` and click only when the current state differs from the desired state. That makes a helper idempotent and avoids toggling a correct value into the wrong one.

```python
email = driver.find_element(By.NAME, "email")
email.clear()
email.send_keys("person@example.test")

checkbox = driver.find_element(By.ID, "terms")
if not checkbox.is_selected():
    checkbox.click()
```

Modern custom controls may look like checkboxes but be implemented with buttons and ARIA attributes. Inspect the rendered semantics and use the interaction a user would use; `Select` only applies to the native HTML `<select>` element.

## Native dropdowns

Selenium's `Select` wrapper supports native select elements. It can select by visible text, value, or index, and inspect selected options. It will reject an element that is not a `<select>`.

```python
from selenium.webdriver.support.ui import Select

country = Select(driver.find_element(By.ID, "country"))
country.select_by_visible_text("Canada")
```

Use visible text or a stable value when possible. Index-based selection is fragile if the option order changes. For custom dropdown widgets, interact with the trigger, wait for the menu to appear, and select the intended option with a stable locator. Do not use JavaScript to mutate a control value merely to avoid the UI; that can bypass events and fail to test the behavior users depend on.

## JavaScript alerts, confirms and prompts

Native browser dialogs are not DOM elements. Switch to the alert, inspect its text if useful, and accept or dismiss it. Prompts can accept text with `send_keys` on the `Alert` object.

```python
from selenium.webdriver.support import expected_conditions as EC

alert = WebDriverWait(driver, 5).until(EC.alert_is_present())
message = alert.text
alert.accept()
```

Do not try `find_element` against alert text. A dialog that is not present causes an alert-related exception; a wait makes that expected state explicit. Determine whether the behavior under test is accept or dismiss, since those lead to different application paths.

## Frames

An iframe creates a separate document context. Before locating an element inside it, switch with `driver.switch_to.frame(...)`, using a frame element, name, or index. When finished, use `driver.switch_to.default_content()` to return to the top-level document, or `parent_frame()` to move one level outward.

```python
frame = driver.find_element(By.CSS_SELECTOR, "iframe.payment")
driver.switch_to.frame(frame)
try:
    driver.find_element(By.NAME, "postal_code").send_keys("M5V 1A1")
finally:
    driver.switch_to.default_content()
```

If an iframe is inserted asynchronously, wait for `frame_to_be_available_and_switch_to_it`. A frequent failure pattern is finding an iframe successfully but forgetting to switch, then receiving `NoSuchElementException` for a child element. Cross-origin browser security limits direct script access, but WebDriver's frame context is the appropriate automation mechanism when the browser allows the interaction.

## Multiple windows and tabs

`driver.current_window_handle` identifies the active window; `driver.window_handles` lists open handles. When a click opens a new tab, wait for the handle count to increase, switch to the new handle, and validate its URL or content. Do not assume the new window is always the second item in a list; ordering is not a robust identity contract.

```python
before = set(driver.window_handles)
driver.find_element(By.LINK_TEXT, "Open details").click()
WebDriverWait(driver, 10).until(
    lambda d: len(set(d.window_handles) - before) == 1
)
new_handle = (set(driver.window_handles) - before).pop()
driver.switch_to.window(new_handle)
```

After assertions, close the new window if appropriate and switch back to the original handle. Keep handle lifecycle explicit: closing the current window can leave the driver on another one, or end the session if none remain.

## Common mistakes

- Using `Select` on a custom dropdown or clicking a custom widget before its menu is ready.
- Calling `clear()` on a control that does not support text editing.
- Treating a native alert as an HTML element.
- Searching inside an iframe without switching into it, or forgetting to switch back.
- Assuming a new tab is active immediately after clicking a link.
- Using a fixed window-handle index and silently acting on the wrong page.

## Production notes

Encapsulate context changes so a helper always returns the driver to a known state, even when an assertion fails. When a frame or popup is involved, include current URL, window count and (where safe) the active context in failure diagnostics. Keep authentication and payment interactions confined to controlled test environments. Tests should verify the user-visible outcome and avoid exposing real personal data in screenshots or logs.

## Keyboard behavior and disabled controls

For many controls, `send_keys` models typing, but keyboard order and focus are part of the interaction too. Click or focus the intended element before sending keys when page behavior depends on focus. Use keyboard shortcuts only when the shortcut itself matters; otherwise type the content and verify the resulting field value. A disabled button can be present and visible while correctly rejecting interaction, so wait for the application's enabling condition rather than trying to force a click. If an element is obscured, inspect which overlay or modal owns focus instead of calling JavaScript to dispatch a click behind it.

Forms often reveal validation only after blur, submission, or a particular input event. Test the user path that triggers the rule and assert the visible error or corrected state. Directly setting an input's value property can skip events that a frontend framework listens for, producing a test that passes without reproducing a user's action. Keep form helpers focused on one interaction and let the test verify the result.

## Native versus custom browser dialogs

Only native JavaScript `alert`, `confirm`, and `prompt` dialogs use the WebDriver `Alert` interface. An application modal built with HTML remains part of the DOM: locate it, wait for its visible state, and interact with its buttons normally. This distinction explains why `switch_to.alert` fails on a visually similar custom modal, while `find_element` fails when a genuine native alert blocks the page. Identify which dialog type the application presents before selecting an API.

For file inputs, a common supported pattern is to send an absolute path to the `<input type='file'>` element instead of opening the operating system's native file picker. Keep the file fixture isolated and verify the application's upload result. Do not include real sensitive files in test data, and clean temporary files after the session.

The browser context is part of the test state. Treat switching into a frame or tab like entering a scope in a program: make the boundary explicit, perform the intended work, and restore the prior context predictably.