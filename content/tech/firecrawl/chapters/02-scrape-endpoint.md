# Scrape Endpoint, Formats and Actions

The scrape endpoint is the one-URL operation: provide a URL and a request describing how the page should be fetched and represented. In the current v2 API, the endpoint is `POST /v2/scrape`. It is the right starting point when the page is known in advance and you want its content, rather than a set of links or a full-site traversal. The response normally includes a data object with requested formats and metadata; SDKs can make the call less verbose, but the underlying request and failure modes remain API concerns.

## A minimal request

A basic request asks for Markdown, HTML, or both. Use environment configuration for credentials rather than committing keys to source control. The API's exact fields can evolve, so treat the current API reference and installed SDK types as authoritative when implementing a production client.

```bash
curl -X POST https://api.firecrawl.dev/v2/scrape \\
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/article","formats":["markdown"]}'
```

The response separates service-level outcome from page-level evidence. First inspect whether the API request succeeded and whether the response reports an error. Then inspect the page metadata, especially its source URL and target status code. A completed scrape may describe a page that itself returned a 404 or access-denied response. Applications should not collapse these two states into one Boolean.

## Formats are a contract

Choose output formats based on the next consumer, and avoid asking for every format by default. Common options include:

- **Markdown:** readable text with headings, lists, links and approximate table structure; compact for text processing.
- **HTML / raw HTML:** cleaned HTML is easier to inspect or transform while retaining tags; raw HTML helps diagnose exactly what the page supplied but includes noise.
- **Links and images:** useful for navigation analysis, asset inventories or a second-stage fetch plan.
- **Screenshot:** a visual rendering for audits and cases where layout is part of the evidence.
- **JSON format:** asks for structured output, typically with a prompt and/or schema.
- **Summary or query-style formats:** useful when the task needs a specific synthesis rather than the full page, subject to the provider's supported options.

Formats are not interchangeable. Markdown removes much of the DOM context; HTML costs storage and requires another parsing step; screenshot output is visual evidence but not directly searchable text. Requesting multiple formats can make debugging easier, but it expands payloads and may affect usage. Read the endpoint's current format requirements: special formats can have constraints, and some fields may be mutually exclusive.

A good default for a text corpus is Markdown plus metadata, not Markdown plus every possible representation. For a table extraction task, retain HTML or structured JSON for comparison. For visual review, request a screenshot on a small sample. Use raw content selectively to troubleshoot why a parser or model produced an unexpected result.

## Rendering and wait behavior

Some pages populate after initial navigation. Firecrawl can use a browser render path for JavaScript-heavy content, and scrape options can influence how long the system waits before capturing the page. `waitFor` is a delay expressed in milliseconds in supported API versions. A wait delay is a blunt instrument: it does not know that the desired data has arrived. Waiting a long time can waste capacity and still fail if the page requires user interaction or a network request that never completes.

Prefer a specific readiness signal when the API and SDK expose one, or use a modest delay only after testing representative pages. Compare the resulting title, text length, and key content against a normal request. A page may render its shell quickly but load the actual data later; conversely, a long delay may capture a rotating banner or a different state. Treat timing as a bounded operational choice, not proof of completeness.

## Actions and interaction

Scrape requests may support browser actions such as clicking a control, scrolling, or entering text before extraction. These actions help with simple dynamic layouts: expand a disclosure, reveal content below the fold, or move to another state. An action sequence is still not a general-purpose automation program. Controls can move, selectors can become stale, consent overlays can interfere, and sites may require a session or challenge that generic extraction cannot resolve.

Before adding actions, inspect whether the needed content already appears in the returned HTML or links. If it does not, define the smallest interaction sequence and test it on a few pages. Keep the action outcome observable: verify that the expected content or URL appears after the interaction rather than assuming the click succeeded. For a stateful workflow with logins, multi-step navigation or custom business rules, a browser automation tool such as Playwright may be more appropriate.

## Useful request discipline

A scrape wrapper should validate input URLs, specify formats explicitly, apply a bounded timeout, and report errors with the source URL and job context. Do not log API secrets. Keep an allowlist of domains when the source set is controlled; a URL ingestion endpoint can become a server-side request forgery hazard if an application passes untrusted user URLs directly to a service or to its own fetch layer.

Retain the response metadata that helps explain a result: canonical source URL, page title, target HTTP status, content type, and any available warning or error. Normalize the result into an internal document shape. If Markdown is empty or too short, classify it as suspicious and route it for retry or review; do not silently index an empty record.

A simple client-side pattern is:

```python
result = client.scrape(url, formats=["markdown"])
page = result.data
status = page.get("metadata", {}).get("statusCode")
text = page.get("markdown", "")
if not text.strip() or status not in (200, 304):
    raise ValueError(f"unusable page: status={status}, url={url}")
```

Adapt SDK object access to the version in use. The point is to test both target status and extracted content rather than treating the call's lack of an exception as success.

## Failure handling and retries

Distinguish transient service or network errors from stable source outcomes. A timeout or temporary service failure may merit an exponential backoff with jitter and a retry cap. A target-side 404 is not repaired by retrying repeatedly. A 403, CAPTCHA, or empty body may require policy review or a different authorized access route; retries can amplify load without improving access. Record attempt count and final classification so operators can spot a systemic source regression.

Idempotency matters when callers retry after an uncertain timeout. If an API call may have been accepted but the client missed the response, avoid launching duplicate downstream writes. Use a stable source key and a content hash, and make the persistence step idempotent. For large or slow work, use an asynchronous endpoint workflow rather than holding a request thread open.

## Common mistakes

- Requesting raw HTML, Markdown, screenshots and links for every page without a consumer for them.
- Setting an arbitrary large `waitFor` and assuming that guarantees hydration.
- Ignoring the target page's `statusCode` because the Firecrawl API call returned successfully.
- Treating one click action as reliable across pages with different layouts.
- Retrying permanent access errors indefinitely.

## Production notes

Keep a small fixture set of representative URLs and compare extraction outputs after changing SDK versions, formats, or rendering options. Alert on trends such as rising empty-page rates, status changes, or median content length collapsing. Where content is important, store the raw response or a reproducible snapshot under a retention policy so that extraction and downstream transformations can be debugged separately.
