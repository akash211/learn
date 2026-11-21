# Server-side Programming

Azure Cosmos DB's native NoSQL API supports server-side JavaScript stored procedures, triggers, and user-defined functions (UDFs). These features execute close to data and can be useful for bounded operations that need one logical partition's transactional scope. They are not a general replacement for application services, and they bring language, deployment, execution-budget, and portability constraints. Prefer SDK-side transactional batch for ordinary point operations when it fits; use server-side code only when the server execution semantics solve a real problem.

## Stored procedures

A stored procedure is JavaScript registered against a container and invoked through an SDK with a partition-key value. Its operations execute transactionally within that logical partition: if the procedure fails, its transaction is rolled back. That can make a procedure useful for coordinating several reads and writes over a small set of items sharing the same key. It cannot provide an atomic transaction across logical partitions or include an external HTTP service, queue, or payment provider.

Stored procedures run within a bounded execution budget and can be interrupted when they exceed service limits. Long-running loops and unbounded scans are therefore poor fits. The response should communicate progress or continuation state when an operation must be split into multiple calls; each invocation is a separate transaction, so the application must handle partial overall progress safely. Do not design a large migration as one stored procedure and expect it to run indefinitely.

Keep procedures small, deterministic, and versioned. Validate the partition key and input shape, avoid dependence on mutable global state, and return explicit result information. A procedure deployment is a database-side artifact: CI/CD should create or replace it in each environment, test its behavior, and roll back intentionally. Treat the procedure's version and contract like application code, rather than editing production manually.

## Triggers

A trigger is JavaScript associated with an item operation in the native NoSQL API. Pre-triggers run before the operation and can inspect or modify the request; post-triggers run after the operation within the transactional execution. The client must explicitly request the relevant trigger, so a trigger is not necessarily an invisible database constraint applied to every writer. That detail is a common source of inconsistent data when some code paths omit the trigger.

Triggers can enforce narrow data-shape rules or augment an item write, but they do not replace a deliberate validation strategy. Important constraints should be enforced consistently across all writers; where the native API provides a suitable declarative mechanism, prefer that over hidden JavaScript. Keep trigger effects transparent, documented, and covered by tests that exercise every SDK write path.

## User-defined functions

A UDF is a JavaScript function invoked in a NoSQL query, commonly to perform a custom computation on item values. UDFs can be convenient for query-time transformations but may limit query optimization or make computation harder to inspect. They are not a mechanism for mutating data and should not be confused with stored procedures. If a value is used frequently in filters or ordering, computing it during writes and storing a derived field may be more efficient, provided the application owns the consistency of that derived value.

A UDF should be pure and predictable, with explicit behavior for missing, null, or malformed values. Profile the query with and without the UDF and test its effect on RU charge and index use. High-cardinality client logic buried in a server-side function can turn a seemingly concise query into expensive execution.

## When to move logic server-side

Use a stored procedure when a multi-item invariant is strictly partition-local, needs an atomic read-modify-write sequence, and cannot be expressed clearly as conditional point operations or transactional batch. Use a trigger only when its opt-in execution semantics are acceptable and all callers reliably invoke it. Use a UDF when the query requires a modest reusable calculation that cannot reasonably be materialized. For general business workflows, orchestration, external calls, retries, and long-running work belong in application code or a workflow service.

Before choosing server-side JavaScript, ask whether a transactional batch gives clearer typed SDK code, easier code review, and simpler deployment. A batch is constrained to one partition as well, but its operations are explicit in the language of the application. Server-side code can reduce round trips for small operations; that benefit should be measured against maintainability and runtime limits.

## Common mistakes

- Assuming a stored procedure can transact across partition keys or external systems.
- Writing unbounded loops or scans that exceed execution limits.
- Treating a trigger as automatic when the client must explicitly request it.
- Putting frequently filtered computation into a UDF without checking query and index costs.
- Deploying stored procedures outside source control and losing a reproducible version history.

## Production notes

Use the NoSQL API's documented JavaScript runtime and stay within supported language features. Keep functions small and unit-test pure logic outside the service where possible, then integration-test actual service behavior. Include deployment ordering, rollback, partition-key requirements, and timeout handling in operational docs. Feature availability and runtime limits can vary by service evolution; verify current documentation before depending on a preview or undocumented behavior.

## Testing and deployment discipline

Server-side JavaScript should be treated as a versioned program with a deployed contract. Store source in the same repository as the application, name versions clearly, and make deployment repeatable for development, test, and production. A deployment check should confirm that the expected procedure, trigger, or UDF exists and that the application is invoking the intended version. If application rollout and procedure rollout are not atomic, use a compatibility window in which both versions can operate safely.

Test malformed inputs, missing properties, empty query results, and execution-budget exhaustion. A procedure that succeeds on a small fixture may fail when one logical partition is large or contention increases. Ensure that callers interpret the response and continuation information instead of assuming that a partial loop completed all work. Keep external side effects outside procedure execution: a retry or rollback cannot undo a message already sent to another system. Use an outbox when the event must follow the data mutation.

For each server-side function, write down why an SDK-side implementation is insufficient, what partition key is required, and how failures are observed. Measure the round trips and RU charge rather than assuming server-side code is automatically faster. If the only benefit is obscurity or fewer lines in the client, the maintenance and debugging costs are unlikely to be justified. Reassess legacy procedures when moving API or SDK versions, because the target service may not expose the same runtime behavior.

## Review checklist

Before release, confirm the code is supported by the NoSQL API, has an explicit partition key, stays within a bounded workload, and is deployed repeatably. Exercise success, validation failure, timeout, and retry paths through the actual SDK. Confirm that the client knows whether the full operation completed and can safely retry. If these guarantees are difficult to explain, move the logic into a clearer application transaction or workflow rather than expanding the server-side script.

