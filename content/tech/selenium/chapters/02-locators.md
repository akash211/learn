# Locators: CSS, XPath and Stable Identity

A locator is an executable description of how to find an element in the current document. Every click, assertion and form entry depends on finding the intended target at the right time. Locator quality therefore decides reliability: a selector that breaks when a designer changes layout creates noisy failures, while a selector that can match several controls can produce a convincing but incorrect test.

## The locator API

Selenium's Python API uses `By` strategies with `find_element` and `find_elements`:

```python
from selenium.webdriver.common.by import By

save = driver.find_element(By.CSS_SELECTOR, "button[data-testid='save']")
rows = driver.find_elements(By.CSS_SELECTOR, "table tbody tr")
```

`find_element` returns one matching element or raises `NoSuchElementException`. `find_elements` returns a list, including an empty list when there are no matches. That difference matters in assertions and wait predicates: an empty collection is not an exception. Prefer the explicit `By.ID`, `By.NAME`, `By.CSS_SELECTOR`, `By.XPATH`, and other `By` constants to ambiguous legacy string strategies.

A useful locator answers two questions: what uniquely identifies the control, and why is that identity stable? An application-owned `id`, accessible role/name exposed through a test hook, or deliberate `data-testid` is usually more stable than a generated CSS class or a node's position in a layout.

## CSS selectors for structural identity

CSS is concise and readable for IDs, classes, attributes, and relationships. Examples:

```python
By.ID, "email"
By.CSS_SELECTOR, "form#signup input[name='email']"
By.CSS_SELECTOR, "button[data-testid='submit-order']"
By.CSS_SELECTOR, "nav a[href='/account']"
```

Use a selector specific enough to distinguish the target, but not so detailed that harmless markup changes invalidate it. `div.page > div:nth-child(3) > button.primary` encodes layout rather than intent. A semantic attribute or stable test identifier decouples a test from CSS refactoring. Avoid selectors built from dynamic class hashes unless the application guarantees their stability.

CSS cannot select an element based on its text content in standard browser selector syntax. If the element has no stable attribute, XPath may express a text or ancestor relationship more naturally. Do not choose XPath just because it can express everything; expressive power also makes brittle selectors easy to write.

## XPath and context

XPath is useful when selecting by text, traversing ancestors, or relating elements through their structure. For example, a form label can help identify its associated input when markup is consistent:

```python
submit = driver.find_element(
    By.XPATH, "//button[normalize-space(.)='Continue']"
)
```

`//` searches descendants broadly; `.//` is relative to the current element. This distinction is important when a lookup should be scoped to a particular card or dialog. Use `normalize-space(.)` rather than an exact text comparison when markup may include whitespace or nested spans. XPath expressions must quote strings correctly; when the desired text includes both quote types, compose the XPath literal carefully rather than interpolating untrusted data.

XPath positional predicates are easy to misread: `[1]` is context-sensitive and does not always mean the first result of the entire expression. Prefer a clear stable relationship over a dense expression with several indices. If a selector needs to encode a long chain of ancestors, ask whether the application should expose a better test hook.

## Scope and uniqueness

A locator should normally match exactly one interactive control. Test that assumption during development:

```python
matches = driver.find_elements(By.CSS_SELECTOR, "button[data-testid='save']")
assert len(matches) == 1
```

For repeated structures, scope to a meaningful component rather than selecting the first global match:

```python
card = driver.find_element(By.CSS_SELECTOR, "article[data-order-id='A17']")
card.find_element(By.CSS_SELECTOR, "button.cancel").click()
```

The scope itself should be stable. If IDs are dynamic, identify the record using its displayed business key, then locate the action within that record. Avoid `find_elements(...)[0]` as a shortcut: if a new matching element appears, the script silently acts on the wrong one.

## Accessible and test-oriented hooks

Where you can influence the application, align selectors with user-visible semantics and purposeful testability. Labels, names, roles, stable IDs and `data-testid` attributes provide better contracts than styling classes. A test ID is not a substitute for accessibility: assert labels and accessible behavior where those are the actual requirements. Conversely, tests should not depend on screen-reader-only implementation details unless accessibility itself is under test.

If developers change a component contract, tests should fail in a way that explains the lost identity. Agree on naming conventions and avoid changing test IDs casually. Keep locator definitions close to page/component abstractions so a UI change has a small repair surface.

## Common mistakes

- Selecting by a generated class or deep positional path that reflects current styling.
- Using a broad text search that matches hidden menus, duplicate labels, or nested text unexpectedly.
- Assuming `find_elements` raises when it finds nothing; it returns an empty list.
- Using a global selector when the same control exists in several cards or dialogs.
- Using XPath text equality where whitespace or nested markup varies.
- Reusing a locator result after navigation or re-rendering instead of locating the current element again.

## Production notes

Keep a small locator review checklist: uniqueness, stability, scope, and readable intent. When an element cannot be identified robustly, improve the application markup if possible rather than adding brittle chains. If only a third-party site is involved, prefer public, stable semantics and treat UI changes as an expected maintenance cost. A selector failure should expose its locator and page state in logs; do not hide it by catching every exception and retrying a different selector.

## Text and attribute details

Text is useful when it is itself part of what a user sees, but it should be treated carefully. Exact matching can break on whitespace, punctuation, localization or nested markup; broad matching can select several hidden and visible copies. XPath's `normalize-space(.)` helps with whitespace, but does not solve localization or duplicate labels. When text is localized, identify the control by a stable attribute and assert the translated label separately where language is under test. For attribute values, prefer exact CSS attribute matching when the value is stable. Avoid constructing selectors from untrusted text without correct escaping.

A locator strategy should have a reviewable fallback story, not an automatic cascade. Trying a series of selectors until one works can hide a genuine markup regression and may select an unintended control. If an approved application has multiple supported versions, encode that compatibility deliberately and log which version-specific path was used. Otherwise, fail with the missing locator and page context so the contract change is visible.

Locator choice is not a style debate. It is a dependency contract between a test and a page. Durable identity makes tests describe the behavior they intend to exercise; accidental identity makes the suite describe one transient rendering of the page.

Before committing a locator, inspect it against both the expected page and a state with duplicated labels, hidden menus, or repeated cards. Scoping and uniqueness checks catch ambiguity early and keep the action from silently targeting a neighboring control.