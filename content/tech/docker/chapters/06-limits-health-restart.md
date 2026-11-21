# Resource Limits, Healthchecks and Restart Policies

These three settings are what turn a container from something that runs into something that
survives a bad night. They are also routinely misconfigured, because the defaults are all
permissive and the failure modes are quiet: a container that is being throttled looks healthy, a
container with a failing healthcheck keeps running, and a container killed for memory comes back
as an unexplained exit code.

## Limits

```bash
docker run -d \
  --memory 1g --memory-swap 1g --memory-reservation 768m \
  --cpus 1.5 --cpuset-cpus 0-3 \
  --pids-limit 200 \
  --ulimit nofile=4096:4096 \
  app:1.4
```

| Flag | Effect | Failure when exceeded |
|---|---|---|
| `--memory` | Hard cgroup memory cap | OOM killer, exit 137 |
| `--memory-reservation` | Soft limit used under host pressure | Reclaim pressure, slower |
| `--memory-swap` | Memory + swap total | Swap thrash before OOM |
| `--cpus` | CFS quota (`cpu.max`) | Throttled in 100 ms periods |
| `--cpu-shares` | Relative weight under contention | Lower share, no hard limit |
| `--cpuset-cpus` | Physical core affinity | Processes confined to those cores |
| `--pids-limit` | Max tasks (threads count) | `fork` fails with EAGAIN |
| `--ulimit nofile` | Open file descriptors | `Too many open files` |

Three details matter more than the rest.

**`--memory` is not the only memory setting.** Leaving `--memory-swap` unset gives the container
swap equal to its memory limit on hosts that have swap configured, so a container that exceeds
its limit can spend minutes thrashing instead of failing fast. Setting `--memory-swap` equal to
`--memory` disables swap for that container. For latency-sensitive services, failing fast is
usually the better outcome.

**Page cache counts toward the limit.** A container reading large files fills the page cache
inside its cgroup; the kernel reclaims that cache under pressure, so a container can sit at 95%
of `memory.max` indefinitely without being killed. What kills it is an allocation the kernel
cannot satisfy by eviction — usually the application heap growing. That is why the fix for repeat
OOM kills is almost never "raise the limit" but "size the heap below the limit".

**A CPU quota is a ceiling, not a reservation.** With `--cpus 1` on a 16-core host, the container
is still capped at one core's worth of time per period, and `cat /sys/fs/cgroup/.../cpu.stat`
shows `nr_throttled` climbing when it hits the boundary. Average utilisation looks fine because
throttling is invisible in an averaged CPU graph; latency histograms show it clearly. Runtimes
that size pools from `nproc` ignore the quota entirely and make this worse.

Compose expresses the same settings two ways. Service-level `cpus` and `mem_limit` work in
Compose v2, and `deploy.resources.limits` is also applied on `docker compose up` even without
Swarm:

```yaml
services:
  api:
    cpus: 1.5
    mem_limit: 1g
    pids_limit: 200
    deploy:
      resources:
        limits: { cpus: "1.5", memory: 1g }
        reservations: { memory: 768m }
```

The `deploy` block is the portable form because it is what Kubernetes users recognise, and
Compose v2 honours it locally.

## Healthchecks

