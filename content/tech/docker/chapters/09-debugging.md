# Debugging and Inspecting Running Containers

The first rule of container debugging is to capture state before you change it. A restart clears
the process, the writable layer survives but its interesting contents are usually gone, and the
evidence you needed was in `docker inspect` five seconds before. The second rule is that most
"the container is broken" reports are really "the process exited and nobody read the exit code".

## Establish what happened, in order

```bash
docker ps -a                          # exit codes, restart counts, health status
docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' api
docker logs --tail 200 --timestamps api
docker events --since 30m --filter container=api
```

`docker ps -a` is the highest-value command in the toolbox because the `STATUS` column carries
the exit code: `Exited (0)` is a clean finish you did not expect, `Exited (1)` is an application
error, `Exited (137)` is `SIGKILL` and usually the OOM killer, `Exited (143)` is `SIGTERM` and
usually a normal stop. Chapter 6 has the full table.

A container that restarts constantly barely appears in `docker ps`. `docker ps -a` plus
`RestartCount` shows the loop, and `docker events` shows the timing — a container that dies every
90 seconds is a healthcheck timeout or a crash on a scheduled task, not a random failure.

## Logs only exist if the application writes to stdout

Docker captures the container's stdout and stderr streams and hands them to the configured logging
driver. A process that writes to `/var/log/app.log` inside the container produces nothing in
`docker logs`, because the daemon never sees it.

```bash
docker logs -f --since 10m --tail 100 api
docker logs --timestamps api 2>&1 | grep -i "traceback" -A 20
```

`--timestamps` matters more than it looks: without it you cannot correlate container output with
metrics, load-balancer logs or `docker events`, and correlation is usually how the cause is found.

The inverse problem is a logging driver in which `docker logs` does not work at all — `journald`,
`fluentd`, `awslogs` and `gelf` do not keep a local buffer. `docker inspect --format
'{{.HostConfig.LogConfig.Type}}'` tells you which driver is in play before you conclude the
container is silent.

## Getting a shell when there is no shell

`docker exec -it api sh` fails on a distroless or `scratch` image. Three approaches, in order of
invasiveness:

```bash
# 1. Share the target's namespaces; read its filesystem through /proc/1/root
docker run --rm -it \
  --pid=container:api --network=container:api \
  --cap-add SYS_PTRACE --security-opt no-new-privileges \
  busybox sh
# then: ls /proc/1/root/app

# 2. From the host, enter the namespaces directly
nsenter -t "$(docker inspect -f '{{.State.Pid}}' api)" -a --preserve-credentials

# 3. Copy the interesting file out and inspect it locally
docker cp api:/app/config.yaml ./config.yaml
```

Option 1 is the one to remember: joining the PID namespace gives you the target's process tree
and, through `/proc/<pid>/root`, its root filesystem, without modifying the image or restarting
the container. `SYS_PTRACE` is needed for `strace` and for some `/proc` inspection, and it is a
capability worth adding only to the throwaway debug container.

If the image has no shell at all and the application is not starting, `docker run --rm -it
--entrypoint sh image` fails too. Then the shortest path is a debug variant of the image
(`FROM app AS debug` plus busybox) or `docker cp` of the binary into a scratch container that has
a shell.

## Inspecting configuration and state

```bash
docker inspect api | jq '.[0].Config.Env, .[0].NetworkSettings.Networks'
docker inspect --format '{{json .Mounts}}' api
docker inspect --format '{{json .State.Health}}' api
docker top api
docker diff api
docker stats --no-stream
```

`docker diff` lists files changed in the writable layer since the container started (`A` added,
`C` changed, `D` deleted). It answers "what did this container write" in one command, and it is
how you find the 40 GB of temp files filling the disk, or the fact that a process is rewriting
its own code.

`docker stats` gives live CPU, memory, network and block I/O per container; `--no-stream` prints
once, which is what you want in a script. For the detail behind the number, read the cgroup
files directly:

```bash
docker inspect --format '{{.HostConfig.CgroupParent}}' api
cat /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' api).scope/cpu.stat
```

`nr_throttled` climbing while `usage_usec` looks modest is the signature of a CPU quota that is
too tight — a latency problem that never shows up in an average utilisation graph.

## Network debugging without polluting the image

```bash
docker run --rm --network container:api nicolaka/netshoot \
  sh -c 'ss -lntp; dig +short db; curl -sv --max-time 2 http://localhost:8000/health'
```

`--network container:api` puts the debug container in the target's network namespace, so
`localhost` and the DNS resolver are the target's. This distinguishes three failures that look
identical from outside: the process is not listening (nothing in `ss`), it is listening on the
wrong interface (bound to `127.0.0.1` instead of `0.0.0.0`), or DNS cannot resolve the peer
(`dig` fails while `curl` to an IP works).

The fourth case, "the port is published but nothing answers", is usually a host firewall or a
process bound to loopback inside the container. `docker port api` and `ss -lntp` on the host
separate those quickly.

## Crashes that leave nothing behind

A process killed by the kernel produces no stack trace in the application log. Three checks:

- `docker inspect --format '{{.State.OOMKilled}}'` — was it memory?
- `dmesg -T | tail -40` on the host — the OOM killer and segfaults are logged there, not in the
  container.
- `docker run --ulimit core=-1` plus a writable path — native crashes can be captured, but the
  core pattern is a host-wide setting and inside a container the dump needs somewhere to go.

For a process that is alive but stuck, `strace -p 1 -f` from a debug container with `SYS_PTRACE`
shows whether it is blocked in a syscall (a socket read, a lock) or spinning. `py-spy dump
--pid 1` does the same for Python and needs no code change; it is the single best tool for a
hung Python service.

## `docker commit` is not a fix

It is tempting to exec in, patch a file, and `docker commit` the result. The commit produces an
image that no Dockerfile describes, no review covered, and no rebuild can reproduce. It is
acceptable to commit a container as forensic evidence before destroying it — and worth stating
plainly that the fix must land in the Dockerfile and be rebuilt.

## Common mistakes

- Restarting before reading `docker inspect .State`, which discards the exit code and OOM flag.
- Reading application logs from a file inside the container and concluding "there are no logs".
- `docker exec` on a distroless image and concluding the container cannot be debugged.
- `--privileged` added to the debug container, which changes the behaviour being investigated.
- Debugging from inside the container's own network namespace with the tools missing, instead of
  joining the namespace from a tool image.
- `docker attach` on a service, then `Ctrl-C`, which sends `SIGINT` to the application and stops
  it. Use `exec`, or detach with `Ctrl-P Ctrl-Q`.

## Production notes

Make the three inputs available before an incident: structured logs on stdout with a request ID,
a `/health` endpoint that reports dependency status without being expensive, and container
metadata (image digest, version, commit) exposed on a metrics endpoint. Then the debugging
sequence is correlation rather than archaeology. Keep a debug image with `curl`, `ss`, `dig`,
`tcpdump` and a Python profiler in the registry, so joining a namespace takes seconds instead of
a build.
