# Package Management and Patching

Patching is the highest-leverage security control on a server and the one most often deferred until a
CVE forces it. The goal is not "apply everything immediately" — it is a repeatable cycle with a
rollback path, so that a kernel update is a routine rather than an event.

## apt, precisely

```bash
apt update                          # refresh indexes from sources.list and sources.list.d
apt list --upgradable
apt install --only-upgrade nginx    # upgrade one package, no new dependencies
apt full-upgrade                    # may remove packages to resolve conflicts
apt-cache policy nginx              # installed vs candidate, and which repo wins
apt-mark hold docker-ce             # freeze a package
apt-mark showhold
```

`apt-get upgrade` never removes a package; `apt-get dist-upgrade` (now `apt full-upgrade`) will, which
is why the difference matters on a host with tightly pinned dependencies. `apt` vs `apt-get` is
mostly output and progress formatting — scripts should use `apt-get` with `DEBIAN_FRONTEND=noninteractive`.

Two things decide *which* version you get: the sources and pinning. `/etc/apt/preferences.d/*` sets
priorities (higher wins); a third-party repo pinned at 1001 shadows the distro. That is how a host
ends up on an unrelated Nginx build and spends a week on a version-skew bug. `apt-cache policy`
prints the full decision, including "Installed: … Candidate: …" and the origin of each.

`/etc/apt/sources.list.d/` on Ubuntu 24.04+ uses the deb822 format (`.sources` files with `Types:`,
`URIs:`, `Suites:`, `Signed-By:`) instead of one-line `deb` entries. Signing keys live in
`/etc/apt/keyrings`, not the deprecated `apt-key` store.

Unattended upgrades are the standard way to keep security patches flowing:

```
// /etc/apt/apt.conf.d/50unattended-upgrades
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
```

It runs via `apt-daily.timer` and `unattended-upgrades.timer`, logs to
`/var/log/unattended-upgrades/`, and by default does **not** reboot — which means the kernel is
patched but not running. That gap is the most common audit finding on Ubuntu fleets.

## dnf, precisely

```bash
dnf check-update
dnf upgrade --refresh
dnf updateinfo list security            # which advisories apply
dnf updateinfo info --security
dnf history                             # transaction log, with IDs
dnf history undo 42                     # reverse a transaction (when packages still exist)
dnf distro-sync                         # align to the enabled repos exactly
dnf versionlock add nginx               # plugin: freeze at the current version
dnf needs-restarting -r                 # exit 1 if a reboot is required
```

`dnf` resolves and downloads before it touches the system, and `--assumeyes` is safe precisely
because of that. `dnf history undo` is a genuine advantage over apt: it can reverse a transaction
using the cached packages, provided nothing has since depended on them. `needs-restarting -r` is the
correct check after patching, and it returns non-zero when the running kernel differs from the
installed one.

RHEL hosts also have `subscription-manager` for repos and `dnf module` streams (e.g. `postgresql:16`)
— stream selection determines the major version you get, and switching streams is a migration, not a
patch.

## Querying what is actually installed

```bash
dpkg -S /usr/sbin/nginx             # which package owns this file
dpkg -L nginx-core                  # what this package installed
dpkg -V                             # verify installed files against the package manifest
debsums -c                          # checksum mismatches (needs debsums)
rpm -qf /usr/sbin/nginx
rpm -qi nginx
rpm -Va                             # verify all packages: '5' = checksum changed
```

`dpkg -V` and `rpm -Va` are the cheapest tamper and corruption check you have: they compare file
size, mode, owner, and checksum against what the package database recorded. Noise from config files
is normal (`c` flag), a modified binary is not. On a suspected compromise this is one of the first
commands that produces evidence.

## Version numbers lie about patching

