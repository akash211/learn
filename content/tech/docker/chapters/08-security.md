# Hardening the Container

Container security is not one setting. It is a stack of independent controls, each closing a
different path: what the image contains, who the process runs as, which kernel interfaces it can
reach, what it can write, and what happens if the application is compromised. Removing one layer
does not make the others useless, and adding one does not make the rest optional.

The threat model worth writing down has four entries: a compromised base image or dependency, a
compromised registry or build pipeline, an application vulnerability that gives an attacker code
execution, and a kernel or runtime bug that turns code execution into a host escape. Chapters 3
and 7 cover the first two. This chapter covers the last two.

## Capabilities: the root privilege split

Linux splits root's power into roughly forty capabilities. Docker grants a default set of
fourteen: `CHOWN`, `DAC_OVERRIDE`, `FSETID`, `FOWNER`, `MKNOD`, `NET_RAW`, `SETGID`, `SETUID`,
`SETFCAP`, `SETPCAP`, `NET_BIND_SERVICE`, `SYS_CHROOT`, `KILL` and `AUDIT_WRITE`.

Most services need two or three of those. A Python API on port 8000 needs none of them:

```bash
docker run -d \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  app:1.4
```

`--cap-drop ALL` is the correct starting point, with additions justified one at a time.
`NET_RAW` — in the default set — permits raw sockets and is the capability behind several
container-escape techniques and most network spoofing; almost nothing needs it. `SYS_ADMIN` is
the dangerous one: it covers mount, namespace manipulation and a long tail of ioctls, and it is
close to root in practice. A container with `SYS_ADMIN` and a writable `/sys` is a host escape
waiting for a technique.

`--privileged` is not "a bit more permissions". It grants all capabilities, exposes all host
devices, and disables the default seccomp and AppArmor profiles. It exists for hardware access
and nested container runtimes, and it should be a reviewed exception, never a fix for a
permission error.

`no-new-privileges` is separate and cheap: it sets `PR_SET_NO_NEW_PRIVS`, which stops `setuid`
binaries and file capabilities from escalating. It costs nothing for a normal service and closes
the "attacker finds a setuid helper in the image" path.

## seccomp and LSMs

Docker applies a default seccomp profile that blocks about 44 syscalls — mostly obsolete,
privileged or architecture-specific ones such as `mount`, `kexec_load`, `ptrace` variants and
`add_key`. It is an allowlist with a broad default: it reduces the kernel's attack surface
without breaking ordinary programs, which is why `--security-opt seccomp=unconfined` should be
treated as a red flag in review. If something needs a blocked syscall, write a profile that
allows that one rather than disabling the filter.

```bash
docker run --security-opt seccomp=/etc/docker/profiles/app.json app:1.4
```

On top of seccomp, AppArmor (Ubuntu/Debian) or SELinux (RHEL/Fedora) constrains file and network
access by path and label. Docker applies the `docker-default` AppArmor profile automatically on
hosts that support it. These controls catch classes of behaviour — writing to `/proc/sys`,
mounting filesystems — that capabilities alone do not, and they are the reason a distro's default
posture is meaningfully better than a hand-rolled one.

## Read-only root filesystems

Most services write to exactly one place. A read-only root makes the rest of the filesystem
immutable, which defeats droppers, webshells and tampering with the application's own binaries:

```bash
docker run -d \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount type=volume,source=appcache,target=/var/cache/app \
  app:1.4
```

The usual failure is a library that writes somewhere unexpected — a `.pyc` cache, `/home/app/.cache`,
a pid file. `PYTHONDONTWRITEBYTECODE=1`, `HOME` pointed at a writable tmpfs, and an explicit
cache mount solve it, and the exercise is useful: every path you have to add is a path the
application writes to, which is exactly the list an attacker would use.

`noexec,nosuid` on the tmpfs matters as much as the read-only root. A writable `/tmp` that
permits execution is where a downloaded payload lands.

## User namespaces and rootless

Everything above limits what root *inside* the container can do. User namespaces change what
root inside *is*: UID 0 in the container maps to an unprivileged UID on the host, so a container
escape lands as a nobody-level user rather than host root.

