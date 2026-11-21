# Containers, Virtual Machines, Namespaces and cgroups

A container is a process. `docker run` asks the daemon to create one; containerd calls a runtime
(`runc`, or `crun` under some distributions), which does three things: `clone()` with a set of
namespace flags, write cgroup limits, then `exec` the binary. No kernel boots, no firmware runs,
nothing is emulated. The process starts in milliseconds because there is nothing to start.

Understanding that sentence explains both why containers are cheap and why they are not a
security boundary in the way a virtual machine is.

## The comparison that matters

| Property | Virtual machine | Container |
|---|---|---|
| Kernel | Its own guest kernel | The host's kernel |
| Boot | Seconds (firmware, kernel, init) | Milliseconds (fork/exec) |
| Isolation unit | Hypervisor + hardware virtualisation | Namespaces, cgroups, LSM, seccomp |
| Density | Tens per host | Hundreds per host |
| Syscall path | Guest → hypervisor exit → host | Straight to host kernel |
| Escape requires | Hypervisor or device bug | Kernel or runtime bug, or a misconfiguration |
| Memory overhead | Fixed per VM (200 MB–1 GB) | The process's own pages |
| Live migration | Mature | Not a kernel concept |

The practical reading: with a VM, one kernel bug is contained by the hypervisor. With a
container, one kernel bug is the whole host. That does not make containers unsafe — it makes the
threat model different, and it means "we run containers" is not on its own a security control.
Chapter 8 is about closing that gap.

A quick check confirms the shared kernel: `docker run --rm alpine uname -r` prints the host's
release, and a kernel module loaded on the host is visible from every container.

## Namespaces: what a process can see

A namespace wraps a global kernel resource so that processes inside it see their own instance.
Docker creates one of each per container.

| Namespace | Flag | What it isolates |
|---|---|---|
| Mount | `CLONE_NEWNS` | Filesystem tree; the container root is `pivot_root`'d |
| PID | `CLONE_NEWPID` | Process IDs; the entrypoint appears as PID 1 |
| Network | `CLONE_NEWNET` | Interfaces, routes, iptables rules, sockets |
| UTS | `CLONE_NEWUTS` | Hostname and domain name |
| IPC | `CLONE_NEWIPC` | System V IPC and POSIX message queues |
| User | `CLONE_NEWUSER` | UID/GID mapping; root inside can be unprivileged outside |
| cgroup | `CLONE_NEWCGROUP` | View of the cgroup hierarchy |
| Time | `CLONE_NEWTIME` | Boot and monotonic clocks (not wall clock) |

Two consequences are worth internalising. **PID 1 is your entrypoint**, and PID 1 in Linux has
special signal semantics: the kernel ignores signals with default dispositions, so an application
that does not install a `SIGTERM` handler will not shut down gracefully — Docker waits out its
timeout and sends `SIGKILL`. PID 1 is also expected to reap orphaned children; a shell
entrypoint that does not `exec` its process leaves zombies and swallows signals. `docker run
--init` inserts a tiny init to handle both.

**The network namespace is why `localhost` is not the host.** A container's loopback is its own;
`127.0.0.1:5432` inside the container is not the host's Postgres unless the container uses
`--network host`.

You can inspect the mapping from the host:

```bash
docker inspect -f '{{.State.Pid}}' api
lsns -p "$(docker inspect -f '{{.State.Pid}}' api)"
nsenter -t "$(docker inspect -f '{{.State.Pid}}' api)" -n ss -lntp
```

That `nsenter` trick is the practical way to look at a container whose image has no shell.

## cgroups: what a process can use

Namespaces control visibility; control groups control consumption. cgroups v2 (the unified
hierarchy, default on current distributions) exposes every limit as a file, and Docker's
`systemd` cgroup driver creates a scope per container under
`/sys/fs/cgroup/system.slice/docker-<id>.scope`.