This is the single most important operational fact in this chapter. Distributions **backport** fixes:
`openssl 3.0.13-1ubuntu0.4` contains dozens of CVE fixes while its upstream version string still says
3.0.13. A scanner that matches version numbers will report both false positives ("you are on 3.0.13,
CVE-2024-xxxx affects 3.0.13") and false negatives.

What to do instead:

- Read the distro's own advisory feed: `apt changelog <pkg>`, `dnf updateinfo info <advisory>`,
  Ubuntu's USN database, Red Hat's OVAL/CSAF feed.
- Ask the package manager, not the internet: `apt list --upgradable` after `apt update` is the
  authoritative "what is missing" on that host.
- Treat scanner output as a lead. A finding is real when the installed package version is below the
  fixed version *in that distribution's advisory*, not when it is below upstream's.

## The patching cycle

| Cadence | Action |
|---|---|
| Daily | Security updates applied automatically (unattended-upgrades / `dnf-automatic`) |
| Weekly | Reboot window for kernel and libc updates; verify `needs-restarting` |
| Monthly | Full upgrade including non-security, after staging on a canary host |
| Quarterly | Distribution release upgrade planning, EOL audit, kernel livepatch review |

Before any upgrade: snapshot the volume (LVM or cloud snapshot), confirm you can restore it, and note
the currently running kernel (`uname -r`) so you can select it in GRUB if the new one fails. Upgrade
the canary, run the smoke tests, then roll in batches with `serial: 1` or a percentage — never all
hosts at once, and never in the same change window as a network or database change.

Kernel updates need a reboot to take effect. Options when you cannot reboot:

- **Live patching** — `kpatch`/`kGraft` on RHEL, Canonical Livepatch on Ubuntu, `kernel-livepatch`
  tooling elsewhere. Covers a defined subset of CVEs, needs a subscription, and does not replace a
  reboot for userland or module changes.
- **kexec** — `kexec-tools` boots a new kernel without firmware/POST, cutting a two-minute reboot to
  a few seconds. Still a service interruption.
- **Accepted risk** — documented, dated, with an owner. That is a legitimate answer; silence is not.

## Repository hygiene and supply chain

Every third-party repo is root on the host at install time: its maintainer can ship a `postinst`
script. The xz-utils backdoor (CVE-2024-3094, 2024) is the canonical reminder — the malicious code
was in the *release tarball*, not the git history, and it targeted sshd through liblzma. Practical
consequences:

- Prefer distribution packages over `curl | bash`. When you must use a vendor repo, pin its signing
  key in `/etc/apt/keyrings` or `/etc/pki/rpm-gpg` and check that the repo is HTTPS with a key.
- Review `.deb`/`.rpm` maintainer scripts before rolling a package to a fleet
  (`dpkg-deb -e pkg.deb` → `DEBIAN/postinst`; `rpm -qp --scripts pkg.rpm`).
- Pin versions in production, but pin *with* a process to unpin. A held package silently accumulating
  CVEs is worse than a tested upgrade.
- Keep a local mirror or snapshot repo (aptly, Pulp, Red Hat Satellite) so a rebuild in six months
  installs the same versions.

## Common mistakes

- `apt upgrade` in a cron job with no lock handling, then a second apt process fails with "could not
  get lock /var/lib/dpkg/lock-frontend".
- Patching the kernel for months without rebooting, and believing `uname -r` after a livepatch.
- `apt-mark hold` set during an incident and never removed.
- Trusting a vulnerability scanner's version match instead of the distro advisory.
- Upgrading a database host and its client libraries in the same window, with no snapshot.
- `dnf --skip-broken` to force an upgrade through, leaving a half-consistent dependency graph.

## Production notes

Automate security updates, automate the *report* of what still needs a reboot, and make the reboot
window a calendar item rather than an emergency. Keep `/var/cache/apt/archives` or dnf's cache warm
on hosts with poor egress, and mirror repos inside the VPC so a hundred hosts do not saturate the
NAT gateway at 02:00. Record the running kernel, package manifest (`dpkg --get-selections` /
`rpm -qa`) and repo list per host in configuration management; when a rebuild is needed, that
manifest is the difference between fifteen minutes and a day. Finally, test the restore of your
snapshot before you need it — an untested snapshot is a hope, not a rollback plan.
