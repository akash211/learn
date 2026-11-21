# Networking, DNS and Persistent Storage

Two questions decide most container outages: can this process reach that one, and where does the
data go when the container is replaced. Docker's defaults answer neither question well, and the
defaults are what people use.

## Four network modes worth knowing

| Driver | Scope | Isolation | Use when |
|---|---|---|---|
| `bridge` (default) | Single host | Own subnet, NAT to the host | Almost everything on one host |
| `host` | Single host | None — shares the host stack | Maximum throughput, or a process that must bind host ports |
| `none` | Single host | Loopback only | Batch jobs that must not talk to anything |
| `overlay` | Multi-host (Swarm) | VXLAN per network | Services across several hosts |
| `macvlan` | Multi-host (L2) | Own MAC on the physical network | Legacy appliances that need a real IP on the LAN |

The default `bridge` network (`docker0`, usually `172.17.0.0/16`) is a leftover from early
Docker and is the wrong default to keep. It has no automatic DNS: containers cannot resolve each
other by name, only by IP, or through the deprecated `--link` mechanism. Create a user-defined
bridge instead — it gets embedded DNS, a dedicated subnet, and isolation from unrelated stacks:

```bash
docker network create --driver bridge --subnet 172.28.0.0/16 app-net

docker run -d --name db  --network app-net -e POSTGRES_PASSWORD=secret postgres:16
docker run --rm --network app-net postgres:16 \
  psql -h db -U postgres -c 'select 1'
```

That `psql -h db` works because Docker runs a DNS resolver at `127.0.0.11` inside every
user-defined network, answering for container names and network aliases. Compose leans on this
entirely: a service called `db` is reachable at hostname `db` from any other service on the same
network, and the connection string never mentions an IP.

Aliases decouple the hostname from the container name, which matters when several containers
provide the same service:

```bash
docker run -d --name db-1 --network app-net --network-alias db postgres:16
docker run -d --name db-2 --network app-net --network-alias db postgres:16
```

A client resolving `db` gets one of the two addresses, round-robin. That is DNS-level load
balancing with no health awareness — a dead container still receives a share of connections until
it is removed. It is fine for stateless replicas and wrong for anything that needs failover.

## Publishing ports, and what EXPOSE does not do

```bash
docker run -d -p 8080:80 nginx:1.27            # all interfaces, host 8080 → container 80
docker run -d -p 127.0.0.1:8080:80 nginx:1.27  # loopback only
docker run -d -p 8080:80/udp nginx:1.27        # UDP
docker run -d -P nginx:1.27                    # every EXPOSEd port on a random host port
docker port <container>
```

`-p 8080:80` is implemented with an iptables DNAT rule in the `DOCKER` chain, so traffic bypasses
the daemon and goes straight to the container's veth. Binding to `0.0.0.0` is the default and the
most common accidental exposure: a database published with `-p 5432:5432` on a cloud host is on
the public internet if the security group allows it. Publish on `127.0.0.1` unless something
outside the host genuinely needs the port.

`EXPOSE` in a Dockerfile does not publish anything. It records intent in the image metadata, and
its only runtime effect is to make `-P` and `docker compose` port inference work. Treating
`EXPOSE 5432` as access control is a recurring audit finding.

`--network host` removes the network namespace entirely: the container binds the host's
interfaces directly, `-p` is ignored with a warning, and two containers cannot both bind `:8080`.
It is worth it for high-throughput proxies and for tools that must see the real source IP; it is
not worth it as a shortcut to avoid understanding port mapping.

## Overlay networks and multi-host

`overlay` requires Swarm mode (`docker swarm init`) and gives every service a VIP plus
per-network VXLAN encapsulation on UDP 4789. Standalone containers can join an overlay only if
it was created `--attachable`. Encryption (`--opt encrypted`) is available but has a throughput
cost and is Swarm-only.

In practice, if you need multi-host container networking with service discovery, health-aware
load balancing and rolling updates, you are describing Kubernetes or Nomad, and the overlay
network is a detail those platforms manage. Swarm is still a reasonable small-footprint choice,
but its decline means fewer people can debug it.

