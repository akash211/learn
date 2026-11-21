# Performance Triage: Load, CPU, Memory and I/O

Performance work on a server starts with one question: which resource is saturated — CPU, memory,
disk, or network — and for how long. The tools below answer that in about ninety seconds, without
installing anything.

## Load average is a queue length, not a percentage

```bash
uptime
# 03:14:07 up 41 days,  2:07,  3 users,  load average: 4.21, 2.90, 1.80
```

Those three numbers are the average number of tasks that were *runnable* (`R`) or in
*uninterruptible sleep* (`D`) over 1, 5 and 15 minutes. They are not normalised by core count, so on
an 8-core host a load of 8 means fully busy but coping, and 16 means a queue. On a 2-core host, 2 is
saturated and 4 is a problem.

The subtlety: `D` state counts. A host with load 12 and 3% CPU utilisation is waiting on disk or NFS,
not computing. Normalise, then look at `vmstat`'s `r` and `b` columns to see whether the queue is
runnable or blocked.

On a virtual machine, `%st` (steal) in `top` is essential: high steal means the hypervisor is not
scheduling your vCPU, and no tuning inside the guest will help.

## top: read the header before the process list

```
%Cpu(s):  4.2 us,  1.1 sy,  0.0 ni, 88.7 id,  5.4 wa,  0.0 hi,  0.6 si,  0.0 st
MiB Mem :  32118.0 total,   1204.3 free,  18432.6 used,  12481.1 buff/cache
MiB Swap:   2048.0 total,    992.0 used,   1056.0 free.  11020.4 avail Mem
```

- `wa` (I/O wait) is time the CPU was idle *because* every runnable task was blocked on I/O. High
  `wa` points at storage, not CPU.
- `sy` (system) high relative to `us` suggests syscall overhead — a fork storm, a container runtime,
  or network interrupt handling.
- `buff/cache` is reclaimable page cache, not memory pressure. `avail Mem` is the number that matters.
- Load inside `top` counts threads; `ps -eLf` shows the per-thread picture.

Press `1` for per-core view, `P` to sort by CPU, `M` by memory.

## vmstat: the fastest five-second summary

```bash
vmstat 1 5
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 2  1      0 210344  18204 991232    0    0    12   340  980 2104  8  3 87  2  0
12  4      0  90211  18204 991232  812 1024  9840 12044 2100 8800 22 14 48 16  0
```

- `r` above core count = runnable queue.
- `b` > 0 sustained = blocked on I/O.
- `si`/`so` non-zero = **the kernel is swapping**. This is the single most important signal on the
  line; a host that swaps is losing to memory, and latency will be dominated by it.
- `bi`/`bo` (blocks/s) show raw device throughput — compare with the device's capability.
- `cs` (context switches) climbing with `in` (interrupts) suggests a polling or fork-heavy workload.

## Memory: what "out of memory" actually means

```bash
free -h                     # read 'available', not 'free'
cat /proc/meminfo | grep -E 'MemTotal|MemAvailable|Dirty|Writeback|Slab|SReclaimable'
cat /proc/pressure/memory   # PSI: some avg10=..., full avg10=...
```

`free` being small is healthy: Linux uses spare RAM for page cache and gives it back on demand.
`MemAvailable` is the kernel's estimate of what a new workload could get without swapping. If it is
low *and* `si/so` are non-zero, you have pressure.

Pressure Stall Information is the better modern signal. `some` means at least one task was stalled on
memory; `full` means every runnable task was. A `full avg10` above a few percent is a host that is
already hurting, and unlike `free`, PSI measures the consequence rather than the cause.

Where memory goes, in order of investigation:

1. `ps -eo pid,pmem,rss,comm --sort=-rss | head` — biggest resident sets.
2. `/proc/<pid>/status` (`VmRSS`, `VmSwap`), `/proc/<pid>/smaps_rollup` for a clean total.
3. `slabtop -o | head` — a leaking kernel module shows up as `dentry` or a driver cache.

## The OOM killer

When the kernel cannot reclaim enough memory, it invokes the OOM killer, which picks a victim by
`oom_score` — roughly proportional to resident memory, adjusted by `oom_score_adj` (-1000 to 1000).
Read the evidence:

