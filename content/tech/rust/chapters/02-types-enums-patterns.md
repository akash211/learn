# Structs, Enums, Pattern Matching, and Option/Result

Rust's type system is built to make data shape explicit. A struct combines named fields; an enum represents one of several alternatives. Pattern matching then forces code to consider those alternatives. This style is more than syntax: it makes state transitions reviewable and lets the compiler identify missing cases when a type evolves.

## Structs model records

A named-field struct groups related values and gives fields domain meaning:

```rust
struct User {
    id: u64,
    display_name: String,
    active: bool,
}
let user = User { id: 7, display_name: "Mina".into(), active: true };
```

Fields are private to their module unless marked `pub`; visibility on a struct and its fields are separate decisions. This lets a module protect invariants instead of exposing raw mutable state. Tuple structs are useful for compact wrappers, such as `struct UserId(u64);`, which prevents accidentally passing a byte count where a user ID is expected. Unit structs carry no data and can represent a marker or zero-sized type.

Struct update syntax (`User { active: false, ..user }`) moves remaining fields from `user` unless those fields are `Copy`. Derive common behavior—`Debug`, `Clone`, `PartialEq`, and others—with `#[derive(...)]` when the semantics fit. Do not derive `Copy` casually: it implies assignment duplicates the value, which is only suitable for small values without owned resources.

## Enums make alternatives explicit

An enum is a tagged union: each value is exactly one declared variant. Variants can carry different data:

```rust
enum Message {
    Quit,
    Text(String),
    Move { x: i32, y: i32 },
}
```

This is safer than a collection of booleans and optional fields that can encode contradictory combinations. A `Message` cannot simultaneously be `Quit` and `Move`; the variant tells consumers how to interpret its payload. Add methods with `impl` blocks to keep behavior near the type. Public enums are an API commitment: adding a variant can break exhaustive matches in downstream crates, so consider whether to use a non-exhaustive API where forward evolution matters.

## Pattern matching and destructuring

`match` checks every possible value unless a wildcard handles the remainder. Patterns can bind payloads, destructure structs, and guard a case with an `if` condition:

```rust
fn describe(message: Message) -> String {
    match message {
        Message::Quit => "quit".into(),
        Message::Text(text) => format!("text: {text}"),
        Message::Move { x, y } if x == 0 && y == 0 => "no movement".into(),
        Message::Move { x, y } => format!("move to {x},{y}"),
    }
}
```

The arm order matters when patterns overlap. `if let` is a concise choice when one pattern is interesting and other cases can be ignored; `let ... else` is useful for early exit while preserving a successful binding. Use a full `match` when handling every branch is important for correctness. Avoid `_` in a match merely to suppress a compiler warning if a new variant should trigger a code review; a wildcard can hide newly introduced cases.

## Option represents possible absence

`Option<T>` is either `Some(T)` or `None`. It is the standard way to represent a value that may not exist, such as a missing configuration setting or a map lookup. It replaces null-like sentinels with a type the compiler makes you handle. Methods such as `map`, `and_then`, `unwrap_or`, and `ok_or` transform the value without manually nesting matches. `unwrap()` is appropriate only when absence is genuinely impossible and the invariant is clear; otherwise it turns expected missing data into a panic.

```rust
fn username(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}
```

Do not confuse `Option<T>` with `Result<T, E>`: absence is not necessarily an error. A missing optional nickname can be normal; failure to read a required configuration file is an error and deserves context.

## Result represents success or failure

`Result<T, E>` contains `Ok(T)` or `Err(E)`. The success and error types are explicit, and callers may propagate or handle errors. Pattern matching, `map_err`, and the `?` operator compose operations. `Result` is not restricted to exceptions: it is a regular value and can be stored, inspected, and tested.

A useful design models errors at meaningful boundaries. Convert low-level errors when adding context or when a public API needs a stable error type; do not erase useful information by converting every failure to a generic string. In a CLI, a `main` returning `Result<(), Box<dyn std::error::Error>>` is often enough for a small program, while a reusable library benefits from a documented error enum.

## Common mistakes

- Using `Option` for failures that need an explanation; use `Result` when a caller should know why.
- Calling `.unwrap()` on data from files, networks, or users without an explicit invariant.
- Adding a wildcard match that silently treats a new enum variant like an old one.
- Making every field public and losing the ability to enforce invariants.
- Using parallel boolean flags where an enum can represent mutually exclusive states.

## Production notes

Treat types as contracts. Newtypes such as `UserId(u64)` and `Meters(f64)` prevent category errors at compile time. Private fields plus constructors can reject invalid states once, rather than repeating checks throughout the system. Keep enum variants and error types stable when they cross crate or service boundaries, and test both success and failure cases. Exhaustive matching is a maintenance advantage: when a new state is added, the compiler points to code that must decide what it means.

## Make invalid states difficult to construct

Enums become especially useful when each state carries the data it requires. A job might be `enum Job { Queued, Running { started_at: u64 }, Failed { message: String }, Finished { code: i32 } }`. A `Running` value then always has its start time, and a finished one always has a result code. Independent booleans and optional fields can permit contradictory combinations. Private fields and constructors can further control transitions when arbitrary state changes would break an invariant.

```rust
#[derive(Debug)]
enum State { Pending, Done(u32), Failed(String) }
fn describe(state: State) -> String {
    match state {
        State::Pending => String::from("waiting"),
        State::Done(count) => format!("processed {count}"),
        State::Failed(message) => format!("failed: {message}"),
    }
}
fn main() { assert_eq!(describe(State::Done(3)), "processed 3"); }
```

An exhaustive match asks for a decision when a new variant is added. A wildcard is appropriate when intentionally grouping unknown alternatives, but can hide a new state that deserves different behavior. Use it as a policy, not just to silence a diagnostic.

## Matching and composing values

Matching an owned enum may move its payload. If the original value must remain available, match on `&value` or use `option.as_ref()` to borrow. Bindings follow the matched place's ownership, which is why matching a `String` can surprise callers by consuming it. `Option` and `Result` provide `map` for transformation, `and_then` for chaining another optional or fallible operation, and `unwrap_or_else` for a lazy fallback. Use a full `match` when branches need distinct side effects or represent important decisions.

`?` converts `Option` to `Result` only when you explicitly choose an error with `ok_or`; Rust cannot infer what absence means in a particular domain. At parsing boundaries, distinguish an ordinary missing value from malformed input. This keeps signatures informative and makes callers decide whether to supply a default, report a user error, or propagate failure. Tests should cover both the expected variant and the absence or error case so a later model change does not silently alter behavior.

