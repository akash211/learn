# Modules, Crates, Cargo, and Workspaces

Rust's package structure has a few distinct layers. A module organizes names and visibility inside a crate. A crate is a compilation unit: a library crate or a binary crate. A package is a Cargo-managed project that may contain one library, multiple binaries, examples, tests, and build configuration. A workspace groups packages that should share development and dependency context. Keeping these terms straight makes project layouts and dependency boundaries easier to reason about.

## Modules and visibility

A module tree starts at the crate root (`src/lib.rs` or `src/main.rs`) and can be declared inline or in another source file. `mod parser;` loads a sibling module file according to Rust's module path rules, while `pub mod parser;` also exposes the module externally. Items are private by default. `pub` exposes an item, but visibility is constrained by every parent module in its path. This allows a crate to keep implementation details private and re-export a deliberate public API.

`use` brings a path into lexical scope; it does not change visibility. Re-export with `pub use` when a type should be accessible through a stable, simpler path. For example, a crate can keep `internal::storage::Pool` private in its layout while re-exporting a public `Pool` at the crate root. This decouples external users from internal file organization. `super` refers to the parent module and `crate` to the crate root. Prefer explicit imports over many glob imports in application code, because they make dependencies and name origins easier to review.

Visibility levels include private, `pub(crate)`, and `pub(super)`. Choose the narrowest visibility that supports the caller. Public struct fields let callers bypass invariants; private fields plus constructors and accessors preserve control. Rust's module system is not identical to filesystem directory structure, although the conventional layout follows it. Moving a module can require path updates unless the public surface is insulated with re-exports.

## Crates and packages

A crate is compiled as a library or executable. `src/lib.rs` defines a library crate; `src/main.rs` defines a binary. A package can contain both, and a `src/bin/` directory may hold additional binaries. Integration tests in `tests/` compile as separate crates and exercise the public API, while unit tests inside a module can access private items through child test modules. Examples in `examples/` are useful as executable documentation.

Cargo.toml declares package metadata, dependencies, features, targets, and edition. Cargo.lock records resolved dependency versions for an application and should generally be committed for binaries and workspaces; library crates commonly omit it from published packages so downstream applications resolve their own graph. Cargo downloads registry crates, builds them, runs tests, and coordinates compiler invocations. Use `cargo check` for fast type checking without full code generation, `cargo build` for binaries, and `cargo test` for tests.

## Dependencies and features

A dependency requirement in Cargo.toml is a version constraint; Cargo resolves compatible versions and records a precise graph in the lockfile. Pinning every crate to an exact version is not automatically more secure; reproducibility comes from reviewing and committing the lockfile, while updates should be deliberate. Features enable optional functionality and can affect the dependency graph and binary. Be explicit about default features when footprint, TLS backend, or build policy matters. Avoid enabling broad feature sets just to make one API compile; inspect the crate's feature documentation and use `cargo tree -e features` to understand what is activated.

## Workspaces

A workspace root lists member packages and can centralize dependency versions using workspace dependencies. Members share a lockfile and build output directory, which makes coordinated changes and local crate development easier. A workspace is not itself necessarily a published package. Workspace-level configuration reduces version drift, but each member still has its own public API and tests. Use path dependencies between members during development and preserve clear crate boundaries; splitting every module into a package adds maintenance cost.

## Common mistakes

- Confusing a module, crate, package, and workspace when diagnosing a path or build issue.
- Assuming `use` makes a private item public; external exposure requires `pub` at the relevant path.
- Publishing internal module paths as the only API and making refactors unnecessarily breaking.
- Ignoring Cargo features and pulling in unwanted TLS, platform, or optional dependencies.
- Omitting an application lockfile and losing repeatable dependency resolution.

## Production notes

Treat Cargo.toml and Cargo.lock as production inputs. Review dependency ownership, release cadence, licenses, feature defaults, and transitive dependency changes. Use a workspace when packages are developed and versioned together, not simply to create more directories. Run `cargo tree` during dependency investigations and `cargo metadata --locked` in CI to ensure the lockfile is usable. Public crates should document supported Rust versions and feature combinations, and test that matrix. Keep secrets and environment-specific configuration out of source control; Cargo configuration can tune builds, but it is not a substitute for deployment configuration management.

## Cargo workspaces in practice

A workspace groups related packages under one root manifest, useful when a repository contains a library, application, and test or tooling crates that should evolve together. A virtual workspace can look like this:

```toml
[workspace]
members = ["crates/core", "apps/cli"]
resolver = "2"
```

Each member has its own package identity, manifest, targets, and API. A member can depend on a sibling by path, for example `core = { path = "../../crates/core" }`. The workspace normally shares one `Cargo.lock`, but it is not one crate: packages can have separate APIs and be versioned or published independently. Workspace dependency declarations reduce duplication when members intentionally share a requirement. Specify features carefully because dependencies' features may be unified.

Run `cargo test --workspace` to test all members and `-p package-name` to focus on one. CI should cover the features and targets that ship; testing only default features does not exercise every configuration. Workspace-wide lint and package metadata can reduce drift, while per-member settings are suitable for real differences. Put integration tests and examples near the package whose public API they exercise.

## Dependencies, features, and builds

`Cargo.toml` declares version requirements and features; Cargo resolves exact versions into the lockfile. Applications and workspaces commit it, while published libraries normally let downstream applications choose their graph within compatible requirements. `--locked` makes Cargo fail rather than silently updating a lockfile, useful for reproducible CI.

Features are compile-time switches, often for optional dependencies or code paths. They are not runtime configuration and can be additive across a dependency graph. Test important combinations and avoid poorly documented mutually exclusive feature sets. Build scripts execute during compilation and may generate code or link native libraries, making builds dependent on the host, target, and environment. Cross compilation needs a linker and target libraries, not merely an installed Rust target. Pin the toolchain when reproducibility matters and record native inputs; a workspace and lockfile alone do not guarantee bit-for-bit identical artifacts.

