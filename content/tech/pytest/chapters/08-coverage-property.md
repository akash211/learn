# Coverage, Mutation, and Property-Based Testing

Coverage tells you which code ran during a test suite. It does not tell you whether the assertions would detect a defect. Mutation testing asks that stronger question by making small changes to code and checking whether tests fail; property-based testing explores many generated inputs against invariants. Together they help evaluate tests as evidence rather than as a percentage.

## Line and branch coverage

`coverage.py` measures execution; `pytest-cov` connects it to pytest. A typical local command is:

```bash
pytest --cov=myapp --cov-branch --cov-report=term-missing
```

Use an explicit source package so the report does not count unrelated modules or silently measure nothing. Branch coverage records which control-flow branches ran, not just whether a line executed. A line containing `if enabled:` can be covered while only one outcome is exercised. Coverage thresholds are useful as guardrails against large regressions, but a threshold can also reward tests that execute lines without checking outcomes.

A coverage report has blind spots. It does not tell whether an assertion is meaningful, whether test inputs represent production, whether a race is tested, or whether an external service contract changed. It may also be affected by generated code, subprocesses, namespace packages, and configuration mistakes. Configure source, omit, parallel data, and report paths carefully, especially when CI combines workers or jobs. Verify that the report names the expected files and that a new module appears when its tests run.

Use `--cov-report=xml` for tools that consume Cobertura XML, and preserve the report even when tests fail. A threshold such as `--cov-fail-under` is an explicit policy; it should not be raised automatically without review. Prefer tracking meaningful trend changes and branch gaps over enforcing a universal number. Coverage exclusion pragmas such as `# pragma: no cover` need a specific reason; broad exclusions can hide untested paths permanently.

## Mutation testing

Mutation testing tools such as `mutmut` alter expressions or statements—changing `>` to `>=`, removing a call, or changing a boolean—and rerun tests to see whether a mutant is killed. A surviving mutant signals that the suite did not distinguish the altered behavior under the selected run. This is a powerful test-quality signal, but not a perfect score of correctness.

Some mutants are equivalent: the edit changes no observable behavior for any relevant input. Others survive because the tests do not reach the code, because the wrong tests were selected, or because the mutation tool cannot safely interpret a construct. Investigate representative survivors rather than chasing a score blindly. A mutation run is computationally expensive because it runs many test subsets; target critical modules, use incremental or time-bounded campaigns, and inspect the tool's configuration and report.

A useful workflow begins with a well-defined module and its focused tests. Run the normal tests, inspect baseline coverage, then mutate. If removing a validation check survives, add a test for the rejected boundary. If only a logging message mutation survives, decide whether log wording is truly part of the API before adding a brittle assertion. Mutation testing should reveal missing behavioral distinctions, not force coverage of implementation trivia.

## Property-based testing with Hypothesis

Hypothesis generates inputs from strategies and shrinks a failing example to a smaller counterexample. A property test states an invariant that should hold across a broad input space:

```python
from hypothesis import given, strategies as st

@given(st.lists(st.integers()))
def test_sort_is_idempotent(values):
    once = sorted(values)
    assert sorted(once) == once
```

The example checks idempotence, not that Python's `sorted` is correct in every possible sense. A stronger property might verify ordering and preservation of the input multiset. Choose properties independently of the implementation; reusing the same algorithm in the test can reproduce the same defect.

Hypothesis strategies describe valid domains. `st.integers(min_value=0, max_value=...)`, `st.text()`, `st.lists(...)`, `st.one_of(...)`, and `st.builds(...)` compose into rich data. Use `@composite` when later values depend on earlier ones, and `st.just` for fixed values. For date, decimal, and binary domains, set constraints that mirror the intended contract rather than filtering vast amounts of generated data. `assume()` discards examples and should not replace a strategy that directly generates valid values.

Hypothesis records failing examples in its example database and replays them in later runs. Tests should still be deterministic in their contract; do not depend on the exact generated sequence or assert that an internal random seed stays constant. A failure report shows a minimal counterexample useful for converting a bug into a focused regression. `@example(...)` can preserve a known boundary case alongside generated examples.

Stateful testing can generate sequences of actions against a model and system under test, useful for caches, parsers, and stateful APIs. The model should be simpler and independently reasoned about. If the model duplicates production logic line-for-line, agreement proves little.

## Common mistakes

- Treating 100% line coverage as proof that every requirement is tested.
- Raising thresholds without checking source configuration, branch gaps, or test value.
- Adding a property that restates the implementation and shares its bug.
- Using excessive `assume()` filtering instead of constructing a valid strategy.
- Treating every surviving mutation as a missing test even when the mutant is equivalent or irrelevant.

## Production notes

Use coverage to locate unvisited logic, mutation testing to challenge selected assertions, and Hypothesis to probe broad input invariants. Keep all three tied to observable contracts. A pragmatic sequence is: establish focused examples for known requirements, use coverage reports to find unexplored branches, add property tests for general laws, then run mutations on risk-heavy code. Preserve failing Hypothesis examples through the database or a named `@example`, and keep CI runtime within a deliberate budget.

## Keep oracle and state independent

Every test needs an oracle: a reason the expected result is correct. For example-based tests, that
can be a known business example reviewed by a domain owner. For property tests, it is a general
law such as round-trip stability or monotonicity. Avoid defining expected output by invoking the
same production helper under test, because the oracle then cannot catch a shared mistake. A small,
obviously correct reference implementation can be useful for a limited domain, but it should be
simpler than the optimized implementation and independently reviewed.

Stateful code needs state-aware properties. Hypothesis state machines let you define rules that
produce operations and compare a real system with a model after each step. Keep the model small:
for a cache, a plain dictionary with explicit eviction semantics may be enough. Include sequences
such as insert, update, expire, and delete that expose transitions a single call cannot show.
Reproducible settings help debugging, but tests should not assert a specific random sequence. Save
important regressions as explicit examples so their purpose remains apparent even if generation
strategies evolve.

Coverage in subprocesses needs explicit configuration or instrumentation support; otherwise the
parent report may omit child execution. Parallel coverage can produce separate data files that need
combining. Verify the final report after changing workers, source layout, or test runner settings.
A numeric total that suddenly drops to zero usually indicates configuration or collection failure,
not an overnight loss of test quality.