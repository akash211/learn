# Testing and Evaluating Tools

You cannot review a non-deterministic planner by reading it. The only way to know whether a toolset works is to exercise it at several levels: the schema, the handler, the loop, the model's choices, and the system under adversarial input. Each level catches a different class of failure, and teams that skip the middle levels end up with slow, flaky tests that fail for reasons unrelated to the bug.

## Level 1: schema tests

The JSON Schema you send is generated code. Test it like generated code.

- **Snapshot it.** Store the exact schema per tool and diff on change. A refactor that quietly turns `amount_minor: int` into `amount_minor: string` is a production incident; as a snapshot diff it is a review comment.
- **Assert provider constraints.** In strict mode: every property in `required`, `additionalProperties: false`, no unsupported keywords (`$ref` recursion, `patternProperties`, unbounded `oneOf`). Fail the build, not the request.
- **Assert the semantic vocabulary.** Every enum's members match the domain's status set; every ID field has a pattern; every numeric bound matches policy.
- **Probe the provider once.** A single request at startup (or in CI against a sandbox key) that sends the real tool list confirms the provider accepts your schemas.

```python
def test_refund_schema_shape():
    schema = build_schema(issue_refund)
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert schema["properties"]["reason"]["enum"] == ["damaged", "not_received", "duplicate_charge"]

def test_all_schemas_snapshot(snapshot):
    snapshot.assert_match(json.dumps(all_schemas(), indent=2, sort_keys=True), "tool_schemas.json")
```

## Level 2: handler tests

Pure unit tests, no model involved. For each tool, cover: valid call, each validation failure, each authorisation failure, upstream timeout, upstream 5xx, upstream malformed response, empty result, truncated result, and the idempotent replay.

The assertions should be on the **result envelope**, not on log strings: stable `code`, `retryable` flag, no leaked internals, and the exact payload the model would see. If your error test only asserts `pytest.raises`, you have no error contract.

Property-based tests are unusually effective here. Generate argument objects with Hypothesis from the schema and assert the handler never raises an unhandled exception, never exceeds its timeout, and always returns a valid envelope. That single test catches the "we forgot a null" class of bug across every tool at once.

## Level 3: loop tests with a scripted model

Replace the model with a fake that replays a scripted sequence of responses, and test the orchestration from chapter 4 deterministically:

- Three tool calls then a final answer → correct results appended, loop terminates, one final message.
- Tool returns a fixable error → one repair attempt, then stop.
- Same tool called twice with identical args → duplicate detection fires, no second execution.
- Budget exhausted → truthful outcome, no partial text presented as success.
- Provider returns parallel calls → all results appended, one message per `tool_call_id`.
- Tool raises an exception (not a returned error) → converted to an envelope, loop continues.

This is where you test idempotency end to end: a tool that commits and then drops its response; two identical calls 5 ms apart; a resume after a kill between effect and record. None of these need a real model, and all of them are cheap to run in CI.

## Level 4: trajectory tests

A trajectory is the sequence of calls, not the final text. Record real (redacted) transcripts, then assert on structure:

```python
def test_multi_order_refund_trajectory(recorded_run):
    run = replay(recorded_run)
    assert [c.tool for c in run.calls] == ["get_customer", "list_orders", "issue_refund"]
    refund = run.calls[-1]
    assert refund.args["amount_minor"] == 4599
    assert refund.args["order_id"] in recorded_run.expected_orders
    assert run.final_text_mentions("$45.99")
```

Two cautions. First, exact tool sequences are brittle: a legitimate reformulation may call `list_orders` before `get_customer`. Assert on *properties* (the refund targets the right order, no tool outside the allowed set, no more than N calls) rather than on one blessed path. Second, recorded transcripts go stale when you change a description — which is exactly when you want to re-record and re-review the diff, so treat a failed trajectory test as a prompt change that needs eyes, not as a broken build to be "fixed" by updating the fixture.

## Level 5: model evals

Now use a real model, over a scenario set built from real requests. What to measure:

| Metric | Definition | Target shape |
|---|---|---|
| Selection accuracy | Correct tool among those offered | High; regressions matter most |
| Argument validity | Calls passing structural validation | > 99% with strict modes |
| Task success | Outcome correct per a rubric | The headline number |
| Unnecessary calls | Calls whose result was unused | Low; drives cost |
| Error recovery | Failed call followed by a successful repair | Track, don't maximise |
| Cost / latency | Tokens and p95 per task | Budgeted |

Grade the outcome with deterministic checks where possible (did the refund record exist with the right amount?) and a rubric-based judge only where necessary. A judge model is a measuring instrument with its own error rate; calibrate it against a few dozen human-labelled examples before trusting its deltas.

Run each scenario several times. A single pass at temperature 0 is not evidence: providers change behaviour between model versions, and some sampling variance persists even at low temperature. Report pass rates with the number of trials, and pin the model version in the eval config so a silent provider upgrade shows up as a diff rather than a mystery.

## Adversarial and robustness tests

- **Injection corpus.** Tool results containing "ignore previous instructions", base64 payloads, zero-width characters, and instructions addressed to the model. Assert that no egress tool is called and that the final answer does not contain the attacker's marker.
- **Upstream weirdness.** HTML error pages, gzip bombs, 200 responses with an error body, redirects to link-local addresses.
- **Approval bypass.** A scripted model that re-issues an approved call with modified args; assert the hash check rejects it.

## Mocking strategy

You need mocks at two seams, and confusing them is the usual source of flaky suites.

**Mock the model** to test your code: deterministic, fast, no tokens. Use it for loops, retries, budgets, streaming assembly, and error handling.

**Mock the tools** to test the model's behaviour: a fake server with fixed data, so selection and argument accuracy are measured without touching production systems. Give the fake realistic messiness — long IDs, empty results, occasional 500s — because a sanitised mock produces optimistic evals.

Do not mock both at once and call it integration. One seam per test.

## Failure taxonomy

When an eval fails, classify before fixing. The categories have different owners:

| Symptom | Usual cause | Fix |
|---|---|---|
| Wrong tool selected | Overlapping descriptions | Rewrite the "when not to use" lines; consider merging tools |
| Right tool, bad args | Ambiguous schema, missing enum | Schema change, not prompt change |
| Correct call, result ignored | Result too large, prose instead of structure | Shrink and structure the result |
| Stops too early | No explicit completion criterion | Add a "you are done when…" line and a check |
| Loops | Error not marked terminal, no duplicate detection | Loop guards, error classification |

## Common mistakes

- Testing only the happy path, then discovering the error contract in production.
- Asserting on exact assistant prose, which changes with every model update.
- Using the same model to generate and grade, and calling it evaluation.
- One trial per scenario, reported as a percentage.
- Mocking the model and the tools in the same test, so a failure could be either.
- Never testing duplicate side effects because "the model won't do that twice".
- Updating golden transcripts wholesale after a prompt change without reading the diff.

## Production notes

Keep the scenario set in version control, tagged by capability, and grow it from real incidents — every bug becomes a regression case. Run the fast levels (schema, handler, loop, stream assembly) on every commit; run model evals nightly and on prompt or model changes.

Track eval results over time, not as a single number: a 2-point drop in task success with a 10-point drop in "unnecessary calls" may be a good trade. And keep a small human-reviewed sample in the loop — automated rubrics drift, and the failures that matter most are often the ones your rubric was never written to see.
