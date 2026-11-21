# Locators, Semantics and Strict Mode

A locator is a query that describes an element in the page. It is not merely a saved pointer to a DOM node: Playwright resolves it when an action or assertion runs, so it can survive routine re-rendering. Locator quality determines whether a test expresses the same contract a user experiences or depends on incidental implementation details.

## Start with the user's vocabulary

For interactive controls, prefer accessible roles and names:

```python
from playwright.sync_api import expect

save = page.get_by_role("button", name="Save changes")
save.click()
expect(page.get_by_role("status")).to_have_text("Saved")
```

`get_by_role` uses the accessibility role and accessible name, not just a tag name. It therefore reflects whether a control is exposed meaningfully to assistive technology and whether its label is understandable. A `button` with no accessible name may be technically clickable but poor for users; a role-based locator makes that gap visible.

Other user-oriented methods include `get_by_label()` for form controls, `get_by_placeholder()` when placeholder text is the intended affordance, `get_by_text()` for visible text, and `get_by_test_id()` for a stable explicit test hook. A good preference order is role/name, label, visible text, then a dedicated test id where semantics are insufficient. Test IDs are legitimate contracts, but sprinkling them everywhere can couple tests to implementation rather than behavior.

CSS and XPath are available through `locator()`, but selectors like `.page > div:nth-child(3) button` encode structure that often changes during harmless redesigns. Use them when structure itself is what you are verifying, not as a default shortcut. Avoid selectors that depend on generated class names or framework internals.

## Strict mode is useful feedback

Most single-element actions and assertions require a locator to match exactly one element. If a query matches two buttons named “Delete,” Playwright reports a strict-mode violation rather than picking an arbitrary match. That failure is valuable: ambiguity is a real property of the page and may be a usability bug.

Narrow the locator using a meaningful region or relationship:

```python
row = page.get_by_role("row").filter(has_text="Invoice 1042")
row.get_by_role("button", name="Delete").click()
```

A locator can be composed with `locator()`, `filter(has_text=...)`, `filter(has=...)`, `get_by_role()` and other locator methods. This describes the target in context and remains readable. If the product intentionally has duplicate names, scope to a dialog, row, card or landmark with a stable role and label.

`first`, `last` and `nth()` are available, but positional choice is brittle when order changes. Use them only when position is part of the requirement, and assert the relevant count or ordering. Do not use `.first` merely to silence strict mode: it converts an explicit failure into a potentially wrong click.

## Dynamic collections and relationships

For repeated items, locate by content and then act within the item. For example, find the list item containing a project title, then find its menu button. The `filter(has=...)` option lets a parent locator be selected by a child locator, which is useful when text alone is ambiguous. Keep the nested relation semantically accurate: a filter's `has` locator must be evaluated relative to the candidate element, not the whole page.

`locator.count()` is an immediate snapshot, not a retrying assertion. If an element is expected to appear eventually, assert with `expect(locator).to_have_count(n)`. The assertion retries; a count call does not. Likewise, do not query a locator, wait arbitrarily, and then assume the result stayed valid. Prefer assertions over extracting intermediate state when the test's intent is simply “this item appears.”

For inputs, `fill()` replaces the value and dispatches input events as appropriate; `press()` sends a key; `check()` and `uncheck()` model checkbox state and wait for it. Choose actions that correspond to the behavior. Typing character by character can be appropriate for autocomplete or keyboard interaction, but `fill()` is clearer for ordinary form entry.

## Frames, shadow DOM and text

A page locator operates in the main frame unless you explicitly use `frame_locator()`. Cross-origin iframes are still automatable through the frame boundary supported by the browser, but the iframe must be located and addressed intentionally. Playwright locators can pierce open shadow DOM for many selector types; XPath does not pierce shadow roots. Closed shadow roots are not generally available as normal DOM descendants, so test the accessible surface or request a supported test hook.

Text matching can be exact or substring-based. Text normalization and accessible-name computation can surprise tests with whitespace, nested labels or hidden content. If exact wording is important, use `exact=True` or assert the full expected text. If only a message's presence matters, avoid encoding punctuation and layout whitespace that the user contract does not require.

## Common mistakes

- Using `page.locator("text=...")` or brittle CSS when a role and accessible name express intent better.
- Fixing strict-mode errors by selecting `.first` without establishing why the first match is correct.
- Assuming a locator is a frozen element handle; it is a query resolved at action time.
- Calling `count()` and expecting it to wait for a future render.
- Using placeholder text as the only accessible label for a form field.

## Production notes

Treat locator failures as product feedback as well as test feedback. A control that cannot be named uniquely may be difficult for both automation and assistive technology. Keep the locator close to the action and use meaningful scopes for repeated components. If a selector must be changed after a redesign, semantic locators often reduce maintenance because they assert what the control does, not how its DOM happens to be assembled.

## Locator composition without ambiguity

A locator chain is evaluated relative to the element selected by the preceding part. That property makes it possible to express relationships cleanly: first find a dialog by its accessible name, then locate the confirmation button inside it. `filter(has_text=...)` can narrow repeated cards, while `filter(has=...)` can test for a nested child locator. Keep these scopes conceptually aligned with the UI. A global “contains text” query may match hidden template content or a second copy of the same label in a navigation panel.

When text is dynamic, decide which portion is contractual. A status message may include an order number, so a substring assertion can be reasonable; a product title may need an exact assertion. Avoid building a locator with a regular expression that accepts almost anything just to accommodate formatting differences. If text is localized, tests should either run under a deliberate locale or use stable semantic identifiers rather than hard-coded English.

For a collection, assert the count before relying on order, and assert order only when the feature promises an ordering. For example, a sorted table can be checked by reading its row labels and comparing them to the expected sequence. If order is irrelevant, test membership rather than using `nth()`. Positional selectors are not inherently wrong, but they should correspond to a requirement, such as “the second step in a wizard,” instead of incidental render order.

## Accessibility as locator strategy

Role queries use the accessibility tree's concept of role and accessible name, which can be affected by labels, `aria-label`, `aria-labelledby` and associated form labels. A role query failing may indicate that the element is absent, the accessible name differs from expectation, or the role is not exposed as assumed. Inspect the DOM and accessibility behavior to fix the underlying issue rather than changing to a fragile selector immediately. This approach gives automation a useful connection to accessibility review, though it does not replace dedicated accessibility testing.