```bash
journalctl -k -b | grep -i -E 'out of memory|killed process|oom_reaper'
# Out of memory: Killed process 8842 (python3) total-vm:8412340kB, anon-rss:3982112kB
dmesg -T | grep -A3 'invoked oom-killer'
cat /proc/<pid>/oom_score
```

An OOM kill leaves a specific trace: `Killed process <pid> (<name>)`. A service that exits with
status 137 without that line was `SIGKILL`ed by something else (systemd's timeout, a container
runtime, or a human) — a distinction worth making before you start hunting a leak.

Protect the things that must not die — systemd units support `OOMScoreAdjust=-900` — and cap the
things that should: `MemoryMax=` on a unit, `memory.max` in a cgroup, `--memory` on a container. The
OOM killer choosing your database because a batch job grew is a configuration failure, not bad luck.

## iostat and pidstat: where the I/O goes

`iostat -xz 1 5` reads the block layer, not the process table. The columns that matter:

| Column | Meaning | Alarm threshold |
|---|---|---|
| `r/s`, `w/s` | Completed reads/writes per second | Compare with device capability |
| `rkB/s`, `wkB/s` | Throughput | Compare with link/volume limit |
| `await` | Average latency per request (ms), queue included | > 10 ms on SSD, > 50 ms on HDD |
| `r_await` / `w_await` | Split by direction | Reads slow, writes fast → read-ahead or cache |
| `aqu-sz` | Average queue depth (was `avgqu-sz`) | Rising with stable throughput = saturation |
| `%util` | Busy time, **meaningless for NVMe/RAID** | Only indicative on a single spindle |

The mistake to avoid is reading `%util` as "disk is full" on modern storage: a device can be 100%
busy and still have headroom. Latency (`await`) and queue depth are the honest measures. On cloud
volumes, check the baseline IOPS and burst credits — a `gp3` volume capped at 3 000 IOPS produces
exactly this signature.

`pidstat` attributes the load to processes:

```bash
pidstat -d 1 5              # per-process read/write KB/s
pidstat -u 1 5              # per-process %usr/%system, and %CPU normalised to cores
pidstat -r 1 5              # per-process RSS and page faults
pidstat -w 1 5              # context switches: cswch/s vs nvcswch/s
```

`pidstat -d` is the fastest answer to "which process is doing 400 MB/s of writes" — usually a log
file, a backup, or a database checkpoint. High `nvcswch/s` (involuntary switches) means the process
wants more CPU than it is getting.

For anything the classic tools cannot see — which syscall, which file, which socket — go to `perf top`
or a `bpftrace` one-liner (`bpftrace -e 'kprobe:vfs_read { @[comm] = count(); }'`). These end
arguments about where time goes.

## A triage sequence that works

1. `uptime` — is the load high, and is it rising?
2. `vmstat 1 5` — runnable vs blocked, swap activity, CPU split.
3. If `wa` high or `b` > 0: `iostat -xz 1` for the device, then `pidstat -d 1` for the process.
4. If `si/so` non-zero or `MemAvailable` low: `free -h`, PSI, top RSS consumers, `dmesg | grep -i oom`.
5. If CPU-bound: `top` per-core, `pidstat -u`, then `perf top` for the hot function.
6. If none of the above: check `%st` (noisy neighbour), then `ss -s` and `ip -s link`.

## Common mistakes

- Judging load without dividing by core count, or ignoring `D`-state tasks entirely.
- `echo 3 > /proc/sys/vm/drop_caches` to "free memory" — it frees nothing useful and slows the next
  reads.
- Calling every OOM kill a memory leak; most are a limit set below the working set.
- Reading `%util` as a saturation metric on NVMe or network-backed volumes.
- Tuning `swappiness` to 0 on a host with a small working set, which converts reclaimable pressure
  into OOM kills.

## Production notes

Collect the four resources as time series — load normalised by cores, `MemAvailable`, PSI `full`
averages, and per-device `await` — so you can answer "was this slow last Tuesday" without logging in.
Alert on PSI and swap-in rate rather than on `free` memory. Set `MemoryMax` and `CPUQuota` per service
so one workload cannot take the host down, and leave 10–15% memory headroom for page cache and kernel
structures. Keep a baseline: `sar -u -r -d` collected every minute for 30 days turns "it feels slow"
into a graph.
