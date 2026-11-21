# Traits, Generics, and Trait Objects

Traits describe shared behavior without requiring a common class hierarchy. Generics let one implementation work with multiple concrete types, while trait objects enable runtime polymorphism across types that implement a trait. Understanding the boundary between those approaches helps build APIs that are reusable without obscuring costs or imposing unnecessary complexity.

## Traits are behavioral contracts

A trait declares methods a type must provide and may provide default method bodies. An implementation connects a concrete type to that contract:

```rust
trait Summary {
    fn headline(&self) -> &str;
    fn preview(&self) -> String {
        format!("{}…", self.headline())
    }
}
struct Article { title: String }
impl Summary for Article {
    fn headline(&self) -> &str { &self.title }
}
```

The `impl Trait for Type` relationship is explicit, checked by the compiler, and can be used by generic bounds. Inherent methods (`impl Article`) belong to the type itself; trait methods are available when the trait is in scope. Standard traits such as `Display`, `Iterator`, `From`, and `Error` integrate a type with the wider ecosystem. Derive macros implement suitable common traits from the type's fields.

## Static dispatch with generics

A generic function can require a trait using a bound. The compiler checks that every used type supports the required behavior and generally creates specialized machine code for each concrete type (monomorphization):

```rust
fn print_summary<T: Summary>(item: &T) {
    println!("{}", item.preview());
}
```

This is static dispatch: the call target is known at compile time, allowing inlining and optimization. It has no per-call virtual dispatch, but may increase compile time and binary size when many types instantiate a generic. A `where` clause is useful when bounds are long or apply to associated types: `where T: Summary + Send`. Bounds should describe what an implementation actually needs, not serve as a proxy for a particular concrete type.

Generic types can constrain operations while preserving type relationships. For example, a `Vec<T>` can store any `T`; a function requiring `T: Ord` can sort only values that define a consistent order. Associated types let a trait choose one related type per implementation, as `Iterator` does with `Item`. This differs from an additional generic parameter: an iterator implementation has one item type, not many independently selected item types.

## Trait objects and dynamic dispatch

When a collection needs to hold heterogeneous implementations, a trait object such as `Box<dyn Summary>` stores a value behind a pointer and uses a vtable for method calls. The type is erased at compile time, and the concrete method is selected dynamically:

```rust
let items: Vec<Box<dyn Summary>> = vec![
    Box::new(Article { title: "Release".into() }),
];
for item in &items { println!("{}", item.preview()); }
```

Trait objects usually require a pointer because different implementors can have different sizes. They can add allocation and indirect-call overhead, although the practical impact depends on workload and optimization. A trait used as `dyn Trait` must be object-safe (dyn-compatible): in general, methods cannot require `Self: Sized`-dependent behavior or have generic type parameters that would make a fixed vtable impossible. Some traits intentionally include methods unavailable through a trait object.

Use generics when the caller knows the concrete type and static dispatch is useful. Use `dyn Trait` when runtime heterogeneity, plugin-like boundaries, or reduced generic exposure is more important. Enums are often simpler when the set of alternatives is closed and small; they preserve exhaustive matching and avoid a trait-object allocation for each value.

## Bounds, coherence, and API design

Rust's coherence rules prevent conflicting implementations of a trait for a type. The orphan rule generally requires the trait or type to belong to the crate writing the implementation, preventing two unrelated crates from defining incompatible behavior for the same pair. Extension traits can add methods to foreign types within a crate, but they must be imported to use those methods.

Blanket implementations apply to a family of types, such as an implementation for every `T` satisfying another bound. They are powerful but can conflict with future implementations, so avoid overly broad blanket impls in public libraries. Newtypes provide a local type when you need to implement a foreign trait for a foreign representation.

## Common mistakes

- Using `dyn Trait` everywhere even when generic static dispatch or a simple enum fits better.
- Requiring a large trait when a function needs only one small capability.
- Assuming a trait bound creates inheritance or carries data; traits specify behavior.
- Adding blanket implementations that constrain downstream users or block future API evolution.
- Treating monomorphization as always free: many generic instantiations can raise compile time and code size.

## Production notes

Design public traits sparingly. A public trait is difficult to evolve because downstream crates may implement it; adding a required method breaks those implementors. Default methods, non-exhaustive types, and sealed traits can help, but each has trade-offs. Document behavioral expectations—whether a method may block, panic, allocate, or be called concurrently—because the compiler cannot express all semantic guarantees. In performance-sensitive code, first select dispatch based on API requirements, then profile the real workload rather than assuming virtual dispatch dominates. Keep generic bounds comprehensible and prefer named helper traits or concrete functions when abstractions obscure ownership or error flow.

## Choosing generics or a trait object

This is not simply a “fast versus slow” choice. Generics fit when a caller's concrete type is known, when associated types matter, or when compile-time optimization is valuable. Each concrete instantiation can be monomorphized, enabling inlining but possibly increasing compile time and binary size. A trait object erases the concrete type behind a pointer and vtable. It is useful when runtime configuration selects an implementation or one collection must hold heterogeneous values. Dynamic calls add indirection; `Box` also allocates, costs that may be negligible compared with I/O or domain logic. Measure on a representative workload.

```rust
trait Render { fn render(&self) -> String; }
struct Label(String);
impl Render for Label { fn render(&self) -> String { self.0.clone() } }
struct Badge(u8);
impl Render for Badge { fn render(&self) -> String { format!("badge {}", self.0) } }
fn render_all(items: &[Box<dyn Render>]) -> Vec<String> {
    items.iter().map(|item| item.render()).collect()
}
fn main() {
    let items: Vec<Box<dyn Render>> = vec![Box::new(Label("ready".into())), Box::new(Badge(3))];
    assert_eq!(render_all(&items).len(), 2);
}
```

The trait is dyn-compatible because its method has a fixed receiver and return type. Generic methods, methods returning `Self` in many positions, and some associated-type designs cannot be called through `dyn Trait` without redesign or `where Self: Sized` restrictions. A closed set of alternatives may fit an enum better and preserve exhaustive matching.

## Bounds are contracts

Use the narrowest bound that supports the operation: `T: Display` is clearer than a broad custom trait if formatting is all that is required. `where` clauses help express complex bounds; associated types model related types such as an iterator's `Item`. Avoid generalizing a small function unless reuse or a clearer contract results. Public traits are compatibility commitments because downstream crates may implement them; adding a required method can break those implementations. Default methods and sealed traits offer different trade-offs. Test public APIs from an integration test where practical, and document what capability each bound represents.

