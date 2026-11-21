# Fabric Overview and the Capacity Model

Microsoft Fabric is a software-as-a-service analytics platform, and the fastest way to
misunderstand it is to treat it as a bundle of separately provisioned services. It is one
tenant-wide lake, one compute pool, and several engines that all read the same files. Get the
capacity model right and most of the operational questions — why a refresh was delayed, why a
notebook is slow at 10am, why the bill moved — answer themselves.

## One product, several engines

Everything you build is an **item** inside a **workspace**. The workspace is the unit of
permission, Git integration, deployment and capacity assignment; the item is the thing that
actually does work.

| Workload | Typical items | Engine underneath |
|---|---|---|
| Data Engineering | lakehouse, notebook, Spark job definition, environment | Apache Spark |
| Data Factory | pipeline, Copy job, Dataflow Gen2 | Orchestration + Power Query mashup |
| Data Warehouse | warehouse, SQL analytics endpoint | T-SQL MPP engine |
| Real-Time Intelligence | eventstream, eventhouse, KQL database, queryset | Kusto |
| Data Science | notebook, experiment, model | Spark + MLflow |
| Power BI | semantic model, report, dashboard | VertiPaq (Analysis Services) |
| Activator | reflex | Rule evaluation over streams |

The unifying decision is storage: lakehouse tables, warehouse tables, mirrored databases and
(eventually) KQL data all land as Delta tables in OneLake. That is why a Spark job can write
data that a T-SQL view and a Direct Lake semantic model then read without a copy step.

## Capacity is the billing and throttling boundary

A **capacity** is a pool of compute measured in **Capacity Units (CU)**. Fabric F SKUs double
as you go up, from small development sizes to sizes that will carry a large enterprise:

| SKU | CUs | Roughly equivalent Power BI SKU |
|---|---|---|
| F2 | 2 | — |
| F8 | 8 | EM/A1 |
| F16 | 16 | EM2/A2 |
| F64 | 64 | P1/A4 |
| F256 | 256 | P3/A6 |
| F1024 | 1024 | P5/A8 |
| F2048 | 2048 | — |

Two thresholds matter in practice. **F64** is where users with only a Fabric (Free) licence
can view Power BI content in that capacity; below it, viewers need Pro or PPU. And the older
**P SKUs** are being consolidated into F SKUs — new designs should assume F.

Capacity buys compute, not storage: OneLake storage is metered separately, so a design that
keeps five copies of the same history is expensive twice. It also buys nothing per workspace.
Every workspace assigned to the capacity shares one CU pool, which means a Spark notebook
compacting a silver table and an executive dashboard compete for the same budget. There is no
per-workspace quota unless you create separate capacities.

## Bursting and smoothing

Fabric deliberately lets an operation run faster than the SKU's steady-state compute allows.
That is **bursting**. To avoid punishing you for the burst, it then **smooths** the consumed
CU-seconds across future 30-second timepoints (2,880 of them in a day):

- **Interactive** operations (queries, report renders) are smoothed over a minimum of five
  minutes, extending up to 64 minutes as consumption grows.
- **Background** operations (refreshes, Spark jobs, pipeline runs) are smoothed over 24 hours.

The consequence is counter-intuitive. A one-CU-hour background job on an F2 contributes only
about 2.1% of each timepoint, because 1 CU-hour spread over an F2's 48 CU-hours per day is a
rounding error. You do **not** have to spread scheduled jobs across the night to avoid
throttling. What actually hurts is sustained consumption: many jobs, all day, each large
relative to the SKU.

## Throttling happens in stages

Overload does not cut you off immediately. Fabric allows a short period of overage, then
escalates:

| Consumption relative to capacity | What happens |
|---|---|
| Up to 10 minutes of future capacity | Overage protection — no throttling |
| 10 to 60 minutes | New interactive requests delayed by 20 seconds |
| 60 minutes to 24 hours | New interactive requests rejected; background work still starts |
| Beyond 24 hours | All new requests rejected, interactive and background |

Rejected calls return `CapacityLimitExceeded`: *"Your organization's Fabric compute capacity
has exceeded its limits."* Unpaid usage becomes **carryforward** CU, applied to later
timepoints; idle capacity **burns it down**. A capacity can therefore stay throttled well after
the spike that caused it, which is why "it recovered by itself" is not a plan.

## Operating a capacity without guessing

The Capacity Metrics app is the primary instrument: it attributes CU consumption to items and
operations, shows throttling and carryforward, and separates interactive from background.
Capacity overview events can drive email or Activator alerts on threshold breaches.

Practical rules:

- **Separate noisy workloads.** Put ad-hoc data science and production serving on different
  capacities when one can starve the other. This is a cost decision as much as a technical one.
- **Do not run development on the production capacity.** Notebook experimentation is bursty
  and selfish; pause a dev capacity outside working hours.
- **Scale deliberately.** F SKUs can be resized, but crossing the F256/F512 boundary can change
  the underlying infrastructure and produce a slower experience immediately after scaling.
- **Watch sustained utilisation, not peaks.** A capacity that sits above roughly 80% of its
  smoothed budget for hours has no headroom for the month-end spike.

## Common mistakes

- Treating capacity as a per-workspace quota and being surprised when a neighbour's job throttles you.
- Sizing on the five-minute peak, then paying for idle capacity all month.
- Assuming Power BI refreshes are "free" because they are "just reports" — they consume the same CUs.
- Scheduling every pipeline at midnight to "avoid throttling" and gaining almost nothing, because
  background work is already smoothed over 24 hours.
- Buying PPU licences and expecting lakehouses to work; non-Power BI items need an F capacity.

## Production notes

Model the workload mix, not just data volume: Spark is CPU-hungry and bursty, the warehouse is
concurrency-sensitive, and Direct Lake moves cost from refresh to query. Keep a small
non-production capacity for development and a separate one for serving. Instrument before you
resize — the metrics app will usually show that two or three items own most of the consumption,
and fixing them is cheaper than doubling the SKU.
