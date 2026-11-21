# Evaluating Agents

An agent that "seems better" after a prompt change is a hypothesis, not a result. Evaluation is the discipline that turns prompt engineering from folklore into engineering, and it is the single most under-built part of most agent projects. The reason is structural: there is no single correct string to compare against, the path matters as much as the answer, and every run is a sample from a distribution.

## Two axes: outcome and trajectory

**Outcome** evaluation asks whether the task ended correctly. The strongest form checks the world, not the text: after the run, does the database contain exactly one refund of $84.00 on order 4471? Does the file the agent produced compile? Does the response contain the three facts that were asked for? Where the environment can be asserted on, assert on it — string comparison of a chat reply is a weak proxy for state.

**Trajectory** evaluation asks whether the path was acceptable: the right tools in a sensible order, no forbidden calls, within the step and cost budget, no unnecessary escalation. A run that reaches the right answer by refunding three times and reversing two is a success by outcome and a serious defect by trajectory.

You need both, because each hides a distinct failure. Outcome-only scoring rewards luck: a run that guessed the right account passed. Trajectory-only scoring rewards ritual: the agent followed the correct procedure and produced a wrong answer. Report them separately, and never average them into one number that hides which one moved.

| Check | Question | Cost to build | Failure it catches |
|---|---|---|---|
| State assertion | Did the world change as required? | Medium | Plausible text, wrong effect |
| Unit test on artefact | Does the output/compile/query work? | Low | Broken output |
| Tool-sequence assertion | Were required/forbidden calls made? | Low | Unsafe path, duplicated writes |
| Budget assertion | Steps, tokens, latency within limits | Low | Cost regressions |
| Rubric judge | Is the answer substantively good? | Medium | Vague or incomplete answers |
| Human review | Would an expert accept this? | High | Everything else, slowly |

## Building the task set

Start with 40 to 100 real tasks drawn from production or from the people who will use the system, stratified by task type rather than sampled uniformly — you want coverage of the hard tail, not a proportional sample of easy volume. Add, deliberately:

- **Edge cases** you already know are hard: missing records, ambiguous requests, multi-entity references.
- **Refusal cases.** Requests the agent must decline or escalate. Systems that are only tested on happy paths learn to comply with anything.
- **Adversarial cases:** a document containing instructions, a tool returning an error mid-task, a request that looks routine but targets another tenant.
- **Empty and degenerate cases:** one-word requests, enormous inputs, contradictions.

Redact production traces before they enter the set, and keep the expected outcome alongside the input. An eval you cannot score is a demo.

## Non-determinism: measure consistency, not just capability

A single pass over the set measures capability once. Run each task *k* times and report both "succeeded at least once" and "succeeded every time". The second is what users experience: a task that works 70% of the time is a task that fails three times a week. The τ-bench work (Sierra, 2024) popularised `pass^k` for exactly this reason — reliability under repetition, not best-of-k.

Practical k: three to five for a fast suite in CI, ten for a release candidate. Cost scales linearly, so keep the fast suite small, deterministic where possible, and run the expensive one nightly.

## LLM-as-judge, and its failure modes

A judge model is often the only scalable way to score open-ended output. It is also a measurement instrument with known biases, and using it without calibration is how teams optimise against noise.

Known failure modes:

- **Position bias.** In pairwise comparison, the judge prefers the first (or last) option. Fix by evaluating both orders and averaging, or by using pointwise rubrics.
- **Verbosity bias.** Longer answers score higher regardless of content. Fix by capping length in the rubric, or by scoring specific claims rather than overall quality.
- **Self-preference.** A judge favours output from its own model family. Fix by using a different model as judge, or by calibrating per family.
- **Rubric drift and ambiguity.** "Is this helpful?" is not a criterion. Use a small number of binary, independently checkable criteria ("does it state the refund amount?", "does it cite a policy id?") and combine them.
- **Gaming.** An agent optimised against a judge learns the judge's tics — flattery, hedging, confident phrasing. Keep the rubric out of the agent's context and rotate held-out cases.
- **Silent upgrades.** A judge endpoint changes under you and scores move. Pin the model version and record it with every score.

Calibrate before trusting: label 50 to 100 examples by hand, measure judge–human agreement (and disagreement patterns), and treat agreement as a property of the rubric, not of the judge in general. If agreement is poor, the rubric is the problem far more often than the model.

## Regression suites

The eval set is only useful if it runs on every change. That means:

- **Versioned cases**, in the repository, reviewed like code. A case that changes without a diff is a case nobody can trust.
- **A frozen baseline** of scores per slice, not one aggregate. A release that improves the average while breaking the "refund above threshold" slice is a regression.
- **Deterministic seams.** Mock the world (tools, clock, randomness) so failures reproduce; keep a smaller live-world suite for realism. Record tool responses for replay.
- **Budgets as assertions.** Steps, tokens, latency, and cost per task belong in the suite. A prompt that adds two steps for a marginal quality gain is a product decision, and it should be visible.
- **Flake policy.** Some variance is inherent. Distinguish flaky infrastructure (a mocked tool returned nothing) from genuine non-determinism (the model chose a different path), and quarantine the former loudly rather than retrying until green.

## What to measure in production

Offline evals answer "did this change make it worse". Production answers "is it working now", and the two disagree often enough that both are needed.

Track: task success rate by slice, escalation and refusal rate, tool error rate, steps and tokens per success (**cost per success**, not cost per call — a cheap agent that needs three attempts is not cheap), and the rate of forbidden or duplicated side effects, which should be zero and alarmed on. Sample transcripts for human review weekly; the sample is how new failure classes enter the eval set.

Shadow mode is the cheapest way to evaluate a replacement: run the new prompt or model on live traffic without executing its side effects, score the decisions against what the current system did, and only then let it act.

## Common mistakes

- Five examples, all happy path, scored by eyeballing two outputs.
- Using the model under test as its own judge, then reporting a 0.9 score as if it meant something.
- Scoring only the final message when the environment can be asserted on.
- One aggregate score, so a slice regression hides inside an average improvement.
- Changing the rubric and the prompt in the same commit, making the delta uninterpretable.
- Optimising against the eval until it passes, with no held-out set.
- Ignoring cost and latency, which users experience as failure.

## Production notes

Treat the eval harness as a product with an owner: cases, rubric, judge version, and baseline all versioned together, and the whole suite runnable with one command. Keep a permanent holdout that nobody tunes against; rotate a portion of it quarterly from production traces. When an incident happens, the first follow-up is a new eval case that fails on the incident's cause — that is how the suite becomes the institutional memory of every mistake the system has made. Finally, publish the numbers with their uncertainty: a 3-point difference on 60 tasks with high variance is not a difference, and shipping on it is how teams chase noise for a quarter.
