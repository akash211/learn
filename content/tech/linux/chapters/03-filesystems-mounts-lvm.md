# Filesystems, Mounts, Disks and LVM

Disk problems are the most common cause of a server that is "up but broken". A full `/` stops
journald, blocks logins, and breaks package upgrades; a missing `nofail` on a data mount stops the
boot entirely. This chapter covers the layout you inherit, how mounts actually work, and how to grow
storage without downtime.

## The layout you will be asked about

The Filesystem Hierarchy Standard is not decoration — tools and policies depend on it.

| Path | Contents | Notes |
|---|---|---|
| `/etc` | Host-specific configuration | Never a mount point for bulk data |
| `/var` | Variable data: logs, spool, lib, caches | Split onto its own LV so logs cannot fill `/` |
| `/usr` | Read-only userland: binaries, libraries, share | Often read-only on immutable distros |
| `/run` | tmpfs, runtime state since boot | PIDs, sockets, locks; wiped on reboot |
| `/tmp` | Temporary files | `systemd-tmpfiles` cleans it; consider `noexec,nosuid` |
| `/srv` | Data served by this host | Convention, not enforcement |
| `/opt` | Third-party applications | Self-contained trees |
| `/proc`, `/sys` | Kernel and device interfaces | Virtual; `cat /proc/meminfo` needs no disk |
| `/dev` | Device nodes, managed by udev | `/dev/disk/by-uuid` symlinks live here |

Logs under `/var/log` and containers under `/var/lib/docker` are the two things that fill a root
filesystem. If `/var` is not separate, at least put `/var/log` and `/var/lib/docker` on their own
mounts.

## Finding what is using the space

```bash
df -hT                                  # per-filesystem: size, used, avail, type
df -i                                   # inode exhaustion looks identical to "disk full"
du -xhd1 /var | sort -h                 # -x stays on one filesystem
find /var -xdev -type f -size +500M -printf '%s\t%p\n' | sort -n
lsof +L1                                # deleted files still held open
```

The last command is the one people forget. A process that has an open handle on a deleted 20 GB log
file keeps the blocks allocated; `df` says full, `du` says empty. Restart or `truncate -s 0` the
holder (truncating through `/proc/<pid>/fd/<n>` works without a restart).

`du` and `df` disagreeing by gigabytes usually means reserved blocks: ext4 reserves 5% for root by
default, which on a 2 TB volume is 100 GB invisible to non-root writers. `tune2fs -m 1 /dev/vg/data`
reclaims most of it for data volumes where root does not need the headroom.

## Mounts: what `/etc/fstab` really does

A mount attaches a filesystem at a directory in the current namespace. `/etc/fstab` is the list
systemd turns into `.mount` units at boot (`/etc/fstab` entries and `systemd-fstab-generator` are the
same mechanism; `systemctl list-units --type=mount` shows the result).

```
# <device>              <mountpoint>  <type> <options>                       <dump> <pass>
UUID=6f2a-4c1b          /             ext4   defaults,noatime                0      1
UUID=0b9e3f0a-...       /var          xfs    defaults,noatime                0      2
/dev/vg_data/lv_app     /srv/app      ext4   defaults,nofail,x-systemd.device-timeout=10s 0 2
server:/export          /mnt/nfs      nfs4   rw,hard,timeo=600,retrans=2,_netdev,nofail 0 0
```

Points that decide whether a boot succeeds:

- **Use UUID or LVM paths, never `/dev/sdb`.** Device names are not stable across reboots, kernel
  updates, or added volumes.
- **`pass` (fsck order)** should be 1 for `/`, 2 for others, 0 for XFS, btrfs, and network mounts —
  `fsck.xfs` is a no-op stub, and XFS recovers via the log.
- **`nofail`** lets the boot continue when the device is absent. Without it, a detached cloud volume
  lands you in `emergency.target`.
- **`_netdev`** (or `x-systemd.requires=network-online.target`) stops systemd trying to mount NFS
  before the network exists.
- **`x-systemd.automount`** mounts on first access, which speeds boot and survives a share that is
  down at boot.