```json
// /etc/docker/daemon.json
{
  "userns-remap": "default"
}
```

With remapping enabled, the daemon allocates a subordinate UID/GID range per container from
`/etc/subuid` and `/etc/subgid` (typically `100000–165535`). Implications worth knowing before
you enable it: existing images with baked-in ownership may fail to read their own files, bind
mounts from the host show up as nobody, and `--privileged` is incompatible. It is a host-level
switch, not a per-container one.

**Rootless Docker** goes further: the daemon itself runs as an unprivileged user, using
`rootlesskit` for namespace setup and `slirp4netns` or pasta for networking.

```bash
dockerd-rootless-setuptool.sh install
systemctl --user start docker
export DOCKER_HOST=unix:///run/user/1000/docker.sock
```

The trade-offs are real: no `--privileged`, no arbitrary bind mounts outside your home, slower
networking through the user-space stack, ports below 1024 require
`net.ipv4.ip_unprivileged_port_start`, cgroup delegation must be configured by the distro, and
the storage driver is usually `fuse-overlayfs` rather than native `overlay2`. In exchange, a
compromised daemon is not host root — which is the largest single reduction in blast radius
available, and the reason rootless is the default for developer machines and CI runners that run
untrusted builds.

## The runtime is part of the attack surface

Two `runc` vulnerabilities are worth remembering because they shaped the current posture:
CVE-2019-5736, where a malicious container could overwrite the host's `runc` binary through
`/proc/self/exe` and gain host root on the next `docker exec`; and CVE-2024-21626 ("Leaky
Vessels"), where a leaked file descriptor let a container escape its working directory into the
host filesystem. Both were fixed quickly, and both were exploitable by a *container image*, not
by a kernel bug — which is why pinning and patching the runtime matters as much as scanning the
image. A container runtime from a year ago is the weakest link in an otherwise hardened stack.

Practical consequences: keep `containerd` and `runc` on the distribution's security updates, do
not run a container runtime on a host that also serves untrusted users without a VM boundary
(chapter 2), and remember that mounting `/var/run/docker.sock` into a container hands it the
daemon's full authority — the container can start a privileged container and mount the host
filesystem.

## Secrets at runtime

Environment variables are visible in `docker inspect`, in `/proc/1/environ`, and in crash dumps
and child processes. A file mount is better; a secret manager read at startup is better still.

```bash
docker run --rm \
  --mount type=bind,source=/run/secrets/db_password,target=/run/secrets/db_password,readonly \
  app:1.4
```

Docker Swarm has first-class `docker secret create`, which mounts at `/run/secrets/<name>` and
never writes to disk on the worker. Plain Docker does not, so the pattern is the same bind mount
managed by systemd, Vault, SOPS or the platform's secret store. What not to do: bake the secret
into the image (chapter 3), pass it as an `ARG`, or put it in `ENV` because "the image is
private".

## A baseline worth applying everywhere

```bash
docker run -d \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --pids-limit 200 \
  --memory 1g --cpus 1.5 \
  app:1.4
```

That is not maximum security; it is a floor that rules out the majority of real incidents without
requiring a threat model per service. Everything above it — userns remapping, custom seccomp,
signed-image admission — is incremental.

## Common mistakes

- `--privileged` to make a permission error go away.
- Mounting the Docker socket "so the container can restart siblings".
- Running as root because the base image defaults to it, then `chmod -R 777` on the app directory.
- Disabling seccomp after one blocked syscall instead of adding it to a profile.
- Treating `EXPOSE` or an internal network as authentication.
- Baking secrets into an image and marking the registry private.
- Hardening the container while leaving the host kernel and container runtime unpatched.

## Production notes

Encode the baseline as policy rather than documentation: admission control (Kyverno, Gatekeeper,
Pod Security Standards) should reject privileged pods, root users, missing limits and unsigned
images. Run `docker-bench-security` or the CIS benchmark against hosts once a quarter — most
findings are configuration drift, not new vulnerabilities. And keep the honest framing in mind:
container hardening reduces the likelihood and blast radius of an escape, but it does not create
a security boundary where the kernel is shared. If the workload is hostile, the boundary is a VM.
