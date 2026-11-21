# Testing, Benchmarking, and Tooling

Rust's built-in test harness and Cargo commands make testing part of the default development loop. `cargo test` compiles unit tests, integration tests, and documentation tests, then runs them. Testing should cover observable contracts and failure behavior, while linting and formatting catch classes of errors and style drift before review.

## Unit, integration, and documentation tests

A unit test module commonly sits beside the code under `#[cfg(test)]`, and can access private implementation details as a child module. Mark a function with `#[test]`; use `assert!`, `assert_eq!`, and `assert_ne!` to check behavior. For fallible tests, return `Result<(), E>` so `?` can propagate setup failures, or use explicit assertions on the error. `#[should_panic]` is available when panic behavior is an intentional contract, but testing ordinary errors through `Result` is usually clearer.

Integration tests live in `tests/` and compile as external crates. They can access only the public API, making them useful for checking that consumers can actually use the documented interface. Documentation tests extract Rust code blocks from API documentation, compile them, and run them; include them when a short example meaningfully demonstrates usage. Mark illustrative code that cannot compile as `ignore` or use the appropriate doctest annotation, and explain why it is omitted.

Test boundaries that matter: empty collections, malformed input, permission failures, timeouts, cancellation, and concurrent access. Avoid tests that merely restate implementation details. Use temporary directories and deterministic fixtures instead of relying on the machine's current working directory or a live network. For async code, use the runtime test support provided by the chosen executor, and ensure test tasks and spawned work are fully awaited.

## Property and fuzz testing

Example-based tests cover known cases; property-based testing generates many inputs against invariants such as round-trip serialization, ordering, or parser consistency. Fuzzing can explore malformed and adversarial input beyond handpicked tests. These tools complement unit and integration tests; they do not prove correctness. Keep fuzz targets deterministic where possible, bound resource consumption, and preserve minimized regression cases as normal tests.

## Benchmarking carefully

Benchmarking must answer a specific question with representative input. Microbenchmarks are sensitive to compiler versions, CPU scaling, allocator state, and measurement noise. In stable Rust, the built-in `#[bench]` support historically requires nightly; Criterion is a commonly used library for statistical microbenchmarks. Whichever harness is chosen, use release-like optimization settings, warm up appropriately, prevent dead-code elimination where relevant, and benchmark end-to-end behavior as well as isolated functions. Do not publish a number without stating the toolchain, target, input, and measurement conditions. Benchmarking does not replace profiling: use profilers to find where real application time and allocations go.

## Clippy, rustfmt, and Cargo commands

`cargo fmt --check` verifies formatting with rustfmt; `cargo fmt` applies it. `cargo clippy --all-targets --all-features -- -D warnings` runs Clippy and can make lint warnings fail CI. Not every lint is a correctness bug; understand the diagnostic rather than mechanically adding allowances. Scope a justified allowance narrowly and explain it. `cargo check` is a quick compiler check, `cargo test` runs tests, and `cargo build --release` creates an optimized binary. `cargo test --all` and `--workspace` are useful in multi-package repositories; feature combinations should be tested explicitly when they affect behavior.

## Common mistakes

- Testing only through private unit tests and never exercising the public API as a downstream caller would.
- Using a microbenchmark to make broad performance claims without representative workloads or repeatable conditions.
- Ignoring a Clippy warning without deciding whether it indicates a bug or a useful style improvement.
- Running tests only with default features when production enables a different dependency combination.
- Depending on external services or wall-clock timing in ordinary unit tests.

## Production notes

Put the same checks in CI that developers use locally: format check, lint, tests, and a locked build. For a workspace, ensure all relevant packages and targets are included. Add dependency and security scanning appropriate to the organization, but review findings in context; automated advisories can be noisy and do not replace patch planning. Benchmark changes on stable hardware with a documented baseline, and track regressions at the service level as well as in a microbenchmark. Keep test output useful in CI, retain failing artifacts, and make feature/platform matrices explicit. Tooling is most effective when fast feedback is available before a change reaches a shared branch.

## Test at the right boundary

Unit tests are fast and can inspect private helpers, making them useful for invariants and branch-heavy logic. Integration tests compile like a consumer and verify public names, types, and behavior. Documentation tests ensure public examples still compile. Keep tests focused on observable contracts when practical; a harmless refactor should not break tests that merely mirror private structure.

Exercise success and failure: empty input, boundary values, malformed encodings, I/O errors, and resource limits when relevant. Table-driven tests make cases easy to review. Property-based tests explore generated inputs and general invariants; fuzzing is useful for parsers and unsafe boundaries with broad malformed-input spaces. Neither replaces regression tests for specific bugs. For deterministic logic, inject clocks and external-service traits rather than depending on wall time or a live network.

Avoid shared global state and test-order assumptions. Use temporary directories, unique ports, and cleanup for spawned tasks. Parallel runners expose accidental shared-state dependencies; serialize only tests that truly require it. Integration tests should import the crate as a downstream caller would, not rely on private module paths. This catches missing exports and awkward APIs.

## CI, lints, and performance evidence

A useful baseline is `cargo fmt --check`, `cargo clippy --workspace --all-targets`, and `cargo test --workspace`. Add `--all-features` or an explicit feature matrix when features alter behavior, and build for supported targets. `cargo check` provides fast feedback without final code generation; release-mode benchmarks are appropriate for runtime claims. Keep toolchain and dependency resolution controlled for meaningful comparisons.

Choose the benchmark question first: throughput, tail latency, memory, startup, binary size, or compile time. Use representative inputs and repeated runs; isolate the code but confirm the result in an end-to-end path. Profilers show where time is spent. A microbenchmark can reward an optimization that has no production effect. Track clean and incremental build time separately because monomorphization and procedural macros can change developer feedback loops.

Tests provide evidence, not proof for every schedule, target, feature, or hostile input. Review `unsafe` blocks and test FFI contracts with dedicated harnesses or sanitizers where available. A green suite does not replace deployment monitoring. Treat warnings and flaky tests as actionable signals rather than silencing them broadly to make CI pass.

## Keep the feedback loop trustworthy

A test suite is part of the product's interface to maintainers. Name tests after the behavior they protect, and keep fixtures small enough that a failure points to a likely cause. When a test fails intermittently, capture the timing, random seed, or external condition that makes it fail; rerunning until it passes hides the defect. Flaky tests reduce confidence in every other result, so repair or quarantine them with clear ownership rather than silently accepting instability.

Separate correctness checks from performance checks. Assertions belong in ordinary tests; benchmarks need stable inputs, release builds, controlled machine load, and a record of compiler and dependency versions. Avoid strict nanosecond thresholds in shared CI machines where scheduling noise dominates. For APIs involving time or randomness, inject deterministic sources so most tests remain reliable, then retain a smaller integration test for the real boundary. This gives fast feedback without pretending that a mocked service validates the full deployment path.
