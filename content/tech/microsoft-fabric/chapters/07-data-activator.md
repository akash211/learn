# Data Activator

Dashboards require someone to be looking. Activator exists for the moments when nobody is.
It is a Fabric item — formerly branded Data Activator, now usually just **Activator**, with the
item type still called a **reflex** in places — that watches a stream of data, evaluates rules
per entity, and fires an action when a condition holds. It is the difference between "the
dashboard shows the chiller trending up" and "someone was paged at 02:14".

## The object model

Activator is not a query engine; it is a small stateful model over events. Three concepts:

- **Object** — the thing you care about, identified by a key: a vehicle, a store, a machine, a
  customer. Each distinct key becomes an instance.
- **Property** — a value observed for that object, sourced from events (temperature, error rate,
  order value) or from a Power BI visual.
- **Rule** — a condition over properties with a time dimension, plus an action.

That model is why Activator rules read like operational statements: *for each vehicle, when
average speed over 5 minutes exceeds 90, send a Teams message to the fleet channel.*

## Where the data comes from

| Source | What it gives you | Notes |
|---|---|---|
| Eventstream | Raw or lightly processed events, at low latency | The normal path for streaming |
| Power BI report visual | The values currently visible in a visual | Useful for business metrics already modelled; evaluation follows refresh cadence, not event time |
| KQL queryset | Aggregated results from an Eventhouse | Good when the condition needs a window or a join |
| Real-Time hub events | Fabric system events, including capacity thresholds | How you alert on the platform itself |

The Power BI source is more useful than it looks: it lets a BI developer add alerting to a
metric they already own, without a data engineering project. The limitation is freshness — if
the semantic model refreshes hourly, your alert is hourly.

## Rule semantics that matter

A rule has a condition and a time behaviour. The usual shapes:

- **On each event** — evaluate every event, fire when the expression is true. Highest noise.
- **Becomes true** — fire on the transition from false to true, which is what most operational
  alerts actually want.
- **Exits range / enters range** — threshold crossing in either direction, with hysteresis if
  you configure separate enter and exit bounds.
- **Stays true for N minutes** — sustained breach. This is the single most valuable setting in
  production, because it eliminates the transient spike that pages someone at 3am for nothing.
- **Is empty for N minutes** — absence of data. Underused, and the failure mode that most
  monitoring misses: a sensor that stopped sending looks identical to a healthy sensor if you
  only alert on values.

Actions are deliberately boring: email, Teams message, Power Automate flow (which unlocks
ServiceNow, PagerDuty, SMS, ticketing), and Fabric item actions such as starting a pipeline.
If the response should be a runbook, put the runbook link in the message — an alert without an
owner and an action is just noise with a timestamp.

## Designing for humans

Alert fatigue is the real failure mode, and it is a design problem, not a tooling problem.

1. **Alert on the decision, not the metric.** "Disk above 80%" is a metric. "Disk will fill
   within 24 hours at current write rate" is a decision.
2. **One rule, one owner, one action.** If three teams need to know, the action fans out; the
   rule does not get duplicated three times with slightly different thresholds.
3. **Use sustained conditions and cooling-off.** A rule that fires 40 times during a 10-minute
   incident trains people to ignore it.
4. **Include context in the payload.** Object key, current value, threshold, window, and a link
   to the dashboard filtered to that object.
5. **Test with historical replay** before enabling. A rule that has never been evaluated against
   last month's data is a hypothesis.

## Where Activator fits and where it does not

It is a good fit for operational thresholds on streaming or near-real-time data: IoT telemetry,
fraud signals, inventory stockouts, SLA breaches, pipeline failure notifications, capacity
thresholds.

It is a poor fit for:

- **Complex multi-step correlation** across many streams — that belongs in KQL or Spark, with
  Activator firing on the result.
- **High-cardinality per-row alerting** — millions of objects each with its own rule evaluation
  is expensive and produces unactionable noise.
- **Guaranteed delivery of business transactions** — it is a notification and trigger layer,
  not a messaging system with delivery guarantees you can audit like a queue.

## Common mistakes

- Alerting on raw events rather than a windowed aggregate, so a single bad reading pages someone.
- No object key, or a key that changes between events (session ID, timestamp), which creates a
  new instance per event and makes state meaningless.
- Rules that fire continuously while a condition remains true, with no "becomes true" transition
  or cooling-off.
- Sending to a shared mailbox nobody owns, then discovering during the postmortem that the alert
  fired 300 times.
- Assuming preview-status actions and source integrations are permanent; the feature surface is
  still moving, so check which actions are generally available in your region before designing
  a process around one.

## Production notes

Treat rules as code: name them `domain.object.condition`, document the threshold rationale, and
review them quarterly — thresholds set for last year's traffic are usually wrong this year.
Route alerts into the same incident system as the rest of your estate so they have an on-call
owner, and alert on the absence of data as well as on bad data. The measure of a good Activator
deployment is not how many rules exist; it is how many pages resulted in an action.
