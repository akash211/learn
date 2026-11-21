# Concurrency: Threads, Send/Sync, Channels, Mutex/Arc

Rust's concurrency model uses ownership and trait bounds to prevent data races in safe code. The compiler does not make every concurrent program logically correct: deadlocks, starvation, races in external systems, and poor scheduling remain possible. It does make many invalid ways of sharing memory unrepresentable, so synchronization decisions are explicit.

## Threads and ownership transfer

`std::thread::spawn` starts an operating-system thread. Its closure is usually `'static` because the new thread may outlive the stack frame that spawned it. `move` transfers captured owned values into the closure:

```rust
use std::thread;
let numbers = vec![1, 2, 3];
let worker = thread::spawn(move || numbers.iter().sum::<i32>());
let total = worker.join().expect("worker panicked");
assert_eq!(total, 6);
```

`join` waits for the thread and returns a `Result` because the worker may panic. Dropping a `JoinHandle` detaches the thread; it does not cancel or wait for it. In production, retain handles, use a bounded worker pool, or adopt a structured concurrency abstraction so shutdown and failure are managed deliberately. Spawning one OS thread per unbounded task can exhaust memory and scheduler resources.

## `Send` and `Sync`

`Send` means a value may be transferred to another thread; `Sync` means shared references to it may safely be used from multiple threads. Informally, `T: Sync` makes `&T` sendable. The compiler auto-implements these marker traits when a type's components satisfy the requirements. For example, `Rc<T>` is neither `Send` nor `Sync`, because its reference count is not atomic. `Arc<T>` can be sent and shared when its contents satisfy the needed bounds; `Arc<RefCell<T>>` is not thereby safe for concurrent mutation.

These traits let APIs communicate thread-safety requirements in signatures. A thread closure generally needs captured values to be `Send + 'static`; a shared reference across threads needs `Sync`. Do not add unsafe manual implementations of these marker traits unless the type's invariants have been rigorously proven. An incorrect `unsafe impl Send` or `Sync` can invalidate Rust's safety guarantees for every caller.

## Channels for message passing

A channel transfers ownership of messages between producers and consumers. Standard-library `mpsc` is multi-producer, single-consumer; sending a `String` moves it, so the sender cannot concurrently mutate the same owned string. This reduces shared-state reasoning. The standard channel is unbounded, so sustained producer overload can grow memory; use a bounded channel from an appropriate library when backpressure matters. Handle channel closure and send failures rather than assuming the receiver will live forever.

Message passing is a good default for task ownership: one worker owns a resource and receives commands. It is less suitable when the workload requires many fine-grained reads of a common large immutable structure, where `Arc` sharing may be simpler.

## Shared state with `Arc<Mutex<T>>`

`Arc<T>` gives atomically reference-counted shared ownership across threads. It does not make `T` mutable or synchronized by itself. `Mutex<T>` provides exclusive access; locking returns a guard that releases the lock when dropped:

```rust
use std::sync::{Arc, Mutex};
use std::thread;
let total = Arc::new(Mutex::new(0));
let workers: Vec<_> = (0..4).map(|_| {
    let total = Arc::clone(&total);
    thread::spawn(move || {
        *total.lock().expect("mutex poisoned") += 1;
    })
}).collect();
for worker in workers { worker.join().unwrap(); }
assert_eq!(*total.lock().unwrap(), 4);
```

A mutex serializes access, which can become a bottleneck. Keep the critical section small; do not hold a lock while waiting on network or disk I/O, calling unknown callbacks, or acquiring other locks without a consistent order. Poisoning records that a thread panicked while holding a standard mutex; decide whether to recover the protected state or report failure. `RwLock` may help read-heavy workloads, but fairness and contention behavior depend on the implementation and workload.

## Atomics and coordination

Atomic types support specific lock-free operations, often for counters and flags. Use the weakest memory ordering only when its correctness is understood; `SeqCst` is a simple default model, but atomics are not a substitute for a clear ownership design. Condition variables and barriers coordinate threads, but require correct predicates and lock handling. Prefer a proven abstraction to hand-rolled lock-free code.

## Common mistakes

- Assuming `Arc` alone makes interior mutation thread-safe.
- Detaching threads accidentally by dropping `JoinHandle`s during shutdown.
- Holding a mutex across blocking work or calling another lock in an inconsistent order.
- Using an unbounded channel without a plan for slow consumers.
- Treating `Send`/`Sync` as performance markers rather than safety contracts.

## Production notes

Bound worker count and queue depth, and define what happens when capacity is exhausted. Make shutdown observable: stop accepting new work, signal workers, drain or cancel queued tasks according to policy, and join them before exiting. Measure lock wait time and queue age, not only CPU. Document whether poison recovery is safe and whether failed messages can be retried without duplicate side effects. Keep unsafe concurrency code isolated and reviewed, and test behavior under cancellation, panics, and overloaded input. Rust prevents data races in safe code; it does not make a shared mutable architecture efficient or deadlock-proof.

## Reasoning from `Send` and `Sync`

`Send` permits ownership to move safely to another thread. `Sync` permits shared references to be used safely across threads; equivalently, `&T` is `Send` when `T: Sync`. Rust generally determines these auto traits recursively from a type's fields. A non-`Send` field such as `Rc<T>` prevents its containing value from crossing threads. These traits express safety properties, not performance promises or logical correctness.

`Arc<T>` makes shared ownership's count atomic, but does not make `T` safe for concurrent mutation. `Arc<RefCell<T>>` is not a thread-safe synchronization strategy. `Arc<Mutex<T>>` combines cross-thread ownership of the handle with exclusive access to the contents. The guard is a scoped capability: keep its lifetime short and avoid invoking unknown code while holding it, since callbacks may acquire locks or re-enter the component.

```rust
use std::sync::{Arc, Mutex};
use std::thread;
fn main() {
    let total = Arc::new(Mutex::new(0));
    let worker_total = Arc::clone(&total);
    let worker = thread::spawn(move || {
        *worker_total.lock().unwrap() += 1;
    });
    worker.join().unwrap();
    assert_eq!(*total.lock().unwrap(), 1);
}
```

This demonstrates transfer of an `Arc` clone and guarded mutation; `unwrap` is concise for a small example, not a universal production policy. Poisoning signals a panic while locked. Recovery should inspect whether the invariant remains valid rather than blindly ignoring poison. Atomics suit simple state with explicit memory-ordering requirements, not as a shortcut for compound data structures.

## Choose a coordination model

Message passing transfers owned work to a receiver and fits systems where one task should own a resource or state machine. Shared state may be simpler for brief updates guarded by one lock. Bounded channels provide backpressure; an unbounded queue can turn a slow consumer into growing memory use. Worker pools bound thread counts, while semaphores or bounded queues can limit in-flight operations.

Rust prevents data races in safe code but not deadlocks, starvation, priority inversion, or logical races such as overwriting a stale result. Establish lock ordering, set deadlines around external work, and make shutdown part of the protocol. Retain join handles or use structured ownership so worker failures are observed and tasks stop predictably. Test invariants under contention and instrument queue depth and wait time. Liveness and correctness require design beyond the compiler's type checks.

