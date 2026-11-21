# Error Handling with Result and the ? Operator

Rust represents recoverable failure in the type system. A function that can fail returns `Result<T, E>`, where `Ok(T)` is success and `Err(E)` carries a reason. Callers must decide whether to handle, transform, or propagate that error. This is explicit control flow rather than hidden exception propagation, and it makes error behavior visible in signatures and tests.

## Propagating errors with `?`

The `?` operator unwraps an `Ok` value or returns an error from the current function. The function's return type must be compatible with that error, either directly or through a conversion such as `From`:

```rust
use std::{fs, io};
fn read_config(path: &str) -> Result<String, io::Error> {
    let contents = fs::read_to_string(path)?;
    Ok(contents)
}
```

This is concise but still explicit: `read_config` returns `Result`. The operator also works with `Option` in a function returning `Option`, short-circuiting on `None`. It is not a general exception mechanism, and it cannot be used to discard failures. Keep `?` at boundaries where propagation is the right policy; catch or translate an error when the current layer can meaningfully recover, add context, or choose a user-facing response.

## Choosing error types

A library should usually expose a stable error type that describes meaningful failure categories. An enum can distinguish invalid input, missing resources, and lower-level I/O errors; variants can wrap source errors. Implementing `std::error::Error` and `Display` makes the error usable with standard tooling. `thiserror` is commonly used to derive these implementations, but the design remains the same without a dependency.

An application often has a wider error boundary. A CLI's top-level function may return `Result<(), Box<dyn std::error::Error>>`, while a service may map internal failures to a protocol response and log detailed causes. `anyhow` and similar crates make application-level error propagation convenient, but a public library API should avoid an opaque erased error if callers need to match particular cases. Avoid converting errors to strings too early: doing so often loses the source chain and makes programmatic handling difficult.

Use `map_err` when a conversion is local and meaningful. Add context that helps answer which operation or resource failed, not context that simply repeats the lower-level message. A useful error chain preserves the original source while adding operation context, such as “load application configuration” around an operating-system error.

## Handling rather than propagating

A caller may recover from an error. For a cache, a failed read might mean “treat as a miss”; for an optional feature, unavailable configuration may select a documented default. Handle the error at the layer that owns this policy. Logging and then returning the same error often produces duplicate logs at every call boundary; prefer one layer to report the failure with relevant request or operation context.

`unwrap` and `expect` panic on `Err`. They are acceptable in tests, quick prototypes, or after an invariant has been established and clearly documented. They are risky in long-running services and on user-controlled input, where an ordinary failure should not terminate a request task or process. `expect("... invariant ...")` is more useful than a bare `unwrap` when a panic is truly justified.

## The `main` boundary and conversion

Since Rust 2018, `main` may return a `Result`, allowing `?` in the entry point. A simple binary can return `Result<(), Box<dyn std::error::Error>>`. This is convenient for a small tool; a mature application may instead parse arguments, call a fallible `run` function, and format errors at the boundary so it controls exit codes and user-facing text.

The `From` trait underlies many `?` conversions. If a function returns `Result<T, AppError>`, the compiler can convert an `io::Error` when `AppError: From<io::Error>`. This helps compose layers, but do not add broad conversions that erase distinctions or create surprising behavior. `?` only converts the error type; it does not automatically attach meaningful context.

## Common mistakes

- Calling `.unwrap()` on file, network, or parse operations in a production path.
- Using `Result<T, String>` throughout a library, losing typed cases and source chains.
- Logging the same propagated error at multiple layers.
- Catching an error where no recovery policy exists, then silently continuing with invalid state.
- Assuming `?` adds context or retries an operation; it only propagates a compatible error.

## Production notes

Errors are part of an API contract. Document which failures are expected, whether an operation is safe to retry, and whether it may have partially changed state before failing. Preserve source errors, redact secrets from messages, and avoid including raw user input without escaping. At service boundaries, map internal categories to stable responses while keeping diagnostic details in structured logs. Test the error paths, not only success: malformed input, unavailable dependencies, permission errors, cancellation, and timeouts often reveal whether propagation boundaries are placed correctly. Keep the retry policy outside a low-level function unless that function owns the idempotency guarantee; retrying a non-idempotent write can create duplicates.

## Design errors at layer boundaries

Useful errors preserve actionable categories and source information. A library may distinguish `InvalidPort`, `ConfigNotFound`, and `Io(io::Error)` instead of returning a formatted string. Callers can match stable cases, while a wrapped source retains its cause. Add context at the layer that understands it: a parser knows which field failed, while an application boundary knows the path or request identifier. Logging the same error at every layer creates duplicate noise; usually report it where it becomes actionable.

```rust
use std::{fs, io};
fn load(path: &str) -> Result<String, io::Error> {
    fs::read_to_string(path)
}
```

With multiple failure types, `?` uses `From` conversions when available. Libraries can define an error enum manually or use a derive crate such as `thiserror`; an application boundary may prefer an erased error if callers need reporting rather than matching internal variants. Keep the public error contract intentional instead of exposing incidental dependency details.

## Recover, propagate, or report

At each failure point, ask whether this layer can recover. A failed cache lookup may permit a database fallback; malformed configuration may have no safe fallback and should propagate. A transport layer can return an I/O error while a command-line boundary adds context and chooses an exit code. Retry only plausibly transient failures, with limits and backoff, and consider idempotency: after a timeout, a remote write may have succeeded even though its response was lost. Validation and permission errors rarely improve through retries.

Panics represent violated internal assumptions or bugs, not routine invalid input. Libraries should avoid panicking on ordinary external data. Catching a panic is useful only at an explicit containment boundary, such as an isolated plugin, not as a substitute for `Result`. Test error variants and source preservation without depending on unstable message formatting. This keeps failure paths explicit while allowing each layer to apply the policy it understands.

