# Boot, Bootloaders and systemd Service Management

A Linux server that will not come back after a reboot is one of the few failures you cannot work
around from inside the OS. Knowing the boot chain — and where it can break — turns that from an
outage into a ten-minute fix. The second half of this chapter is systemd, because everything after
the kernel hands over is a systemd unit.

## The chain, in order

| Stage | What runs | Where it lives | Typical failure |
|---|---|---|---|
| Firmware | UEFI/BIOS, POST, device init | SPI flash | Wrong boot order, RAID card not initialised |
| Bootloader | GRUB 2 or systemd-boot | ESP (`/boot/efi`) or MBR | Missing/corrupt `grub.cfg`, bad kernel entry |
| Kernel | `vmlinuz-*` + command line | `/boot` | Missing module, wrong root=, panic |
| initramfs | Minimal userland that mounts `/` | `/boot/initramfs-*.img` | Missing storage/NVMe driver, LUKS prompt |
| init | `systemd` as PID 1 | `/usr/lib/systemd/systemd` | Unmounted `/etc/fstab` entry, failed target |

On a UEFI machine the firmware reads boot entries from NVRAM (visible as `efibootmgr -v`) and loads
an EFI binary from the EFI System Partition. GRUB then reads `/boot/grub/grub.cfg`, loads the kernel
and the initramfs into memory, and jumps to the kernel with the command line from that entry. GRUB's
config is generated, not hand-edited: on Debian/Ubuntu `update-grub` reads `/etc/default/grub` and
`/etc/grub.d/*`; on RHEL-family systems it is `grub2-mkconfig -o /boot/grub2/grub.cfg` (or
`/boot/efi/EFI/redhat/grub.cfg` on UEFI).

Three things regularly bite here. `grub.cfg` still lists a kernel that `package-cleanup --oldkernels`
or `apt autoremove` deleted. The EFI partition is not mounted, so the grub update wrote to the OS
disk instead of the ESP. Or `/boot` filled up and the initramfs build silently failed — check with
`df -h /boot` before any kernel update, not after.

## Kernel arguments are the most useful lever

The kernel command line is where you fix a machine you cannot log into. Edit it in the GRUB menu
with `e`, boot with `Ctrl-X`, and make it permanent afterwards (in `/etc/default/grub` for GRUB).

| Argument | Effect |
|---|---|
| `systemd.unit=rescue.target` | Single-user, mounts local filesystems, starts almost nothing |
| `systemd.unit=emergency.target` | Root shell, `/` read-only, no other mounts |
| `rd.break` | Stop in the initramfs before the switch to the real root |
| `rd.luks=0` / `rd.md=0` / `rd.dm=0` | Skip LUKS, RAID, or device-mapper assembly in the initramfs |
| `root=/dev/mapper/vg-root ro` | Root device and read-only mount (fsck runs, then remounts rw) |
| `console=ttyS0,115200` | Serial console — the only way into many cloud VMs |
| `systemd.log_level=debug` | Verbose systemd output for a boot that hangs |

`rd.break` is the documented password-reset path: it drops you into the initramfs with the real root
at `/sysroot`, still unmodified by the boot. Mount it read-write, clear the root password hash, and
relabel before rebooting:

```bash
mount -o remount,rw /sysroot
chroot /sysroot passwd root
touch /.autorelabel        # required when SELinux is enforcing
exec /bin/sh -c 'reboot -f'
```

On a machine with an encrypted root, the same trick needs the LUKS passphrase first; there is no
bypass, which is exactly the point of encrypting the disk.

The initramfs is a compressed cpio archive plus a small `/init` script, not a filesystem. On RHEL it
is built by `dracut` (`lsinitrd` lists contents, `dracut -f` rebuilds); on Debian by
`update-initramfs -u -k all`. `dracut --hostonly` images include only the drivers the current
hardware needs, so an image built on a VM can fail to find the disk after a migration to different
storage — `dracut -f --regenerate-all --no-hostonly` is the fix, and "kernel panic, cannot mount
root" straight after a platform change is almost always this.

## systemd: the model

systemd is PID 1, a dependency solver, a service supervisor, a cgroup manager and a logging client.
Its unit of configuration is the *unit file*, and every boot action is a unit transition. Five types
cover nearly everything:

| Type | Represents | Example |
|---|---|---|
| `.service` | A daemon or one-shot job | `sshd.service`, `apt-daily.service` |
| `.socket` | A listening socket that activates a service on connect | `docker.socket`, `systemd-journald.socket` |
| `.timer` | A monotonic or calendar trigger | `logrotate.timer`, `apt-daily.timer` |
| `.target` | A grouping/synchronisation point, not a process | `multi-user.target` |
| `.mount` / `.path` | A mount point or an inotify watcher | `-.mount`, `systemd-ask-password-wall.path` |