## Volumes, binds and tmpfs

| Mount | Declared as | Lives | Typical use |
|---|---|---|---|
| Named volume | `-v pgdata:/var/lib/postgresql/data` | `/var/lib/docker/volumes/<name>/_data` | Databases, uploads, anything that must survive |
| Bind mount | `-v "$PWD/app:/app"` | A host path you name | Source code in development, host config files |
| tmpfs | `--tmpfs /tmp` | RAM, never on disk | Scratch space, secrets that must not hit disk |
| Anonymous volume | `VOLUME /data` in the image | A random-named volume | Legacy; hard to find and easy to leak |

Named volumes are the right default for state. They survive `docker rm`, are owned by Docker
rather than by a path you invented, and can be backed up without knowing the application's
layout. Bind mounts are a development convenience and a production liability: they depend on the
host's directory structure, they carry the host's UID ownership, and on macOS and Windows they go
through a virtual filesystem layer that makes them several times slower than a native mount.

The `--mount` form is more explicit and fails loudly instead of silently creating a directory
when a source path is wrong:

```bash
docker run -d \
  --mount type=bind,source=/srv/config,target=/etc/app,readonly \
  --mount type=volume,source=appdata,target=/var/lib/app \
  app:1.4
```

The classic bug with bind mounts is the development override:
`-v "$PWD:/app"` hides everything the image installed at `/app`, including the virtualenv or
`node_modules`, so the container starts with an empty dependency tree. Mount the source
subdirectory, not the application root.

Two more traps worth knowing. A `VOLUME` instruction in a Dockerfile creates an anonymous volume
at that path on first run, which is why `docker run` on such an image silently produces storage
nobody tracks; and, with the classic builder, a later `RUN` that writes to a declared volume path
has its changes discarded, so a config file copied in after `VOLUME` never appears. BuildKit
preserves those writes, which is one more way the two builders disagree.

## Backups and shared storage

A volume is a directory, so backing it up is a container that mounts it read-only and writes an
archive somewhere else:

```bash
docker run --rm \
  -v pgdata:/data:ro \
  -v "$PWD:/backup" \
  alpine:3.20 tar czf /backup/pgdata-$(date +%F).tar.gz -C /data .
```

For shared storage across hosts, the `local` driver can mount NFS directly:

```bash
docker volume create --driver local \
  --opt type=nfs \
  --opt o=addr=10.0.0.5,rw,nfsvers=4 \
  --opt device=:/export/appdata \
  appdata
```

This works and is used in small deployments, but it puts availability of the filesystem on the
critical path of every container start. In Kubernetes the equivalent is a PersistentVolume with
a CSI driver, which at least models attach/detach and access modes.

## Debugging connectivity

```bash
docker network inspect app-net --format '{{json .Containers}}'
docker exec -it api getent hosts db
docker exec -it api ss -lntp
docker run --rm --network container:api nicolaka/netshoot dig db
```

`--network container:api` joins the target's network namespace, which is how you run `dig`,
`ss` or `tcpdump` against a container whose image has no such tools. It is the single most useful
networking trick in the toolbox (chapter 9 uses it more).

## Common mistakes

- Keeping the default bridge network and then hardcoding container IPs.
- Publishing a database on `0.0.0.0` and calling it internal because the port number is unusual.
- Assuming `depends_on` means the database is ready — it means it was started (chapter 5).
- Storing database files in the container's writable layer, then losing them on `docker rm`.
- `docker compose down -v` in a script that also holds production data.
- Bind-mounting `$PWD` over the application directory and losing installed dependencies.

## Production notes

Give each stack its own user-defined network, and use `--internal` on networks that hold
databases and queues so they have no route out. Keep state in named volumes or an external
managed service, never in the container layer. Put a backup job on the volumes you care about and
restore it once before you need to. And reserve `--network host` for the few processes where the
network namespace actually costs something measurable.
