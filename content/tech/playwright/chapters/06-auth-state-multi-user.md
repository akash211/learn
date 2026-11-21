# Authentication State and Multi-User Flows

Authentication is where test convenience and security risk meet. Playwright can save browser storage and load it into a new context, allowing a suite to avoid repeating an expensive login UI flow in every test. A saved state is effectively a credential: it may contain session cookies, tokens or other sensitive browser storage. Handle it like a secret, not a harmless fixture.

## Save and reuse storage state

The `browser_context.storage_state()` method returns the current browser context's cookies and local storage state; with supported versions it can also include IndexedDB. The state can be written to a file and supplied when creating a context:

```python
# Save after an authorized test login.
context.storage_state(path="playwright/.auth/user.json")

# Use it to create a new isolated session.
context = browser.new_context(storage_state="playwright/.auth/user.json")
```

In plugin-based tests, fixtures may own the context. Before saving state, ensure authentication has completed and the relevant storage has actually been written. Test the restored session with a visible authenticated-only page or a profile indicator; successful file creation alone says nothing about whether the state is valid. Login behavior itself still deserves a separate test that exercises the real sign-in flow and its failure cases.

Never commit real credentials or a reusable production session. Add generated auth-state files to `.gitignore`, create short-lived test identities in a non-production environment, restrict artifact access and rotate credentials if a state file leaks. Storage state is not guaranteed to capture every browser mechanism: session storage is not included in the ordinary saved state, and applications can rely on in-memory state or server-side expiry. Design the setup according to the application rather than assuming the file is a complete browser snapshot.

## Keep actors separate

A multi-user workflow needs independent contexts so each actor has its own cookies, storage and pages. For example, an owner creates a shared resource and a second user accepts an invitation. Use one browser process with two contexts when the test environment permits:

```python
owner = browser.new_context(storage_state="playwright/.auth/owner.json")
member = browser.new_context(storage_state="playwright/.auth/member.json")
owner_page = owner.new_page()
member_page = member.new_page()
```

Contexts prevent one account's local state from overwriting another's, but they do not create independent server identities by themselves. The saved states must represent distinct authorized test users, and backend data must be prepared so the flow is reproducible. Close both contexts during teardown. If the application sends notifications or background jobs, isolate or clean those side effects too.

Avoid test cases that depend on the order in which separate accounts act unless order is part of the user story. A well-structured test names each actor and makes the handoff explicit: owner creates, recipient sees invitation, recipient accepts, owner sees membership. Assert the visible state from both sides where practical. This catches authorization bugs that a single logged-in page cannot reveal.

## Authentication setup choices

A full UI login in every test provides strong coverage of the login journey but can make the suite slow and sensitive to unrelated login-page changes. A storage-state fixture is faster and appropriate for tests of authenticated product behavior, while at least one dedicated test covers login. Another option is API-assisted setup through an owned test API or direct test database fixture, followed by a browser context that uses the returned test session. Any such shortcut must remain within a test environment and preserve the security properties being tested.

Tests for authorization should not all share an administrator identity. Use least-privilege accounts and verify forbidden access for the role that should not have it. A page that merely hides a button is not necessarily secure; when appropriate, test that the server rejects the underlying operation as well.

## Expiry and parallelism

Auth state can expire due to time limits, password rotation, one-time session semantics or backend cleanup. Generate state during test setup or CI rather than depending on a developer's local cache. If worker processes share an auth file, ensure that it is read-only and valid for parallel use; some applications rotate sessions on use. Use unique test accounts or data namespaces if simultaneous tests mutate the same user's records.

Refreshing state on every failure is a poor blanket response because it can conceal an authentication regression. First determine whether the issue is expired credentials, failed setup, a different storage mechanism or an actual product change. Keep setup failure distinct from test assertion failure in reporting.

## Common mistakes

- Committing `storage_state` files or uploading them as unrestricted CI artifacts.
- Assuming storage state contains session storage, in-memory application state or a complete browser profile.
- Using one context for two users and mistaking a tab for an independent identity.
- Testing only UI visibility when the underlying operation needs server-side authorization.
- Reusing mutable test accounts across parallel jobs and racing on shared records.

## Production notes

Keep auth state ephemeral, access-controlled and scoped to test identities. Validate its use with an authenticated page assertion, and create a distinct context per actor. Prefer least-privilege users, explicit cleanup and test data namespaces. If login state is the failing dependency, report that as setup failure instead of silently retrying until the test happens to pass.

## Keep test identity and browser identity aligned

An authenticated context is only meaningful if its server-side account and browser-side storage correspond. A stale state file may still contain a cookie but refer to a deleted or disabled account. A server can revoke a session while the browser continues to hold its token. Therefore, authentication setup should have a clear validity check and a useful failure message. Do not infer identity solely from the presence of a cookie; verify a profile name or an authenticated endpoint in the controlled environment.

For role-based tests, the account should have the minimum permissions required for the scenario. An administrator who can see every page is a poor stand-in for an ordinary user. Create account fixtures through an approved test API or identity provider, and clean them up afterward. If account provisioning is expensive, reuse accounts only when their state is reset and tests cannot race. Shared identity is especially dangerous under parallel execution because one test can change a password, revoke sessions or modify role membership while another is using it.

## Storage mechanisms and expiry

Some applications store session information in `sessionStorage`, which is scoped to a tab and is not ordinarily part of the saved storage state. If a test depends on it, seed it through an intentional setup mechanism, such as an initialization script, or authenticate using the UI. Understand how the application actually stores and refreshes its credentials before designing a helper. Do not copy tokens from browser developer tools into source code.

Expiry is a normal state worth testing. A dedicated test can verify that an expired or revoked session returns the user to sign-in and does not expose protected content. Keep this separate from ordinary logged-in feature tests, which should use a valid short-lived test identity. That separation makes authentication failures actionable and avoids a global fixture that silently signs the user back in whenever the application correctly expires a session.