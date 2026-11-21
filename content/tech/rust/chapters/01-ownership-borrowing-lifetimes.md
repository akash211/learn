# Ownership, Borrowing, and Lifetimes

Rust's ownership model answers a basic resource question: who is responsible for a value, and how long may code access it? The compiler enforces the answer at compile time. This replaces a tracing garbage collector for ordinary memory management and prevents safe code from using freed memory. It also shapes API design: functions communicate whether they consume, inspect, or mutate values through their parameter types.

## Move semantics and ownership

Every value has one owner. When the owner leaves scope, its value is dropped. Assigning a non-`Copy` value to another binding moves ownership rather than silently duplicating it:

```rust
let name = String::from("Ada");
let moved = name;
// println!("{name}"); // error: `name` was moved
println!("{moved}");
```

A `String` owns a heap allocation, so a shallow bitwise copy would leave two values believing they own the same allocation. Moving transfers that responsibility. Types implementing `Copy` (such as integers and `bool`) are cheap fixed-size values whose assignment copies them; `Copy` cannot be implemented for a type that owns a `String` or another non-Copy resource. For an explicit deep clone, use `.clone()`, recognizing that it may allocate and copy a large structure.

Function calls follow the same rules. Passing a `String` by value transfers it into the function; returning it can transfer it back. If the caller should retain ownership, borrow instead. This gives a useful first API decision: take ownership when the callee must keep or transform a resource, borrow for temporary observation or mutation, and return an owned value when the caller needs an independent lifetime.

## References and borrowing

A reference lets code use a value without becoming its owner. `&T` is a shared, read-only borrow; `&mut T` is an exclusive mutable borrow. At any instant, Rust permits either multiple shared references or one mutable reference to a value, but not both. The rule prevents a reader from observing a value while another path mutates it, and makes aliasing assumptions visible to optimising code.

```rust
fn byte_count(s: &str) -> usize { s.len() }
fn append_mark(s: &mut String) { s.push('!'); }

let mut text = String::from("hello");
let n = byte_count(&text);
append_mark(&mut text);
println!("{n}: {text}");
```

A borrow must not outlive the referent. The compiler computes scopes and control-flow-sensitive borrow regions, rather than letting references dangle. In the example, `byte_count`'s reference ends after the call, so a later mutable borrow is legal. Keep references short and localized; storing references for a long time often signals that an owned value, an index, or a different data structure would clarify the design.

Slices (`&str`, `&[T]`) are borrowed views over contiguous data. They are useful interfaces because they accept many concrete owners: `&String` coerces to `&str`, and `&Vec<T>` to `&[T]`. Prefer slice parameters when a function only needs to inspect text or a sequence. A `String` parameter suggests ownership is required.

## Lifetimes: relationships, not timers

A lifetime is a compile-time name for how long a reference is valid. Most lifetimes are inferred. An explicit lifetime annotation does not extend a reference's validity; it states a relationship the compiler must verify. For example, `fn longer<'a>(x: &'a str, y: &'a str) -> &'a str` says the result comes from one of the inputs and is valid for no longer than the shared lifetime of both. The function cannot safely return a reference to a local `String`, because that local is dropped on return.

Structs that store references must state their lifetime relationship:

```rust
struct Label<'a> { text: &'a str }
let source = String::from("ready");
let label = Label { text: &source };
println!("{}", label.text);
```

Here `label` cannot outlive `source`. In application code, an owned `String` field may be simpler if the struct must outlive its input. Lifetimes are especially visible in parsers and views, where avoiding copies is valuable, but adding them indiscriminately can make an API unnecessarily restrictive.

## Borrowing across control flow

Non-lexical lifetimes (NLL) allow a borrow to end after its last use, even if its binding remains in scope. This is why the following works: the immutable borrow `first` is no longer used before the mutation.

```rust
let mut values = vec![10, 20];
let first = &values[0];
println!("{first}");
values.push(30);
```

By contrast, returning references into a growable `Vec` and then pushing can invalidate them if reallocation occurs. The borrow checker rejects this. Reorganize the operation: copy a `Copy` value, use an index and re-look-up after mutation, or split the work into phases. `split_at_mut` and related safe APIs express disjoint mutable regions when the compiler cannot infer disjointness from indexing.

## Common mistakes

- Cloning to silence a borrow error without checking whether the copy is semantically needed or expensive.
- Treating lifetime annotations as a way to keep data alive. They only constrain valid use.
- Returning a reference to a local variable. Return an owned value or borrow from an input.
- Storing references in long-lived structs where owned fields would simplify the API.
- Keeping a mutable reference across a call that also needs to access the same owner.

## Production notes

Ownership is not a requirement to avoid all sharing. `Box<T>` gives one heap-owned value, `Rc<T>` shares ownership in a single-threaded context, and `Arc<T>` shares atomically across threads. Interior mutability (`Cell`, `RefCell`, `Mutex`) moves some checks to runtime or synchronization, with explicit trade-offs. Start with direct ownership and references; add shared ownership only when the relationship really is shared. In reviews, explain the resource boundary and why cloning, reference counting, or interior mutability is appropriate. A borrow-checker error is often useful evidence that the design has an unclear lifetime or ownership handoff, not an invitation to add a broad escape hatch.

## Borrowing in a worked example

Suppose a caller owns a list of names and wants the longest one. Passing the vector by value would transfer it even though the function only inspects its contents. A borrowed slice expresses the narrower contract:

```rust
fn longest_name(names: &[String]) -> Option<&str> {
    names.iter().map(String::as_str).max_by_key(|name| name.len())
}
fn main() {
    let names = vec![String::from("Ada"), String::from("Grace")];
    let longest = longest_name(&names);
    assert_eq!(longest, Some("Grace"));
    assert_eq!(names.len(), 2);
}
```

The returned `&str` points into an element of the borrowed slice. Its validity is limited by the borrow of `names`; the function cannot return a reference to a local `String` it creates and then drops. An explicit equivalent signature is `fn longest_name<'a>(names: &'a [String]) -> Option<&'a str>`. A mutable borrow is exclusive for its duration. For example, `fn add_default(items: &mut Vec<String>)` grants mutation access while excluding overlapping reads through other references. Non-lexical lifetimes often let a borrow end after its last use, but the rule concerns actual overlapping access, not indentation.

## Lifetime elision rules

Rust applies three lifetime elision rules. Each elided reference parameter gets its own lifetime. If there is exactly one input lifetime, that lifetime is assigned to elided output references. For methods, an elided output lifetime is assigned the lifetime of `&self` or `&mut self` when present. Thus `fn first(s: &str) -> &str` is unambiguous: the result is tied to its sole input.

When multiple reference inputs could be the source of a returned reference, spell out the relationship: `fn choose<'a>(left: &'a str, right: &'a str) -> &'a str`. This says that either result lives no longer than the common `'a`; it does not require both strings to share storage. Lifetimes are compile-time constraints, not runtime values or a way to extend storage. A struct containing references must declare the relationship too, such as `struct Excerpt<'a> { text: &'a str }`.

Choose owned fields when the value must outlive its source or cross an ownership boundary independently. `'static` means a reference is valid for the whole program, as string literals are; it is not a general repair for borrow-checker errors. When a borrowed API becomes awkward, return an owned `String`, an index, or a value object if that better expresses the intended contract.