A healthcheck is a command Docker runs inside the container on a timer. Exit 0 means healthy,
exit 1 means unhealthy, exit 2 is reserved and treated as unhealthy.

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
```

- `interval` defaults to 30s, `timeout` to 30s, `retries` to 3, `start-period` to 0.
- Failures during `start-period` do not count toward `retries`, which is what prevents a slow
  boot from being declared unhealthy.
- `--format '{{json .State.Health}}'` shows status, the last five probe results and their output.

The single most important fact: **a failing healthcheck does not restart the container.** Docker
records the status; nothing acts on it. Swarm and Kubernetes act on it, and Compose can gate
`depends_on: condition: service_healthy` on it, but plain `docker run` with
`--restart always` will happily keep an unhealthy container running forever. If you want
replacement on failure, you need an orchestrator (or an external watchdog).

A useful healthcheck tests the thing that can break, not just that the process exists. `pgrep
app` returns 0 for a process deadlocked on a database connection. A `/health` endpoint that
checks its dependencies — with a short timeout — catches far more. The cost is that a dependency
outage marks every replica unhealthy at once, which in Kubernetes triggers a restart storm; the
usual compromise is `/health` (liveness: am I running) separate from `/ready` (readiness: can I
serve).

For images without a shell or `curl` — distroless, scratch — the probe must be a binary that
exists. That is either the application's own subcommand (`app healthcheck`) or a tiny statically
linked probe you copy in. Chapter 3's advice to keep the runtime minimal collides with
observability here, and the application-level probe is the resolution.

## Restart policies

| Policy | Restarts on non-zero exit | Restarts after daemon restart | Restarts after `docker stop` |
|---|---|---|---|
| `no` (default) | No | No | No |
| `on-failure[:N]` | Yes, up to N times | No | No |
| `always` | Yes | Yes | Yes |
| `unless-stopped` | Yes | Yes, if it was running | No |

`unless-stopped` is the sane default for a long-running service: it survives a host reboot,
respects a deliberate stop, and does not fight an operator who is debugging. `always` is for
things that must exist no matter what, and it will resurrect a container you stopped on purpose
when the daemon restarts — which is confusing during an incident.

Retries back off: the delay doubles from about 100 ms on each consecutive failure, so a
crash-looping container does not saturate the CPU. That also means a container that fails on
startup appears in `docker ps` briefly and vanishes; `docker ps -a` plus `docker inspect
--format '{{.State.ExitCode}} {{.State.Error}}'` is how you see what happened.

Note the interaction with `--rm`: restart policies and automatic removal are mutually exclusive.
A container that should restart must be left in place to restart.

## Stop, signals and exit codes

`docker stop` sends `SIGTERM` to PID 1, waits ten seconds by default, then sends `SIGKILL`.

```bash
docker stop --time 30 api            # longer grace period
docker run --stop-signal SIGQUIT app # different signal
```

If the application handles `SIGTERM`, it can drain connections and finish work. If it does not —
or if it runs behind a shell that never forwards the signal — the ten seconds elapse and the
process is killed mid-write. `STOPSIGNAL SIGTERM` in the Dockerfile documents the expectation;
`exec "$@"` in an entrypoint script is what makes the signal actually arrive.

| Exit code | Meaning |
|---|---|
| 0 | Clean exit |
| 1 | Application error |
| 125 | `docker run` itself failed (bad flag, image not found) |
| 126 | Command found but not executable |
| 127 | Command not found |
| 137 | `SIGKILL` — usually the OOM killer |
| 143 | `SIGTERM` — usually a normal `docker stop` |

137 deserves a check rather than an assumption: `docker inspect --format '{{.State.OOMKilled}}'`
confirms whether the kernel killed it for memory or something else sent `SIGKILL`.

## Common mistakes

- Setting `--memory` and leaving the JVM or Node heap at its default, so the runtime allocates
  more than the cgroup allows and dies under load instead of at start.
- Assuming a healthcheck provides restart-on-failure in plain Docker.
- `restart: always` used to paper over a crash loop instead of reading the logs.
- No `--pids-limit`, so a thread leak or fork loop takes down the host.
- A healthcheck with a 1-second interval and no `start-period`, marking every deploy unhealthy.
- `docker stop` followed immediately by `docker rm -f` in a deploy script, defeating graceful shutdown.

## Production notes

Set memory and CPU limits on every container and alert on both `OOMKilled` and sustained CPU
throttling — those two metrics catch most misconfiguration before users do. Give every service a
`STOPSIGNAL`-aware shutdown path and a grace period longer than its slowest request. Keep
healthchecks cheap (a local HTTP call with a timeout, not a query that scans a table) and
separate liveness from readiness once you move to Kubernetes, where conflating them causes
restart storms during dependency outages.
