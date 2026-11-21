# Processes, Signals, Scheduling and cgroups

Everything a server does is a process scheduled by the kernel. Most "the service hung" incidents are
actually one of four things: a process stuck in uninterruptible I/O, a signal that never arrived
because the service ignored it, a CPU quota that throttled the work, or a file-descriptor limit
quietly hit at 1024. This chapter gives you the model to tell those apart in one pass.

## Process states and what they mean

`ps -eo pid,ppid,stat,pcpu,pmem,wchan:24,cmd` is the useful form. The `STAT` column is where the
diagnosis starts:

| State | Meaning | Operational reading |
|---|---|---|
| `R` | Running or runnable | On CPU or waiting for a timeslice |
| `S` | Interruptible sleep | Waiting on a timer, socket, or lock — normal |
| `D` | Uninterruptible sleep | Blocked in the kernel, usually storage or NFS; cannot be killed |
| `Z` | Zombie | Exited, parent has not reaped it |
| `T` | Stopped | `SIGSTOP` or a debugger |
| `I` | Idle kernel thread | Normal |

A process in `D` is the important case. `SIGKILL` does not take effect until the kernel call returns,
so `kill -9` appears to do nothing and the process shows up in load average. If `wchan` reads
`rpc_wait_bit_killable` or `xfs_log_force`, you are waiting on NFS or a dying disk array, and the fix
is the storage, not the process.

## fork, exec and who reaps whom

A process is created by `fork()` (a copy of the parent, copy-on-write) and becomes a new program via
`execve()`. The parent gets the child's PID and is responsible for `wait()`ing on it. If the child
exits first, it becomes a zombie — an entry in the process table with no memory — until the parent
reaps it. If the parent dies first, the child is reparented to PID 1 (or the nearest
`PR_SET_CHILD_SUBREAPER` process), and systemd reaps it.

This is why "zombie process" is not usually a problem in itself; a *growing* zombie count means a
long-running parent is not calling `wait()`. Find the parent with
`ps -eo stat,ppid,pid,cmd | awk '$1 ~ /Z/ {print $2}' | sort | uniq -c` and restart the parent, not
the zombies. PID 1 that does not reap — a shell script, or a badly written container entrypoint — is
the other classic source.

## Signals

Signals are asynchronous notifications with a default action the program can override, except for
two.

| Signal | Num | Default | Typical use |
|---|---|---|---|
| `SIGHUP` | 1 | Terminate | Reload configuration (daemons that support it) |
| `SIGINT` | 2 | Terminate | Ctrl-C |
| `SIGQUIT` | 3 | Core dump | Thread dump (`kill -QUIT` on a JVM) |
| `SIGKILL` | 9 | Terminate | Cannot be caught, blocked, or ignored |
| `SIGTERM` | 15 | Terminate | The polite shutdown request — always try this first |
| `SIGSTOP` | 19 | Stop | Cannot be caught; `SIGCONT` resumes |
| `SIGUSR1/2` | 10/12 | Terminate | Application-defined (log rotation, stats dump) |
| `SIGPIPE` | 13 | Terminate | Writing to a closed socket |

`kill -l` lists them; `kill -TERM <pid>` and `kill -TERM -- -<pgid>` (negative PID targets the
process group) behave differently, and that distinction matters for scripts that spawn children.
`SIGTERM` is a *request*: a process with a handler can ignore it forever, which is why systemd
escalates to `SIGKILL` after `TimeoutStopSec` (90 s by default) and why `KillMode=` decides who gets
the signal.

When you must reload rather than restart — TLS certificates, upstream lists — check that the daemon
actually re-reads on `SIGHUP` (`nginx -s reload`, `systemctl reload nginx`); many modern services
only reload via their own control socket, and some (PostgreSQL) treat `SIGHUP` as reload but
`SIGINT` as "smart shutdown".

## Priorities and scheduling

Linux's default scheduler is CFS (EEVDF since 6.6). You influence it in three ways:

- **nice**, from -20 (most favourable) to 19. `nice -n 10 ./batch` starts low-priority;
  `renice -n 5 -p 4242` changes a running process. Only root can lower a nice value.
- **Scheduling policy**, via `chrt`: `SCHED_OTHER` (default), `SCHED_BATCH` (throughput, no
  preemption), `SCHED_IDLE` (only when nothing else runs), and the real-time policies
  `SCHED_FIFO`/`SCHED_RR`, which can starve the entire machine if misused.
- **CPU affinity**, via `taskset -c 0-3`, which pins a process to specific cores — useful for
  isolating a latency-sensitive service or keeping a NUMA-sensitive workload local.

## Limits are per-process, and easy to get wrong

