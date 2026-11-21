# Rolling, Blue/Green and Canary Deployments

A deployment strategy is an answer to two questions: how much of the fleet runs the new version at
once, and how quickly can you get back. Everything else — the YAML, the controllers, the dashboards
— is machinery for adjusting those two numbers.

## Rolling update

The default in Kubernetes and most orchestrators: replace instances in batches, waiting for each
new instance to become ready before removing an old one.

```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  minReadySeconds: 10
  progressDeadlineSeconds: 300
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: api
          readinessProbe:
            httpGet: { path: /ready, port: 8080 }
            periodSeconds: 5
            failureThreshold: 2
```

`maxUnavailable: 0` with `maxSurge: 1` gives a zero-capacity-loss rollout at the cost of one extra
pod. `minReadySeconds` prevents a pod that becomes ready and then crashes from counting as
success. `progressDeadlineSeconds` turns a stuck rollout into a failed one instead of a Deployment
that sits at 60% forever.

The subtlety is that a rolling update runs **two versions simultaneously** for its duration. That
is the constraint that shapes everything else: the API must be backward compatible, the database
schema must serve both versions (chapter 8), and any cached or queued payload must be readable by
both. If the rollout takes ten minutes and a request can live for thirty seconds, the overlap is
thirty seconds of mixed-version behaviour — by design, and only safe if compatibility is real.

Readiness probes are the load-bearing part. A probe that returns 200 as soon as the process starts
routes traffic to a service that has not connected to its database; a probe that checks downstream
dependencies makes the whole fleet unready when one dependency blips. The useful shape is a
`/ready` endpoint that checks only what this instance needs to serve traffic — config loaded,
migrations verified, connection pool established — and a separate `/health` for liveness that
checks almost nothing.

**Draining** is the other half. On `SIGTERM`, a pod should stop accepting new requests, finish
in-flight ones, and exit before the grace period ends. In practice that means a `preStop` sleep
long enough for the load balancer to notice, plus a server that honours graceful shutdown:

```yaml
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 5"]
```

Without it, every deploy produces a burst of 502s from requests routed to a pod that has already
closed its listener.

## Blue/green

Two complete stacks — blue serving, green idle — and a cutover at the router. Deploy to green,
verify it, flip the load balancer to green, keep blue warm for rollback.

The advantages are real: the cutover is atomic from the client's perspective, verification happens
against a full-size stack with production traffic shapes, and rollback is a second flip that takes
seconds. The costs are equally real: double the infrastructure during the operation, a database
shared by both stacks (so schema compatibility is still required), and a cutover that is atomic for
the *router* but not for the *world* — in-flight requests, websockets, sticky sessions, cached DNS
and background workers all need handling.

Blue/green fits stateful or high-risk releases where "verify the whole thing before any user sees
it" is worth the doubled cost: a major version upgrade, a payment path change, a service with
expensive warm-up. It fits badly with autoscaling and with anything holding long-lived connections,
where the flip is neither instant nor reversible.

Verification before the flip is the part teams skip. Standing up green and immediately switching
traffic is a rolling deploy with extra steps and double the bill. The point is to run your smoke
tests, a load test, or a shadow copy of production traffic against green while blue still serves.

## Canary

Send a small slice of traffic to the new version, compare its behaviour against the baseline, and
increase or abort. The value is that the blast radius is bounded by the traffic share, and the
decision is made on evidence rather than opinion.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
spec:
  strategy:
    canary:
      canaryService: api-canary
      stableService: api-stable
      trafficRouting:
        nginx:
          stableIngress: api
      steps:
        - setWeight: 5
        - pause: { duration: 5m }
        - analysis:
            templates: [{ templateName: error-rate }]
        - setWeight: 25
        - pause: { duration: 10m }
        - setWeight: 50
        - pause: { duration: 10m }
```

The hard part is not the traffic split; it is the **analysis**. A canary that is promoted because
nobody looked is a slow rolling deploy. Effective automatic analysis needs four things:

1. **A metric that moves for the failure you fear** — error rate and p95 latency for most services,
   plus a domain metric (checkout conversion, queue depth) where the failure is silent.
2. **A comparison against the baseline**, not an absolute threshold. The canary's error rate should
   be compared to the stable version's over the same window, because a service that always runs at
   2% errors should not block every deploy.
3. **Enough traffic for the sample to mean something.** At 1% of a low-traffic service, a five-minute
   window may see a handful of requests; the analysis will either never fire or fire on noise. Low
   traffic is the main reason canaries get abandoned.
4. **A defined abort behaviour** — roll back automatically, page someone, or pause and wait. The
   default should be rollback, with a human able to hold.

Canary also supports a preliminary phase that is easy to overlook: send only synthetic or
header-tagged traffic to the canary first, run the smoke suite against it, and only then open it to
real users. That catches "the image does not start" without exposing anyone.

## Choosing

| | Rolling | Blue/green | Canary |
|---|---|---|---|
| Extra infrastructure | One pod | A full second stack | One extra replica set |
| Blast radius on failure | Up to the whole fleet, gradually | Zero until cutover, then all | The traffic share |
| Rollback speed | One rollout cycle | Seconds (flip back) | Seconds (shift weight) |
| Needs traffic control | No | Yes (router) | Yes (weighted routing) |
| Needs schema compatibility | Yes | Yes | Yes |
| Verification before exposure | Readiness only | Full-stack smoke/load | Smoke plus live comparison |
| Complexity | Low | Medium | High (metrics, analysis) |

The honest default is rolling with good readiness and draining, because it needs no extra
machinery. Canary is worth the complexity when a bad release is expensive and traffic is
plentiful. Blue/green is worth the cost when you need to verify a whole stack before anyone sees
it, or when the release is a one-way door.

## Deployment versus release

A deploy makes code available; a release exposes it. Feature flags separate the two, and the
separation is what makes "deploy on Friday" safe: ship the code dark, enable it for internal users,
then for 1%, then everyone — each step reversible without a redeploy.

The failure mode is flag debt. A flag that outlives its rollout is a branch in production that
nobody tests, and a matrix of combinations that grows faster than the test suite. Give every flag
an owner and an expiry, and delete it when the rollout completes.

## Common mistakes

- Readiness probing downstream dependencies, so one blip takes the fleet out of rotation.
- No `preStop` delay, so every deploy produces a burst of 502s.
- `maxUnavailable: 25%` on a three-replica service, which takes a third of capacity away at the
  worst moment.
- Blue/green with a shared database and a schema change that only the new code understands.
- A canary that promotes on a timer with no analysis, which is a slow rolling update.
- Comparing canary absolute error rate against a fixed threshold, so a noisy service can never
  deploy.
- Long-lived websocket connections in a blue/green cutover with no drain plan.

## Production notes

Watch the rollout, not just the deploy command: `kubectl rollout status` blocks until completion,
and `kubectl rollout undo` reverts to the previous ReplicaSet template — which is only a rollback
if the previous template is still valid against the current schema. Record which digest was
previous *before* deploying. And run the strategy against a failure on purpose, occasionally: kill
the canary mid-rollout and confirm the abort path works, rather than discovering on the night of
an incident that the analysis template referenced a metric that was renamed a year ago.