Test before rebooting: `mount -a` mounts everything not yet mounted and prints errors, and
`systemctl daemon-reload` regenerates the units. `findmnt --verify --verbose` checks fstab syntax and
warns about missing options; both are safe on a production host.

Options worth knowing: `noatime` (stop writing on every read — a real win on write-heavy hosts),
`nosuid,nodev,noexec` on `/tmp` and user-writable mounts, `ro` for anything that should never change,
and `discard` vs periodic `fstrim.timer` for SSDs (the timer is usually preferable, because `discard`
adds latency to every delete).

## Filesystem choice

| | ext4 | XFS | btrfs | ZFS |
|---|---|---|---|---|
| Grow online | Yes (`resize2fs`) | Yes (`xfs_growfs`) | Yes | Yes |
| Shrink | Yes (offline) | No | Yes | No |
| Snapshots | No (LVM instead) | No (LVM instead) | Yes, cheap | Yes |
| Best at | General purpose, small files | Large files, parallel I/O | Snapshots, checksums | Integrity, send/receive |
| Default on | Debian/Ubuntu | RHEL family | openSUSE, Fedora | Proxmox, TrueNAS |

RHEL-family hosts use XFS and cannot shrink it — size LVs conservatively and grow later, which is the
normal direction anyway. btrfs snapshots are not backups; they live on the same device.

## LVM in practice

LVM inserts a mapping layer: physical volumes (PVs) → volume group (VG) → logical volumes (LVs). The
value is that a filesystem is no longer tied to a disk, so you can extend across new hardware
without downtime.

```bash
pvs; vgs; lvs                       # what exists and how much is free
pvcreate /dev/nvme1n1               # add a disk to the pool
vgextend vg_data /dev/nvme1n1
lvextend -L +50G /dev/vg_data/lv_app
resize2fs /dev/vg_data/lv_app       # ext4; use xfs_growfs /srv/app for XFS
# or one step, which picks the right resize tool:
lvextend -r -l +100%FREE /dev/vg_data/lv_app
```

`-r` is the flag worth remembering: without it the LV grows and the filesystem does not, and `df`
still shows the old size. The reverse order is also a classic error — running `resize2fs` first fails
because the block device has not grown yet.

Thin provisioning (`lvcreate --thin`) over-allocates, so a full thin pool takes every filesystem on
it down; monitor `data_percent` in `lvs` and set `--errorwhenfull y`. LVM snapshots are
copy-on-write, sized as a delta: a 20 GB snapshot of a volume taking 60 GB of writes fills and
becomes invalid. They are excellent for "snapshot before a risky upgrade, roll back in ten minutes",
and unsuitable as a backup strategy — the snapshot dies with the disk.

Swap belongs here too: `swapon --show`, `free -h`, and on modern hosts a small swap file
(`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap && swapon`) is usually better than a
partition, because it can be resized. Swap is not a substitute for memory; it lets the kernel evict
cold anonymous pages instead of invoking the OOM killer.

## Common mistakes

- `fstab` edited without `mount -a`: the next reboot fails, and fixing it needs console access.
- Using `/dev/sdX` in fstab, then wondering why the data volume moved after a reboot.
- Deleting a big file but not restarting the process holding it open, so `df` stays at 100%.
- `lvextend` without `resize2fs`/`xfs_growfs`, or `resize2fs` before `lvextend`.
- Forgetting `df -i`: a filesystem with millions of tiny files reports free space and still cannot
  create a file.
- Treating an LVM or btrfs snapshot as a backup — both share the underlying device.

## Production notes

Give `/var`, `/var/log`, `/var/lib/docker` and application data their own LVs, with `nofail` on
anything that is not required to boot. Alert on `df` at 80% for `/` and 90% for data, and on inode
usage separately. Keep 10–20% of each VG unallocated so an emergency `lvextend` is possible without
adding a disk. Schedule `fstrim.timer` on SSD-backed hosts, and verify that `fstab` changes are
covered by your configuration management — a hand-edited fstab is invisible until the host reboots
during an unrelated maintenance window.
