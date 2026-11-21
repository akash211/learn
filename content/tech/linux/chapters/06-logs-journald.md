# Logs, journald and Log Retention

Logs answer two different questions: "what is happening right now" and "what happened at 03:14 last
Tuesday". A server that lost the second answer is undebuggable after the fact, and the usual reason
is a journal that only lives in `/run` (wiped on reboot) plus rotated files that were never shipped
anywhere.

## journald is the default sink

systemd-journald collects from the kernel (`kmsg`), from stdout/stderr of units it starts, from
syslog sockets, and from the audit subsystem. Each entry carries structured fields — `_PID`,
`_UID`, `_SYSTEMD_UNIT`, `PRIORITY`, `_HOSTNAME`, `_COMM`, `SYSLOG_IDENTIFIER` — which is why
filtering is field-based rather than text-based.

```bash
journalctl -u api --since "1 hour ago" -o short-iso
journalctl -b -1 -p err                 # previous boot, errors and worse
journalctl -k -b                        # kernel ring buffer for this boot
journalctl -u api -f                    # follow
journalctl --grep='timeout|refused' -u api --since today
journalctl -o json-pretty -n 1 -u api   # every field, for a log pipeline
journalctl --disk-usage
journalctl -p warning..err --since "2026-02-01" --until "2026-02-02 06:00"
```

`-p` takes either a level or a range: `0` emerg through `7` debug, and `err` means "err and worse"
(0–3), while `warning..err` is the explicit range 4–3. `-b -1` is the previous boot, `-b -2` two
boots ago; `journalctl --list-boots` prints the index. `-u` accepts a unit, a slice, or a glob, and
`--user-unit` covers user services.

## Persistence is a decision you make once

By default, `/var/log/journal` absent means the journal is volatile in `/run/log/journal`, and
reboots erase it. Check with `ls -d /var/log/journal` — many cloud images ship without it.

```ini
# /etc/systemd/journald.conf
[Journal]
Storage=persistent          # auto | volatile | persistent | none
Compress=yes
SystemMaxUse=2G             # cap total journal size
SystemMaxFileSize=200M
SystemKeepFree=1G           # always leave this much on the filesystem
MaxRetentionSec=30day
RateLimitIntervalSec=30s
RateLimitBurst=10000
ForwardToSyslog=no
```

The two settings that prevent incidents: `SystemMaxUse` (an unbounded journal filling `/var` is a
self-inflicted outage) and `RateLimitBurst`. The default rate limit drops messages above roughly
10 000 per 30 s *per service* and writes "Suppressed N messages" — which is exactly the burst of
errors you need after a crash. Raise it on hosts that log heavily, and notice the suppression line
when reading a gap.

`Storage=auto` means "persistent if `/var/log/journal` exists, otherwise volatile" — creating that
directory and restarting journald is the whole migration. After switching, `journalctl --vacuum-size=2G`
or `--vacuum-time=30d` trims existing data.

## Reading a log line properly

A typical entry in `short-iso` form:

```
2026-02-11T03:14:07+0000 web-3 systemd[1]: api.service: Main process exited, code=killed, status=9/KILL
```

Fields in order: timestamp, hostname, identifier (`systemd`, or the process name), PID, message. Note
`status=9/KILL` — that is the *exit* status after a signal, and the preceding line normally says who
sent it. With `-o verbose` you get `_SYSTEMD_CGROUP`, `_CMDLINE`, `_EXE`, and the invocation ID,
which is how you correlate a service's log lines with its lifecycle events (`Starting`, `Started`,
`Failed`).

`journalctl _COMM=sshd` filters by executable name; `journalctl _PID=4242` by PID (useful while it
still exists). `journalctl -o cat` drops the prefix, which is what you want when piping into another
tool.

## The other logs

journald does not replace everything:

| Source | Where | Note |
|---|---|---|
| Auth events | `journalctl -u ssh`, `/var/log/auth.log` (Debian) | sudo, sshd, PAM, cron |
| Package manager | `/var/log/apt/history.log`, `dnf history` | Survives journal vacuuming |
| Kernel/hardware | `dmesg -T`, `journalctl -k` | Ring buffer is finite; errors scroll away |
| Audit | `/var/log/audit/audit.log` | `ausearch`, `aureport`; `auditd` has its own rotation |
| Application | `/var/log/<app>/*.log` | logrotate territory |
| Web servers | `/var/log/nginx/access.log` | Volume is high; ship, do not keep 90 days locally |

`dmesg` is a fixed-size ring buffer: on a host with chatty drivers, the OOM kill from last night may
already be gone. `journalctl -k` is persistent (if the journal is), which is why it is the better
answer.

## logrotate still matters

journald rotates by size; application logs need `logrotate`, driven by `logrotate.timer` (or cron).

```
/var/log/api/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 api adm
    sharedscripts
    postrotate
        systemctl reload api >/dev/null 2>&1 || true
    endscript
}
```

Points that cause real failures:

- **`copytruncate` vs reopen.** If the application holds the file open, `create` + `postrotate` only
  works if the app reopens its log (usually on `SIGHUP`). Otherwise use `copytruncate`, which copies
  then truncates in place — at the cost of losing writes in the gap.
- **`dateext`** produces `access.log-20260211` instead of `.1`; nice for shipping, and it means
  `rotate 14` keeps 14 *days*, not 14 files.
- **Test with `logrotate -d`** (debug, no action) and force a run with `logrotate -f`. A config error
  stops rotation for *every* log in the file, not just the broken stanza.
- **`su`/`create` ownership.** Rotation as root creating 0644 root-owned files breaks a service that
  runs as `www-data` on the next write.

## Shipping and retention

Local retention is for debugging the last few days; durable retention belongs in a log platform
(Loki, Elasticsearch, CloudWatch, S3 via a shipper). Three ways out of a host, in increasing order of
control:

1. `journald` `ForwardToSyslog=yes` → rsyslog → remote (`*.* @@loghost:514`, TCP).
2. A shipper reading the journal directly: `vector`, `promtail`, `fluent-bit`, reading
   `journalctl -o json` or `/var/log/journal`.
3. Cloud agent per provider — convenient, and it usually costs egress.

Whatever the path, decide retention explicitly: 7 days hot for debugging, 90 days warm for audits,
and a documented answer for "who can read production logs". Logs contain tokens, email addresses and
occasionally passwords; treat the aggregator as sensitive data, not a dumping ground.

## Common mistakes

- Discovering at 09:00 that the journal is volatile and last night's crash evidence is gone.
- `journalctl -u api` on a host where the app logs to a file, or vice versa — check
  `systemctl cat api` for `StandardOutput=`/`StandardError=`.
- Letting the journal grow unbounded until `/var/log` fills, then blaming the application.
- Grepping rotated `.gz` files by hand instead of shipping them.
- Assuming `dmesg` is persistent. It is not.
- Rotating a file a process holds open without `copytruncate` or a reload: disk keeps filling while
  the new file stays empty.

## Production notes

Set `Storage=persistent`, `SystemMaxUse` and `MaxRetentionSec` in configuration management so every
host has the same answer. Alert on `journalctl -p err -b --no-pager | wc -l` trending up and on
`journalctl --disk-usage` approaching the cap. Include the journal in incident capture: before a
reboot, `journalctl -b -o short-iso --no-pager > /root/incident-$(date +%s).log` preserves what the
next boot will not. Keep the clock honest — `timedatectl set-ntp true`, `chronyc tracking` — because
logs from a host with drifting time cannot be correlated with anything.
