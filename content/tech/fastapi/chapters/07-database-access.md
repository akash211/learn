# Database Access Patterns

Database correctness depends less on whether a route uses `async def` than on whether its driver and session lifecycle match the execution model. A service can use FastAPI with synchronous SQLAlchemy, async SQLAlchemy, or another persistence layer. The important rules are to keep sessions isolated per unit of work, make transaction boundaries explicit, close resources reliably, and avoid doing blocking I/O on the event loop.

## Choosing sync or async SQLAlchemy

SQLAlchemy offers a synchronous API (`Engine`, `Session`) and an asyncio extension (`AsyncEngine`, `AsyncSession`). The async extension requires an async-capable database driver, for example an appropriate async PostgreSQL driver. An `AsyncSession` is not a thread-safe session and must not be shared across concurrent tasks. A normal synchronous `Session` should not be called directly from an `async def` endpoint because its database I/O blocks the loop. Either use a synchronous endpoint so framework execution occurs in a worker thread, or adopt the async engine and await database operations.

Create the engine and session factory once for each application process, commonly during startup/lifespan. Create a session for each request or explicit unit of work. Each Uvicorn worker is a separate process and therefore constructs its own pool; multiply pool size by worker count and deployment replicas when budgeting database connections.

```python
from collections.abc import AsyncIterator
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)
from fastapi import Depends
from typing import Annotated

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False)

async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionFactory() as session:
        yield session

SessionDep = Annotated[AsyncSession, Depends(get_session)]
```

For a complete application, create and dispose the engine in lifespan and ensure shutdown awaits `engine.dispose()`. The example makes the per-session context boundary visible. Do not create a new engine for every request: that defeats pooling and adds connection setup overhead. Conversely, do not keep a session open as a process-wide singleton.

## Transactions and service boundaries

A session manages an identity map and transaction state. A route that writes should decide when to commit and what failure means. A common explicit pattern is `async with session.begin():` around a unit of work; successful exit commits and an exception rolls back. Another design commits explicitly after service logic. Avoid committing inside a generic dependency that is also used by read-only routes unless the convention is deliberate and well tested.

```python
from sqlalchemy import select

async def create_order(session: AsyncSession, payload: OrderIn) -> Order:
    async with session.begin():
        order = Order(customer_id=payload.customer_id)
        session.add(order)
        await session.flush()  # obtain generated values before transaction ends
        session.add(OrderLine(order_id=order.id, sku=payload.sku))
    return order
```

`flush()` sends pending statements inside the current transaction but does not commit it. After a commit, attribute expiration behavior depends on session configuration; `expire_on_commit=False` is common in async examples to avoid implicit database access on attribute access, but it does not make the object fresh forever. Return a response DTO assembled while required values are loaded.

Keep the transaction as short as possible. Never hold a database transaction open while calling a slow upstream HTTP service, sleeping, or streaming a response. Such work ties up connections and locks. For consistency across services, use an outbox or a workflow/saga pattern rather than pretending a database transaction can atomically commit a remote HTTP operation.

## Query design and serialization

Use SQLAlchemy's expression API and bind parameters rather than building SQL from user strings. Apply authorization predicates in the query or service layer so data from another tenant cannot slip through. Paginate with a stable ordering; a large `OFFSET` can become expensive, while cursor pagination needs a deterministic cursor key and tie-breaker.

Avoid N+1 queries caused by serializing lazy relationships. Load exactly the relationships the response needs, using eager-loading strategies appropriate to the query, and convert to a response model before the session closes. With async ORM usage, implicit lazy I/O during attribute access is especially problematic because it may attempt I/O where no `await` is visible. `selectinload` or an explicit query can make database work obvious.

## Errors and retries

Translate known integrity violations into a domain outcome only after rollback or transaction cleanup. A uniqueness violation may become 409 Conflict, but not every `IntegrityError` means a client conflict; inspect the constraint or handle the domain case deliberately. Deadlocks and serialization failures may be retryable at the transaction boundary, but retry the whole idempotent unit of work, not an arbitrary statement after partial side effects.

A connection pool is a finite queue. Configure pool capacity, overflow, recycle, and timeout based on database capacity and the number of service processes. `pool_pre_ping` can help detect stale connections, but is not a substitute for network timeouts or connection management. Database migrations should run as a controlled deployment step, not independently from every worker's application startup.

## Common mistakes

- Sharing one `Session` or `AsyncSession` among requests or concurrent tasks.
- Calling synchronous database methods directly from an async route.
- Assuming `flush()` commits, or committing after every individual row in a multi-step unit.
- Holding a transaction open across remote calls or slow streaming.
- Returning ORM entities with unloaded relationships and triggering surprise queries during serialization.
- Sizing a pool per process but forgetting to multiply by workers and replicas.

## Production notes

Observe pool checkout wait time, active/idle connections, transaction duration, slow queries, and database errors. Keep SQL logging and parameter redaction appropriate for sensitive data. Test rollback behavior by injecting failures between writes, and test concurrent access using independent sessions. Align application timeouts with database statement and transaction timeouts so abandoned HTTP requests do not leave expensive work running indefinitely. The session dependency owns closure; the unit-of-work layer owns commit semantics; the application lifespan owns the engine. That separation makes each resource's lifecycle testable.

## Isolation, idempotency, and migrations

A transaction provides a database-defined isolation level, not a blanket guarantee that concurrent business operations behave as intended. Two requests can both check availability and then attempt a conflicting insert. Enforce invariants with database constraints and handle the resulting conflict rather than relying only on a preflight query. For workflows that must be safely retried after a client timeout, use an idempotency key stored transactionally with the operation result. The client may not know whether a timed-out write committed; an idempotency record lets the service return the original result rather than duplicate the side effect.

Migrations change the schema and should be compatible with the application's rollout strategy. A rolling deployment may run old and new application versions at once, so expand-and-contract changes—add a nullable/new column, deploy compatible code, backfill, then remove the old field later—reduce coordination risk. Run migrations as a deliberate deployment task with a single owner, not automatically from every web worker. Back up and rehearse data transformations, and know how to roll back or repair a partially applied migration.

Database pool timeouts and statement timeouts address different waits. A pool timeout bounds waiting for a free application connection; a statement timeout bounds server-side query execution. Both should be aligned with request deadlines and cancellation semantics. When the caller disconnects, application code should avoid leaving unneeded queries running when the driver supports cancellation, but do not assume every cancellation path safely interrupts the database. Measure slow queries and use query plans before changing indexes or pool sizes.