# Crawl, Map and Search

Firecrawl offers three operations that can all lead to page content but solve different discovery problems. **Crawl** traverses a site from a starting URL and scrapes pages it reaches. **Map** discovers URLs without making the same commitment to retrieve the full content of every page. **Search** starts with a topic or query and finds candidate web results, optionally returning scraped content for those results. Selecting the right operation determines scope, cost exposure, and what “complete” can mean.

## Crawl: traverse a site boundary

A crawl begins at a URL and follows discovered pages, often using links and sitemap information. The crawl endpoint is typically asynchronous: submit the job, receive an identifier, poll for status or receive results through a supported delivery mechanism, then retrieve all pages. Set an explicit page `limit`; avoid inheriting a generous default when you only intend to sample. Use path include/exclude filters, depth restrictions, and controls over subdomains or external links to express the scope you actually want.

The scrape options can generally be applied to pages reached by the crawl, so formats, rendering behavior, or structured output are consistent across the job. This is powerful but multiplies the effect of a bad option or a wrong scope. A crawl that enables an expensive output format over thousands of pages can exceed a budget quickly. Begin with a low limit and inspect the discovered URL set before scaling up.

A crawl is not a guarantee that every page on a site has been found. Pages may be orphaned, excluded by robots directives, linked only after interaction, or hidden behind authentication. Sitemaps can be incomplete or stale. Canonical URLs and redirects may create apparent duplicates. The result should be described as “pages discovered and processed under these settings,” not as a mathematically complete snapshot of the domain.

For long jobs, track the job ID and status durably. Poll with a reasonable interval and backoff rather than rapid-fire requests. When a job response includes a pagination cursor or `next` URL, continue until the service indicates there is no next page. SDKs may paginate automatically; direct API clients should not assume the initial response contains all results. Also distinguish completed pages from crawl errors. A page can appear in results with a target error status, while separate job diagnostics may describe pages the crawler could not retrieve at all.

## Map: learn the URL inventory first

Map is useful when the immediate question is “what URLs are known under this site?” It can help estimate crawl size, build an allowlist, identify relevant paths, or compare a site's URL inventory over time. It is usually a better reconnaissance step than a broad crawl when the page set is unknown and cost or scope matters.

A map response is not page content. It gives candidates to inspect or feed into a subsequent scrape or crawl. A domain can have a very large URL surface, and map limits, filtering capabilities, and result caps depend on the API version and plan. If the endpoint reports a truncated list or reaches a limit, treat it as a sample or bounded inventory rather than silently calling it complete. Narrow with path prefixes or query criteria, then fetch selected URLs.

Map can also be a discovery signal for an incremental pipeline. Compare URL sets between runs, then enqueue new or changed URLs for scraping. A URL's presence does not mean its content changed; conditional fetches, content hashes, or change-tracking mechanisms can reduce unnecessary work. Conversely, a URL disappearing from a map should not immediately delete indexed data unless the inventory is known to be reliable and the product has a deletion policy.

## Search: start with an information need

Search is the right operation when you do not have a source domain or exact URLs. Provide a query and retrieve candidate result URLs, titles, descriptions, and, where configured, page content. Search results are inherently ranked and bounded; they represent what the search backend found for the query, not an exhaustive census of the web. Use several targeted queries if recall matters, and deduplicate overlapping results by canonical URL.

Search is particularly useful for research assistants, discovery workflows, and open-ended question answering. It can reduce a multi-step integration where the application otherwise calls a search engine and then scrapes every result itself. Still, verify the pages before presenting conclusions: results can be stale, irrelevant, thin, or biased toward popular sources. Store query, collection time, rank and source URL so an answer can be audited.

## Choosing the operation

| Need | Start with | Reason |
|---|---|---|
| Extract one known article | Scrape | Scope and expected result are specific |
| Discover a site's URLs, then choose pages | Map | Separate discovery from content retrieval |
| Ingest a bounded documentation site | Crawl | Link traversal and site-level filters fit the task |
| Find sources for an open question | Search | Discovery begins from a query, not a site |
| Process a fixed list of product URLs | Batch scrape or individual scrape jobs | The URL set is already known; crawling adds uncertainty |

A useful workflow is map, review, then crawl or scrape. For a public documentation site, first map a narrow documentation path, inspect the volume and URL patterns, then crawl with a defensible limit and exclusions. For a known URL list, batch scraping avoids the crawler's discovery behavior. For an unbounded topic, search yields a shortlist that can be verified and selectively scraped.

## Limits and boundaries

Every discovery operation has boundaries: page limits, result limits, maximum job size, concurrency, rate limits, output retention and plan constraints. Their actual values can vary by account and change over time; consult current endpoint documentation and account settings rather than embedding assumptions. A crawl `limit` is a guardrail, not a promise that the crawler will find that many pages. Filters may be applied at different stages, so test whether a pattern affects URL discovery, scraping, or both.

Respect source policies. Discovery is not permission. Keep external-link traversal disabled unless it is intentional, because one seed page can link into unrelated domains. Validate redirects and canonical hosts. If users can supply a root URL, apply an explicit domain allowlist and reject private network or internal host targets in any adjacent fetch infrastructure.

## Common mistakes

- Using crawl to process a known list, then wondering why it found unrelated pages.
- Assuming map returns every reachable URL or includes the content itself.
- Treating search ranking as a measure of source correctness.
- Starting a full crawl without an explicit page limit or path scope.
- Failing to follow result pagination and then indexing only the first segment.

## Production notes

For asynchronous jobs, persist a job record containing the initiating scope, limit, filters, submit time, status, and last cursor. Make result ingestion restartable and idempotent. Keep crawl errors separate from successful page records, and expose counts for discovered, completed, failed, filtered, duplicate and pending URLs. These counts explain whether the job produced a useful corpus, which is more informative than a single “completed” status.
