# Consistency, Idempotency and Failure Semantics

Distributed systems fail in ways that are hard to see: a request that timed out may have
succeeded, a replica may be serving data from four seconds ago, and a retry may be the second
charge on a customer's card. This chapter is about making those outcomes explicit and choosing
which ones the product can tolerate.

## Consistency, in product language

"Strong consistency" is not a single property. The useful models, translated into what a user
observes:

| Model | Guarantee | Product phrasing |
|---|---|---|
| Linearizable | Every read sees the latest completed write; operations appear in real-time order | "After I save, everyone sees it immediately" |
| Serializable | Transactions behave as if run one at a time | "Two simultaneous bookings cannot both succeed" |
| Snapshot isolation | A transaction sees a consistent point-in-time snapshot | "My report is internally consistent" |
| Read-your-writes | A client sees its own writes | "My edit is visible to me" |
| Monotonic reads | A client never goes backwards in time | "The page does not flicker to older data" |
| Bounded staleness | Reads are at most T old | "The dashboard is within 60 seconds" |
| Eventual | Replicas converge, eventually | "The like count catches up" |

Most consumer products need read-your-writes plus bounded staleness, not linearizability. Stating
that in the requirements is what allows asynchronous replication, caches and read models — the
techniques that make the system affordable.

CAP is often cited and usually misapplied. It describes behaviour **during a network partition**:
you can keep serving and risk stale data, or refuse requests and stay consistent. It says nothing
about the normal case. PACELC extends it usefully: even without partitions, there is a trade
between latency and consistency, and every replicated write makes that trade.

## Idempotency at the API boundary

A client sending a request cannot distinguish "the server never received it" from "the server
processed it and the response was lost". The only safe client behaviour is to retry, which means
the server must make retries harmless.

The mechanism is an idempotency key supplied by the client, stored with the response:

```python
def handle_create_order(req, conn) -> Response:
    key = req.headers["Idempotency-Key"]          # client-generated UUID
    with conn.transaction():
        row = conn.execute(
            "SELECT request_hash, status, response FROM idempotency_keys WHERE key = %s FOR UPDATE",
            (key,),
        ).fetchone()
        if row:
            if row.request_hash != hash_request(req):
                return Response(409, {"error": "key reused with a different payload"})
            if row.status == "completed":
                return Response(200, row.response)   # replay the original response
            return Response(409, {"error": "request in progress"})
        conn.execute(
            "INSERT INTO idempotency_keys (key, request_hash, status) VALUES (%s, %s, 'in_progress')",
            (key, hash_request(req)),
        )
    result = create_order(req)
    conn.execute(
        "UPDATE idempotency_keys SET status='completed', response=%s WHERE key=%s",
        (json.dumps(result), key),
    )
    return Response(200, result)
```

Three details matter. The key row is inserted **before** the work, so a concurrent duplicate
sees `in_progress` rather than starting a second charge. The request hash catches the client bug
of reusing a key for different content. And the stored response means a retry returns the
original result, not a new one.

Cost is modest: 400 writes/s × 86,400 s = **34.6 million keys/day**; at ~120 bytes each that is
**4.2 GB/day**, so keep a 24-hour window and purge on a schedule. The window must exceed the
client's retry horizon — if clients retry for 48 hours and keys live 24, the last day of retries
duplicates.

## Timeouts are not failures

A timeout means **unknown**, not failed. The three outcomes of any RPC are success, failure, and
"I do not know", and the third is the one that causes double charges:

```
client --request--> server
       <-timeout--        (server may still be executing)
client retries ----------> server   # second execution unless idempotent
```

Design rules that follow:

- **Every write endpoint takes an idempotency key**, not just payments.
- **Never retry a non-idempotent call blindly.** Retry only operations that are idempotent or
  keyed.
- **Set timeouts below the caller's timeout**, so the inner call fails before the outer one gives
  up. A service calling a database with a 30-second statement timeout behind a 10-second HTTP
  timeout leaks work.