Boot ends at `default.target`, normally a symlink to `multi-user.target` (server) or
`graphical.target` (desktop). `isolate` is how you switch targets at runtime:
`systemctl isolate rescue.target` stops everything not required by that target. Old runlevels map
onto this — `multi-user.target` is runlevel 3, `graphical.target` is 5.

## Ordering is not requirement

This distinction causes the most confusion in interviews and in practice. `Wants=` and `Requires=`
say *whether* a unit is pulled in; `After=` and `Before=` say *when* it starts. A unit with
`After=postgresql.service` and no `Wants=` starts after Postgres **if Postgres happens to be
starting anyway**; if nothing else pulls Postgres in, the ordering is vacuous and the service fails
with "connection refused".

```ini
# /etc/systemd/system/api.service.d/override.conf  (systemctl edit api)
[Unit]
Wants=postgresql.service
After=network-online.target postgresql.service
RequiresMountsFor=/srv/api

[Service]
User=api
EnvironmentFile=/etc/api/env
ExecStart=/opt/api/bin/api --config /etc/api/config.yaml
Restart=on-failure
RestartSec=2s
TimeoutStopSec=30s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

`systemctl edit` creates a drop-in under `/etc/systemd/system/<unit>.d/` — the right way to change a
vendor unit, because a package upgrade overwrites `/usr/lib/systemd/system/`. `daemon-reload` is
required after any unit change; forgetting it is why "I edited the file and nothing happened".

`enable` and `start` are separate. `enable` writes the symlink that makes a unit start at boot;
`start` starts it now. `systemctl enable --now` does both. `restart` sends `SIGTERM`, waits
`TimeoutStopSec`, then `SIGKILL`s the cgroup; `reload` sends `SIGHUP` and only works if the unit
declares `ExecReload=`. Check state with `systemctl is-active`, `is-enabled` and `is-failed`, and read
the last words of a dead service with `systemctl status api` or
`journalctl -u api -b -1 --no-pager`.

## Timers replace cron in one specific way

A `.timer` unit with a matching `.service` of the same name runs that service, and unlike cron it
gives you `Persistent=true` (run a missed job after downtime), randomised delay, dependency
ordering, and journal logging with unit attribution:

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Nightly database dump

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=15m
Persistent=true
Unit=backup.service

[Install]
WantedBy=timers.target
```

`systemctl list-timers --all` shows the next and last run. The catch is that a timer never runs if
its service is already active, and `OnCalendar` uses system local time — a host in UTC with a team in
IST needs the offset made explicit.

## Boot failure triage

Work from the outside in, and do not reboot a second time before reading the first failure.

1. Does the firmware see the disk? Boot to the UEFI menu or a rescue ISO and check `lsblk`,
   `efibootmgr -v`.
2. Does the kernel find root? A panic ending in `VFS: Unable to mount root fs` is initramfs or
   `root=`, not a userspace problem.
3. Does systemd reach `multi-user.target`? `systemctl --failed`, then `journalctl -b -p err`.
4. Is it a mount? A bad `/etc/fstab` line drops you into `emergency.target` with a read-only `/`.
   Fix the line or add `nofail`, then `systemctl default`.
5. Is it a service? Boot into `rescue.target`, mask the offender (`systemctl mask api`), fix, unmask.

## Common mistakes

- Editing `/etc/fstab` and rebooting to test it. Run `mount -a` and `systemctl daemon-reload` first;
  a typo there needs console access to fix.
- `Requires=` without `After=`: the dependency is pulled in and started in parallel, which is worse
  than no ordering at all.
- Hand-editing files in `/usr/lib/systemd/system/`; they vanish at the next package upgrade.
- `Requires=network.target` expecting the network to be up. It means "the network stack is
  configured", not "an address is routable" — use `network-online.target` plus
  `Wants=network-online.target`.
- Rebuilding the initramfs on a full `/boot`, then rebooting anyway.

## Production notes

Keep a serial console enabled and tested (`console=ttyS0,115200` plus a GRUB `serial` stanza) on
every physical and cloud host; it is the difference between a rescue and a rebuild. Preserve one
known-good kernel and make the bootloader show the menu (`GRUB_TIMEOUT=5`,
`GRUB_DISABLE_RECOVERY=false`) so you can select it. On fleets, `systemctl list-units --failed` and
`systemd-analyze blame` belong in the daily check, and `systemd-analyze critical-chain` answers "why
did this host take four minutes to boot" better than reading syslog by hand.
