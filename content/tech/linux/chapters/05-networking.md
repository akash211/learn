# Networking: Addressing, DNS, Sockets and Firewalls

Network debugging on Linux is the art of reading the kernel's own state — addresses, routes, sockets,
conntrack entries, and rulesets — instead of guessing. `ip`, `ss`, `resolvectl` and `nft` expose all
of it. The old `ifconfig`/`netstat`/`iptables` tools are largely wrappers or deprecated; learning the
current ones removes a layer of translation.

## Addresses and links

```bash
ip -br addr                  # one line per interface, with operstate
ip addr add 10.20.0.5/24 dev ens5
ip link set ens5 up
ip -s link show ens5         # RX/TX errors and drops — first stop for "slow network"
```

The prefix length is not cosmetic. `10.20.0.5/24` implies a route for `10.20.0.0/24` via `ens5`, and
a misconfigured netmask produces the classic "can reach the gateway, nothing else". Check
`ip route get 8.8.8.8` — it prints the exact route, source address, and interface the kernel will
use, which beats reasoning about a routing table by eye.

Configuration is managed by one of three stacks, and knowing which one owns an interface prevents
config that vanishes:

| Stack | Typical host | Config |
|---|---|---|
| Netplan | Ubuntu 18.04+ | `/etc/netplan/*.yaml` → `netplan apply` |
| NetworkManager | RHEL desktop, Fedora, many cloud images | `nmcli`, keyfiles in `/etc/NetworkManager/system-connections` |
| systemd-networkd | Minimal/cloud images, containers | `/etc/systemd/network/*.network` |
| `/etc/network/interfaces` | Debian ≤11, legacy | `ifupdown` — do not mix with Netplan |

Netplan is only a generator: it renders into NetworkManager or systemd-networkd, so debugging
usually means `netplan get` and then `networkctl status` or `nmcli device show`. A hand-edited
`/etc/resolv.conf` on a Netplan host will be overwritten on the next apply.

## Routes, briefly but properly

```bash
ip route                     # main table: default, connected, static
ip route add 10.99.0.0/16 via 10.20.0.1
ip route add default via 10.20.0.1 metric 100
ip rule list                 # policy routing: which table to consult, in order
```

A host with two uplinks needs either metrics (lowest wins) or policy routing (`ip rule` plus a
custom table per uplink). `ip route get <ip> from <src>` shows the decision with a specific source,
which is how you prove that replies will leave by the wrong interface — asymmetric routing is a
firewall problem more often than a routing one.

Forwarding is off by default: `sysctl net.ipv4.ip_forward=1` (persist in
`/etc/sysctl.d/99-router.conf`) is required before a host can route or NAT for anything, including
Kubernetes pods made routable without an overlay.

## DNS: three layers that disagree

Resolution involves `/etc/nsswitch.conf` (order of sources), the stub resolver config
(`/etc/resolv.conf`), and whatever daemon owns it.

- On systemd-resolved hosts, `/etc/resolv.conf` is a symlink to `../run/systemd/resolve/stub-resolv.conf`
  pointing at `127.0.0.53`. `resolvectl status` shows per-link DNS servers, the current DNS server in
  use, and DNSSEC state; `resolvectl query example.com` shows which server answered.
- `resolvectl flush-caches` clears the cache. A stale record after a failover is a resolved cache
  entry far more often than anything upstream.
- `getent hosts name` resolves through NSS exactly as applications do; `dig`/`host` bypass NSS and
  ask DNS directly. When they disagree, the problem is in `/etc/hosts`, `nsswitch.conf`, or search
  domains.
- Multiple `search` domains plus `ndots:5` in `resolv.conf` produces the notorious latency on
  short names: the resolver appends every search suffix before trying the name as-is. In containers
  and Kubernetes this shows up as 5×100 ms delays per lookup.

`dig +trace example.com` follows the delegation chain from the root, which distinguishes "our
resolver is broken" from "the authoritative zone is broken". `dig @1.1.1.1 example.com` tests an
external resolver and separates upstream failure from local config.

## Sockets: who is listening

```bash
ss -tulpen                  # TCP+UDP listeners, numeric, with process and user
ss -tan state established '( dport = :5432 or sport = :5432 )'
ss -s                       # summary: total, TCP states, memory
ss -tan | awk '{print $1}' | sort | uniq -c   # connection state histogram
```