| Docker flag | cgroup v2 file | Behaviour |
|---|---|---|
| `--memory 512m` | `memory.max` | Hard cap; the cgroup OOM killer fires at the limit |
| `--memory-reservation` | `memory.low` | Soft protection under host pressure |
| `--cpus 1.5` | `cpu.max` = `150000 100000` | Quota per 100 ms period, not a reserved core |
| `--cpu-shares 512` | `cpu.weight` | Relative share only when the CPU is contended |
| `--cpuset-cpus 0-3` | `cpuset.cpus` | Hard affinity to physical cores |
| `--pids-limit 200` | `pids.max` | Blocks fork bombs |
| `--memory-swap` | `memory.swap.max` | Total memory+swap; equal to `--memory` means no swap |

The CPU distinction is the one people get wrong in production. A quota is a ceiling, not a
reservation: a container with `--cpus 1` on a busy host gets throttled in 100 ms slices, and
`cpu.stat` shows `nr_throttled` climbing while average utilisation looks modest. Latency-sensitive
services see p99 spikes at exactly the throttling boundary, which is why "the CPU graph is only
at 60%" and "requests are slow" can both be true.

Memory limits are equally literal. Exceeding `memory.max` triggers the cgroup OOM killer, the
kernel sends `SIGKILL`, and Docker reports exit code 137 with `OOMKilled: true`. Page cache
counts toward the limit but is reclaimable, so a container can sit near its limit for hours
without dying — until an application allocates faster than the kernel can evict cache.

## What is still shared

Namespaces are not a blanket. Inside a container you still see:

- The host kernel and its version, and therefore every kernel vulnerability.
- Host-wide load average; `/proc/loadavg` is not namespaced.
- `free` and `/proc/meminfo` typically report host memory, not the cgroup limit — which is why
  runtimes that size heaps from `/proc/meminfo` over-allocate and get OOM-killed. Modern JVMs
  read cgroup limits (container support is on by default since JDK 10), Node needs an explicit
  `--max-old-space-size`, and Go's `GOMAXPROCS` historically followed CPU affinity rather than
  quota.
- Any host path bind-mounted in, including `/var/run/docker.sock`, which is equivalent to root
  on the host for anyone who can reach it.
- The clock. The time namespace offsets boot and monotonic clocks only; wall clock is shared, so
  tests that manipulate system time affect the host.

The `nproc` example is a good diagnostic habit: a container with `--cpus 0.5` still reports every
host core, so a worker pool sized from `nproc` starts eight times too many threads and then
fights the quota.

## When the weaker boundary is not enough

Run untrusted code — customer uploads, CI jobs from forks, a multi-tenant function platform — and
the shared kernel is the wrong boundary. The options, in increasing order of cost:

- **gVisor** interposes a user-space kernel that implements the syscall surface, so the real
  kernel sees very little.
- **Kata Containers** runs each pod in a lightweight VM with a real guest kernel, at the cost of
  boot time and memory per pod.
- **Firecracker** microVMs give VM isolation with sub-second starts, which is how several
  function platforms run untrusted code.

For trusted internal services, a hardened container on a patched kernel is a reasonable boundary.
Being explicit about which of those two worlds you are in is what separates an architecture
decision from a hope.

## Common mistakes

- Describing containers as "lightweight VMs". They share a kernel; that is the defining property.
- Sizing memory, heaps or thread pools from what the container reports via `free` or `nproc`.
- Treating `--cpus` as a guarantee of CPU time rather than a throttling ceiling.
- Assuming a process inside the container will stop on `SIGTERM` when it never installed a handler.
- Mounting the Docker socket into a container "so it can manage siblings", which grants host root.

## Production notes

Run cgroup v2, set both a limit and a request (or reservation) for every workload, and alert on
`OOMKilled` and on sustained CPU throttling rather than on average utilisation. Give every
container a `--pids-limit` — a runaway fork loop takes down the host, not just the container.
Keep the kernel and the container runtime patched: most container escapes in the last decade
were runtime bugs (`runc`) rather than application bugs, and a host kernel from three years ago
is the largest piece of unpatched attack surface in the stack.
