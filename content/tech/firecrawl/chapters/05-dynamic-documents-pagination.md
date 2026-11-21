# Dynamic Pages, PDFs and Pagination

Web content can be delayed, non-HTML, or too large to return at once. A JavaScript-heavy dashboard may need a browser render; a report URL may actually serve a PDF; a crawl can complete while its results span several pages. These cases are related operationally but require different checks. Rendering addresses when and how a page appears, document parsing addresses its file format, and pagination addresses how a completed job's results are delivered.

## JavaScript-heavy pages

A browser-rendered page has multiple relevant moments: navigation begins, the initial document arrives, scripts execute, network calls return, and the DOM changes. A fixed delay such as `waitFor` asks the renderer to wait for a duration; it does not prove the target data is ready. If supported, a selector or more precise action can be a better readiness condition. Verify the result by looking for a known heading, record count, or minimum content length.

Use the smallest wait that works across representative pages. Dynamic content can update continuously, and waiting for network idle may never settle on pages with analytics or streaming requests. A scroll action can reveal lazy-loaded content, but repeated scrolling is not automatically equivalent to traversing pagination. A click can reveal a panel, but a page may require cookies, login state, or a custom workflow outside a generic scrape request.

Separate page rendering problems from extraction problems. If HTML contains the needed data but Markdown does not, the content cleanup path may be the issue. If neither HTML nor Markdown has it, the browser may have captured too early, an API call may have failed, or the content may be inaccessible. Screenshots and metadata can help diagnose this, but they should be sampled because visual output is larger and often unnecessary for normal ingestion.

## PDFs and other documents

A URL ending in `.pdf` is commonly handled as a document by the scrape service, but URL suffixes are not reliable: redirects and content type matter. Check response metadata and validate that the result contains meaningful text. PDFs may include selectable text, scanned images, tables, headers/footers, columns, or a mixture. Text extraction can preserve words while losing layout and reading order.

When a document is scanned, OCR may be required and errors should be expected. A two-column paper can interleave lines; a table may flatten into ambiguous sequences. For important extraction, compare key facts against the original document or render pages for human review. For a local file that is not reachable by URL, use the provider's document parsing workflow if available, or an appropriate local PDF parser. Keep page numbers or other locators when downstream citations must point to evidence.

Large PDFs can produce proportionally large output and take longer to process. If downstream use needs only a section, define a targeted extraction step after parsing rather than storing the entire document multiple times. Respect document access rights and retention rules; public availability does not settle reuse permission.

## Pagination of asynchronous work

Crawls and batch jobs may return job IDs rather than all content synchronously. Poll the job-status endpoint using a bounded cadence. When status says processing, wait; when completed, continue reading result pages until there is no next cursor or URL. A response-size limit can cause a `next` link even after the job's processing phase has finished. Never assume “completed” means the current HTTP response contains every page.

Direct API consumers should treat pagination as a durable state machine:

1. Store the job ID and request parameters before polling.
2. Persist each result page idempotently before advancing the cursor.
3. Save the next cursor only after the current page is committed.
4. Resume from the saved cursor after a process restart.
5. Mark the job fully ingested only when no further page is advertised and counts reconcile.

SDKs may handle pagination automatically, but application memory can still become a bottleneck if the SDK accumulates every result into one list. For large runs, consume pages incrementally or use a streaming/webhook pattern if supported. Keep incomplete jobs distinguishable from jobs whose result ingestion is complete.

## Handling duplicates and status codes

A page can be reached from multiple links, appear in a sitemap and direct navigation, or redirect to a canonical URL. Normalize URLs carefully: remove fragments, normalize host casing, and only strip query parameters known to be tracking noise. Some query parameters encode content or language, so broad removal can merge distinct pages. Use a canonical URL when the page supplies one, but keep the requested URL too for auditability.

Crawl results may include target pages with non-success HTTP codes, while separate error endpoints report pages that failed at the service/network layer. Preserve both categories. A target 404 may be a meaningful result for a link checker; for a knowledge index it is generally not content to ingest. A timeout may be retried. Classifying these separately avoids repeatedly scraping permanent errors and discarding useful diagnostics.

## A practical test matrix

Before scaling, select fixtures covering: a static article, a hydrated page, a lazy-loaded list, an authenticated or blocked page if authorized, a PDF with text, a scanned PDF, a redirect, a 404, and a multi-page crawl. For each, record expected behavior, target status, output length, source identity, and whether manual correction is required. A representative fixture suite is more useful than tuning against a single homepage.

## Common mistakes

- Using a fixed delay as a universal guarantee of hydration.
- Assuming every PDF has clean, linear text extraction.
- Polling too frequently or holding job state only in process memory.
- Advancing the cursor before persisting the current result page.
- Treating a completed crawl as fully downloaded before following `next` pages.

## Production notes

Set maximum page counts and maximum total output sizes for each job. Alert when result pagination stalls, when job totals and ingested counts disagree, or when a source's extracted length changes sharply. Keep retries bounded and distinguish retryable transport errors from access controls and permanent page statuses. These safeguards prevent one unusual document or site from consuming an unbounded amount of time and storage.

## Preservation and replay

Decide how long job results and raw source snapshots should be retained. Provider job-result windows may be limited, so a durable ingestion process should copy records into storage under its own retention policy rather than assuming the API remains a permanent archive. Keep enough request context to reproduce the transformation: endpoint version, format, schema or prompt version, render settings and the set of filters. Avoid storing credentials or sensitive headers with that context.

A replay should be possible without duplicating downstream records. Use an idempotency key derived from source identity, content version and processing version. If content is unchanged but the chunking logic changed, the document may need rechunking without another web request. If the source content changed, retain the previous snapshot long enough to compare changes and support rollback. Separating these paths makes it easier to diagnose whether a discrepancy came from the page, renderer, parser or downstream code.