`ulimit -n` is the per-process file-descriptor limit. Four separate places can set it, and they
apply at different times:

| Mechanism | Applies to | Persistence |
|---|---|---|
| `ulimit` in a shell | That shell and its children | Session only |
| `/etc/security/limits.conf` + `limits.d/` | Sessions through PAM (`pam_limits`) | Reboot, not to systemd services |
| systemd `LimitNOFILE=` | The service's cgroup | Unit file |
| `fs.file-max` sysctl | Whole system, kernel-side ceiling | `/etc/sysctl.d/` |

The classic surprise: you raise `nofile` in `limits.conf`, restart the service, and it still has
1024, because systemd-started services never pass through PAM's limits stack. Set `LimitNOFILE=` on
the unit (or in a drop-in) instead, then verify from inside the process:
`grep 'open files' /proc/$(pgrep -o nginx)/limits`.

Other limits worth knowing: `nproc` (per-UID process count — a fork-bomb defence), `core` (0 on
production, so a crashing process does not fill `/`), `memlock` (required for `mlockall`, common for
Redis and DPDK), and `max locked memory` for eBPF-heavy workloads.

## cgroups v2: accounting, not isolation

cgroups group processes and account or cap their resource use. Since systemd 257, cgroup v1 is
disabled entirely, so every modern server is on the unified v2 hierarchy at `/sys/fs/cgroup`, mounted
as a single tree. Interfaces are files:

```bash
cat /sys/fs/cgroup/system.slice/nginx.service/memory.max     # may be "max"
cat /sys/fs/cgroup/system.slice/nginx.service/memory.current
cat /sys/fs/cgroup/system.slice/nginx.service/cpu.stat        # usage_usec, nr_throttled
cat /sys/fs/cgroup/system.slice/nginx.service/pids.current
```

| Controller file | Meaning |
|---|---|
| `memory.max` / `memory.high` | Hard OOM limit / soft throttle-and-reclaim limit |
| `memory.current` | Current charge, including page cache |
| `cpu.max` | `"<quota> <period>"` in microseconds, e.g. `"200000 100000"` = 2 CPUs |
| `cpu.weight` | Relative share when the CPU is contended (1–10000, default 100) |
| `io.max` | Per-device `rbps`/`wbps`/`riops`/`wiops` |
| `pids.max` | Fork-bomb ceiling |

Two properties matter operationally. `cpu.max` is a *quota per period* (100 ms by default): a service
limited to 1.5 CPUs that needs 1.6 within one period gets throttled to zero for the remainder, which
shows up as p99 latency with modest average utilisation — check `nr_throttled` in `cpu.stat` before
blaming the application. And `memory.current` includes page cache, so a number near `memory.max` is
not necessarily a leak; `memory.stat` splits `anon`, `file`, and `slab`.

systemd exposes the hierarchy as slices. `system.slice` holds services, `user.slice` holds logins and
user managers, and a unit's `Slice=`/`MemoryMax=`/`CPUQuota=` translate directly into cgroup files:

```bash
systemd-run --unit=batch --slice=batch.slice --property=CPUQuota=200% \
  --property=MemoryMax=4G --property=IOWeight=50 /opt/batch/run.sh
systemd-cgtop -m            # live per-cgroup memory/CPU/IO
```

`systemd-cgls` shows the tree and `cat /proc/<pid>/cgroup` tells you which group a stray process
belongs to — the fast way to find out whether a runaway is inside the service's cgroup (and therefore
subject to its limits) or escaped into `init.scope`.

## Common mistakes

- Reaching for `kill -9` first. It denies the process any chance to flush buffers, close sockets, or
  release locks, and it does not work on `D` state at all.
- Expecting `nohup ./job &` to be a service. It dies with the session on some systems, has no restart
  policy, no limits, and no log rotation — use a systemd unit or a timer.
- Confusing `%CPU` in `top` (a share of one core, so 250% is 2.5 cores) with a percentage of the
  whole machine.
- Tuning `vm.swappiness` to 0 to "disable swap"; it makes the kernel more likely to invoke the OOM
  killer instead of reclaiming anonymous pages.

## Production notes

Set `LimitNOFILE` and `LimitCORE` explicitly on every unit and `TasksMax=` on anything that forks.
Give batch workloads their own slice with `CPUQuota` and `MemoryMax` so a runaway job degrades itself
instead of the API. Prefer `Restart=on-failure` with `RestartSec` and `StartLimitBurst` so a crash loop
backs off instead of hammering. When a service hangs, capture `ps -eo pid,stat,wchan:24,cmd` and
`/proc/<pid>/status` before restarting — after the restart the evidence is gone.
