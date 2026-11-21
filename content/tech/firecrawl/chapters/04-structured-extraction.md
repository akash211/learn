# Schema-Guided and LLM Extraction

Readable Markdown is a good interchange format for documents, but applications often need fields: product name, release version, policy date, price availability, or a list of people and roles. Firecrawl supports schema-oriented extraction in scrape formats, where page content is interpreted and returned as structured JSON. This can save custom parsing for varied page layouts. It also introduces a model-mediated inference step, so a syntactically valid JSON object must not be confused with a verified fact.

## From text to a typed record

A structured scrape generally combines a target URL with a JSON schema and, optionally, a prompt that explains what each field means. Define the output around downstream needs. Use specific types, required fields, enums when values belong to a known set, and descriptions that disambiguate domain terms. Keep the schema as small as practical; asking for many loosely defined fields encourages inconsistent output and increases the review burden.

For example, an inventory of software release pages might require `product`, `version`, `release_date`, and `highlights`. `release_date` should be nullable or otherwise account for pages without a date. `highlights` should have an explicit item shape. A schema that requires a date when some pages do not publish one pressures extraction to guess. Model absence as part of the domain rather than treating it as an exceptional surprise.

The prompt describes the extraction task; it should not contradict the schema. Explain the desired source of a field (“use the date explicitly labelled release date, not the page's publication date”), how to represent unknown information, and whether to return only content visible on the page. Avoid asking for facts that require cross-page research when the request is limited to one page.

## Validation is still application work

A schema constrains output shape, not truth. Validate the result locally: required keys, types, ranges, allowed values, date parsing, URL formats, and cross-field consistency. If the system allows a source quote or evidence snippet, retain it and check that the value is supported by the page. Store the original URL and a content reference alongside each extracted record. For important fields, compare the JSON result with the page text or require human review.

```python
record = result.get("json")
if not isinstance(record, dict):
    raise ValueError("expected an object")
if not record.get("product") or not record.get("version"):
    raise ValueError("missing required release identity")
```

The precise SDK response shape depends on SDK version and format configuration. Normalize it at an adapter boundary, then validate against your own model, for example Pydantic or a JSON Schema validator. Do not spread provider-specific field names throughout the application.

If an extraction fails validation, classify the failure. A missing field may mean the source does not state the fact, the page did not render, or the schema/prompt is unclear. Retrying the same request is not a universal fix. Preserve the source response and diagnostic metadata, then either revise the schema, route the page to a fallback parser, or mark the record incomplete.

## LLM inference versus deterministic parsing

Use schema-based extraction when source pages vary enough that a conventional selector would be fragile, but the required information is still stated in page content. Prefer deterministic parsing for stable formats such as a known API response or a CSV download. Models can normalize synonyms and tolerate layout variation, but they can hallucinate, misread context, confuse dates, or combine facts from nearby sections. Their output can also vary as models or service behavior change.

A useful production pattern is two-stage: first retrieve a faithful page representation and metadata; then extract a record under a versioned schema. Keep extraction prompts and schema versions with the resulting record. This makes drift visible and enables reprocessing. For high-risk values, add rule checks and evidence capture rather than assuming a model's confidence is calibrated.

## Endpoint evolution and migration awareness

Firecrawl's extraction surface has evolved. Earlier workflows used a dedicated `/extract` endpoint for one or more URLs and prompts/schemas. Current documentation directs single-page structured extraction toward `/v2/scrape` with a JSON format, while broader wildcard or multi-page agentic extraction is moving toward the `/v2/agent` workflow; legacy endpoint availability and timelines can change. Check the current migration guide before selecting an endpoint for new work. Do not build a new long-lived integration around a deprecated route merely because an older example still appears in a blog post or SDK.

This distinction also clarifies responsibilities. Scrape with a JSON format is appropriate when the URL is known and the task is a bounded page transformation. A wider discovery-and-extract task may need an agent or an explicit map/crawl followed by per-page processing. The latter gives the application more control over coverage, retries and cost accounting. An asynchronous job is better for larger sets than a synchronous request held open.

## Reliable schema design

Good schemas encode semantics, not just field names. If a field may be absent, use optionality or a documented null representation. If multiple values are possible, define whether the result is a list, a single best match, or an error. Distinguish a page's publication date from an event date, and a product's current price from a historical price. Normalize units explicitly, but keep the raw displayed value when that context matters.

Avoid overly permissive catch-all fields that make downstream records impossible to query. At the same time, do not overfit to one sample page. Test against positive, negative, and ambiguous fixtures: a page with the field, a page without it, and a page containing a similar but incorrect value. Evaluate field-level precision and completeness rather than only checking whether each output parses as JSON.

## Common mistakes

- Treating schema conformance as evidence that extracted facts are correct.
- Making every field required when source pages legitimately omit some values.
- Asking for facts not present on the page, encouraging unsupported inference.
- Forgetting to version prompts and schemas alongside stored results.
- Building a new workflow on an endpoint that the current docs mark for migration.

## Production notes

Track validation pass rates by field, source domain, schema version and extraction mode. A sudden decline often reveals a changed page template or provider behavior before users notice. Keep a fallback path: deterministic parser for a stable source, re-scrape with a tested render setting, or human review for high-impact records. If a model-generated field is displayed externally, preserve provenance and apply product-specific review standards.

## Monitor drift and review thresholds

Define a review threshold before production rather than deciding case by case after a bad record appears. For example, a sudden increase in null values can indicate a genuine source change, while a rise in populated but implausible values can indicate semantic drift. Keep representative historical inputs so a prompt or SDK upgrade can be tested against the same pages. Compare structured output with extracted text and track error categories separately: absent source fact, ambiguous wording, page-render failure, schema violation, and normalization failure.

When using extraction across a crawl, aggregate quality by domain and page template. A high overall success rate can hide one source family failing completely. Route pages with unusual output to a review queue and retain the original input reference. This is especially important when extracted fields drive prices, eligibility, release information or other decisions where a plausible but wrong value is more harmful than a clearly missing value.
