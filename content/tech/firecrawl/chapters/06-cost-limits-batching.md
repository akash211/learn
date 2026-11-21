# Cost, Limits and Batching Strategy

Web collection is a workload-management problem as much as an extraction problem. Each page has latency, output size, retry risk and possibly usage charges. A crawl can expand beyond the intended scope; a structured format can consume more resources than plain text; a high retry rate can multiply work without improving success. There is no safe universal price or throughput number to hard-code: credits, rate limits, feature availability and plan quotas depend on the account and may change. Read current account and endpoint documentation, then build controls around observed usage.

## Budget by work unit

Before sending a large job, estimate its expected scale in pages and output. A useful budget is not just total API calls. Separate:

- unique source pages requested;
- pages successfully returned and pages that failed;
- extra work from rendering, structured extraction or document parsing;
- retries and duplicate URLs;
- output bytes stored and transferred;
- downstream model tokens or indexing operations.

This decomposition helps explain what drives consumption. Crawl limits bound the possible page count but do not guarantee that the crawler will find that many pages. Feature-specific billing can differ from basic scraping, so do not assume a one-page operation always has the same cost regardless of formats or document type. The plan's current credits/limits are the source of truth.

Use a dry-run or discovery phase where available. Map a narrow URL space, inspect representative results, estimate volume, then run a crawl with an explicit limit. For a known list, deduplicate it first and batch only the intended URLs. If an operation accepts a generous default, override it to a value aligned with the task. Fail closed if an estimate exceeds the approved budget rather than silently launching the entire domain.

## Batch for throughput, not opacity

Batching can reduce orchestration overhead and improve throughput, but a single enormous batch is hard to debug. Choose a batch size based on response size, failure isolation, latency, and the provider's documented limits. Smaller batches allow failed URLs to be retried independently and make progress visible. Larger batches reduce scheduling overhead but can produce large payloads and make one bad URL harder to identify.

Group compatible URLs: same domain policy, output format, rendering requirements and schema. Do not mix a simple static page with a special interaction workflow just because they fit in one request. Tag each job with a stable run ID and source partition. If a batch fails, persist successful records and retry only unresolved inputs, not the entire batch.

For asynchronous crawl or batch endpoints, separate submission from result ingestion. Store the job ID before waiting. Poll with backoff and jitter to avoid unnecessary status traffic. Respect account rate limits and concurrency guidance. If the API returns a retry-after signal or equivalent, honor it. A bounded worker pool is better than spawning one task per URL and letting the service reject the excess.

## Backpressure and rate limits

Use a token bucket or semaphore in your own client to limit in-flight requests. The concurrency target should be based on the service plan and the source sites' behavior, not on how many threads the machine can create. A 429 or rate-limit response is a control signal: slow down, honor the retry interval, and apply exponential backoff with jitter. Repeated immediate retries increase load and can worsen the limit window.

Backpressure should extend through the whole pipeline. If Firecrawl produces results faster than storage or embedding can consume them, a queue grows without bound. Put explicit caps on queued bytes and jobs. Pause submission when downstream processing falls behind. Track both request rate and result processing rate.

## Retry economics

A retry is justified when the failure is plausibly transient: a network timeout, a temporary service error, or a throttled request after the specified delay. It is usually not useful for a stable 404, an access-denied page, an invalid URL, or a schema that contradicts the source. Define retry categories and a maximum attempt count. Use jittered exponential delays, but keep the overall job deadline explicit.

Retry only the failed unit. For a crawl, use the service's job error reporting to identify failed pages. For batch scraping, preserve per-URL status and retry set. Make downstream writes idempotent with a source key and content hash so a lost client response does not create duplicate documents. Maintain an audit log of attempt count, outcome and reason.

## Measure unit economics

Use a pilot to estimate useful-page yield: usable pages divided by attempted pages. A low yield may indicate overly broad discovery, blocked hosts, poor wait conditions, or extraction settings that do not fit the source. Also measure average response size, median and tail latency, empty-content rate, duplicate rate, and amount of manual review. Unit cost per usable document is more informative than cost per request.

Track spend and quotas by team, job and source. A nightly crawl should have alerts when page count, credits consumed, or output bytes diverge from a baseline. Set budgets at several levels: per request, per job, per day, and per tenant where applicable. Protect against accidental recursive scope expansion and make cancellation available for runaway jobs.

## Example bounded strategy

For a documentation refresh, map the documentation path, remove obvious duplicate and irrelevant URLs, and take a small sample. Scrape the sample with Markdown and required metadata; validate quality and downstream chunk behavior. Then crawl the bounded path with an explicit limit and fixed formats. Process results incrementally, store them idempotently, and retry only transient failures. Compare actual page totals and credits/limits to the estimate before increasing scope.

## Common mistakes

- Assuming a fixed price or rate limit applies to every account and feature.
- Launching a full-site crawl without first estimating URL volume.
- Retrying every error the same way, including permanent access failures.
- Scaling concurrency while downstream ingestion is already backlogged.
- Measuring only request count rather than cost per useful, validated page.

## Production notes

Review usage and plan terms before capacity planning. Limits may be based on requests, pages, concurrent jobs, credits, or feature-specific dimensions. Treat API quota and target-site rate policy as independent constraints: being allowed by your account does not mean a source should be hit aggressively. A sustainable collector is bounded, observable, restartable, and willing to leave unresolved pages for review rather than retry forever.

## Forecasting under uncertainty

Estimates should include a range, not only one expected page count. A sitemap might contain fewer URLs than link traversal, or a crawl may encounter a large section the team did not expect. Use a conservative upper bound for the pilot, then compare actual discovery and usage with the estimate. If actual volume differs sharply, pause expansion and inspect the cause before changing the budget. This avoids normalizing a scope bug as a higher quota request.

Separate fixed operational overhead from variable extraction work. A batch job may have a submission and monitoring cost even when only a few URLs succeed; a failed page can still consume time and retry capacity. Track the proportion of pages that pass quality checks and the cost of review. If a source repeatedly produces low-quality or blocked content, exclude it or design a different authorized collection route instead of spending more to repeat the same attempt. Revisit forecasts when schema complexity, output formats or source mix changes.