- **Propagate deadlines**, not just timeouts, so downstream work is abandoned when the caller has
  already given up.

## Sagas instead of distributed transactions

A single database gives atomicity for free. A workflow spanning order, payment and inventory
services does not. Two-phase commit works only when all participants support it and are willing
to block; most modern services do not.

The alternative is a saga: a sequence of local transactions, each with a compensating action.

```
reserve inventory -> charge payment -> confirm order
     compensate: release inventory <- refund payment <- cancel order
```

At 40 orders/s, 0.5% failing mid-saga is 17,280 compensations per day — a background workflow that
must be tested as carefully as the happy path. Compensations are not rollbacks: a refund is a new
transaction with its own ledger entry, and it can fail too, so the saga needs a durable state
machine and a reconciliation job.

## Failure semantics by component

| Failure | Naive behaviour | Designed behaviour |
|---|---|---|
| Database primary down | Writes fail, reads fail | Failover in 30 s; reads served from replicas; writes return retryable 503 |
| Replica lag > 5 s | Users see their own stale edits | Pin session to primary; alert on lag; gate read routing |
| Cache down | Origin melts under full load | Circuit breaker; serve stale; rate-limit reads |
| Queue backlog | Silent latency growth | Alarm on age of oldest message; shed or scale |
| Third-party API slow | Threads pile up, service dies | Timeout, bulkhead, circuit breaker, fallback |
| Duplicate delivery | Double effect | Idempotent handler; dedupe window |

The pattern across the table is **containment**: bound the resources a failing dependency can
consume. A bulkhead gives each dependency its own connection pool, so a slow payment provider
cannot exhaust connections needed by search.

## Degradation, chosen in advance

Decide what the product does when a dependency is unavailable, and encode it:

- Search down → return cached popular results and a banner, not a 500.
- Recommendations down → fall back to bestsellers.
- LLM provider down → template-based response or a queued retry, depending on the feature.
- Write path saturated → accept and queue, with a visible "processing" state.

A degraded mode that has never been exercised is a hypothesis. Test it with fault injection:
kill Redis in staging and see what the read path does.

## SLOs, error budgets and reconciliation

An SLO turns reliability into arithmetic. 99.9% availability over 30 days allows
`0.001 × 30 × 24 × 60 = 43.2 minutes` of downtime. 99.95% allows 21.6 minutes. The error budget
is what lets a team decide whether to ship a risky change this week.

No matter how careful the design, replicas diverge and messages duplicate. The last line of
defence is **reconciliation**: a scheduled job that compares source and derived state and repairs
differences.

```python
def reconcile_daily(day: str, tolerance: float = 1e-4) -> None:
    expected = query_source_totals(day)         # from the system of record
    actual = query_warehouse_totals(day)        # from derived tables
    for key, source_total in expected.items():
        delta = abs(source_total - actual.get(key, 0))
        if source_total and delta / source_total > tolerance:
            alert(f"reconcile mismatch {day} {key}: {delta:.2f}")
            requeue_partition(day, key)
```

Reconciliation is how you find out that 0.02% of events were dropped three weeks ago, instead of
hearing it from finance.

## Common mistakes

- **Claiming strong consistency while reading from async replicas.** The design contradicts itself.
- **Idempotency keys stored after the effect.** The crash window remains.
- **Retrying on timeout without a key.** The most expensive bug in payments.
- **Using wall-clock timestamps to order events.** Clock skew makes "last write wins" lose writes.
  Use version numbers or a database sequence.
- **Two-phase commit across services that cannot block.** It will deadlock under partition.
- **No reconciliation.** You cannot detect drift you never compare.

## Production notes

Log the idempotency key on every write and include it in traces; without it, debugging a duplicate
is archaeology. Track the age of the oldest in-progress saga and alert when it exceeds the
expected completion time. And write down, per endpoint, whether it is safe to retry — that single
line in the API docs prevents most duplicate-charge incidents.