`ss -tulpen` is the single most useful network command on a server: it answers "is it listening",
"on which address", "which process", and "as which user" in one shot. `:5432` bound to `127.0.0.1`
means it is not reachable from outside, regardless of firewall rules — a distinction that resolves a
large share of "the firewall is open but I cannot connect" tickets.

`TIME_WAIT` accumulating in the thousands is normal on a busy client; `SYN-SENT` stuck is a
firewall or routing drop; `CLOSE_WAIT` growing steadily is an application that is not closing its
sockets. `ss -s` also reports orphaned sockets and memory pressure from socket buffers.

## Firewalls: nftables underneath, front ends on top

The kernel packet filter is nftables. `iptables` on a current distro is `iptables-nft`, a
compatibility front end that compiles into the same ruleset; `nft list ruleset` shows the truth.

`ufw` (Ubuntu/Debian) and `firewalld` (RHEL family) are policy managers over that. A minimal host
firewall with nftables directly:

```bash
nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority 0; policy drop; }'
nft add rule inet filter input ct state established,related accept
nft add rule inet filter input iif lo accept
nft add rule inet filter input ip protocol icmp accept
nft add rule inet filter input tcp dport { 22, 443 } ct state new accept
nft list ruleset > /etc/nftables.conf      # persist (nftables.service loads this)
```

The `ct state established,related` rule is not optional: without it, replies to your own outbound
connections are dropped. `ct state invalid drop` at the top is the other habit worth having — it
discards packets conntrack cannot classify.

With ufw, the equivalent is smaller but make sure the default policy is what you think:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw limit 2222/tcp        # rate-limits new connections: a crude SSH brute-force damper
ufw status verbose
```

Two traps specific to ufw and firewalld: **Docker publishes ports by inserting its own DNAT rules that
bypass the input chain**, so a container on `-p 8080:80` is reachable even with `ufw deny 8080`; and
firewalld's default zone may allow services you did not intend (`cockpit`, `dhcpv6-client`). Always
verify from outside with `ss` plus an actual connection attempt, not by reading the rule list.

For a router, NAT is a postrouting masquerade:

```bash
nft add rule inet filter postrouting oifname "ens5" masquerade
sysctl -w net.ipv4.ip_forward=1
```

Missing the forwarding sysctl is the usual reason NAT "does not work" while the rules look correct.

## Observing traffic

```bash
tcpdump -ni any -c 50 'tcp port 443 and host 10.20.0.9'
tcpdump -ni eth0 'icmp or arp'
mtr -n --report -c 20 8.8.8.8        # per-hop loss and latency
ethtool eth0 | grep -E 'Speed|Duplex|Link detected'
conntrack -L | wc -l                 # table occupancy; full table = silent drops
```

`tcpdump` answers "are the packets arriving"; `ss` answers "is anything listening"; `nft`/`conntrack`
answers "was it allowed"; the application log answers "did it process". Work that order — it is
faster than reading three configs and guessing.

## Common mistakes

- `ufw`/`firewalld` rules while `nft list ruleset` shows a second, conflicting ruleset written by
  hand or by Docker.
- Binding a service to `0.0.0.0` and assuming the firewall is the only exposure; IPv6 has its own
  rules and `nft` table `inet` covers both while `iptables` needs `ip6tables` too.
- Editing `/etc/resolv.conf` on a host where resolved or Netplan regenerates it.
- Forgetting `metric` on a second default route, then losing the primary path after a reboot.
- Testing connectivity with `ping` only: many networks drop ICMP and still pass TCP.
- Changing an interface's address over SSH and losing the session — use `nohup`, a timer, or a
  console for anything that touches the address you are connected to.

## Production notes

Keep one out-of-band path (serial console or a management network) to every host, because firewall
changes are the most reliable way to lock yourself out. Apply rules with a scheduled rollback —
`at now + 10 minutes` running `nft -f /etc/nftables.conf.bak` — before reloading a ruleset remotely.
Use `systemd-networkd`'s `networkctl status` or NetworkManager's `nmcli` in config management rather
than shipping raw interface files, and monitor interface errors, conntrack usage, and DNS latency as
first-class metrics, since all three degrade before anything visibly fails.
