# Security Posture and the Routine Ops Runbook

A hardened server is not a checklist that was completed once. It is a small set of properties that
stay true because something checks them. This chapter covers the baseline, the sysctls and kernel
features that back it, and the recurring checks that catch drift before an auditor or an attacker
does.

## The baseline, in priority order

| Layer | Control | Verify with |
|---|---|---|
| Access | No password SSH, no root login, allow-listed groups | `sshd -T` |
| Access | One account per human, sudo for privilege | `getent group sudo`, `journalctl -u sudo` |
| Network | Default-deny inbound, only intended ports | `nft list ruleset`, external scan |
| Patching | Security updates applied and rebooted | `apt list --upgradable`, `dnf needs-restarting -r` |
| Services | Nothing listening that is not needed | `ss -tulpen` diffed against an allow-list |
| Integrity | Package files unmodified, configs in version control | `dpkg -V`, `rpm -Va`, git status |
| Confinement | SELinux/AppArmor enforcing, not permissive | `getenforce`, `aa-status` |
| Audit | Auth events and privilege escalation retained | `journalctl -u ssh -u sudo --since -7d` |

The order matters. Closing SSH and the firewall removes most opportunistic attacks; patching removes
most of the rest. Detection on a host with password auth enabled and a two-year-old kernel is theatre.

## Minimal services are the cheapest hardening

Every listening socket is attack surface, and every installed package is a CVE you will have to
triage. The audit is two commands:

```bash
ss -tulpen                                  # what is listening, and as whom
systemctl list-unit-files --state=enabled   # what starts at boot
```

Bind services to `127.0.0.1` when only a local reverse proxy needs them — that removes them from the
network surface without a firewall rule. Disable what you do not use, and remove packages rather than
masking units: an uninstalled service cannot be re-enabled by a dependency.

## Kernel and sysctl baseline

```
# /etc/sysctl.d/60-hardening.conf
net.ipv4.conf.all.rp_filter = 1              # drop spoofed source addresses
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.tcp_syncookies = 1                  # survive SYN floods
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv6.conf.all.accept_ra = 0              # only if you do not use SLAAC
kernel.kptr_restrict = 2                     # hide kernel pointers from unprivileged readers
kernel.dmesg_restrict = 1                    # dmesg needs root
kernel.unprivileged_bpf_disabled = 1         # closes a large local attack surface
kernel.yama.ptrace_scope = 1                 # only descendants may ptrace
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.suid_dumpable = 0                         # no core dumps from setuid programs
```

Apply with `sysctl --system` and confirm with `sysctl -a | grep <key>` — a typo in a sysctl file is
silently ignored, which is why the verification step matters.

## Mount options and filesystem hardening

```
tmpfs     /tmp     tmpfs  defaults,noexec,nosuid,nodev,size=2G  0 0
tmpfs     /dev/shm tmpfs  defaults,noexec,nosuid,nodev,size=512M 0 0
```

`noexec` stops the "download and run" pattern, `nosuid` stops a dropped setuid binary, `nodev` stops
device-node tricks. Test before rolling out: some installers and Java/Chromium sandboxes execute from
`/tmp` and will break.

## Secrets on the host

Configuration files with passwords are the normal case, and the normal failure is `0644` in a home
directory. Better options, in order:

1. **systemd credentials**: `LoadCredential=dbpass:/etc/app/dbpass` puts the secret in a
   per-service, in-memory file readable only by the service, exposed as `$CREDENTIALS_DIRECTORY`.
   `LoadCredentialEncrypted=` takes it from `systemd-creds encrypt`, bound to the host's TPM.
2. **A secret manager** (Vault, AWS Secrets Manager) fetched at start, cached in tmpfs, never written
   to disk.
3. **A root-owned env file** `0600` read via `EnvironmentFile=`, which at least keeps it out of
   `/proc/<pid>/environ` as seen by other users.

Never put secrets in `ExecStart=` arguments: `/proc/<pid>/cmdline` is world-readable. That is the
most common leak in hand-written units.

## SELinux and AppArmor: leave them on

`getenforce` returning `Permissive` means the policy is evaluated and logged but not enforced — a
common "fix" that converts a control into a log. `ausearch -m AVC -ts recent` shows denials;
`setsebool -P httpd_can_network_connect on` is the correct answer to most legitimate ones, not
`setenforce 0`. On Debian/Ubuntu, `aa-status` plays the same role. Running an application from a
non-standard path is the usual reason teams disable the policy; a small custom module
(`audit2allow -M myapp -i /var/log/audit/audit.log`) is a better outcome.

## Routine checks

The runbook is what turns posture into practice. A workable cadence for a small fleet:

| Cadence | Check | Command |
|---|---|---|
| Daily | Failed units | `systemctl --failed` |
| Daily | Errors since yesterday | `journalctl -p err --since -24h --no-pager \| tail -50` |
| Daily | Disk and inodes | `df -h; df -i` |
| Daily | Auth anomalies | `lastb \| head`, `journalctl -u sudo --since -24h` |
| Weekly | Package state | `apt list --upgradable`, `dnf check-update` |
| Weekly | Reboot required | `needs-restarting -r` (RHEL), `test -f /var/run/reboot-required` (Debian) |
| Weekly | Listening services diff | `ss -tulpen` against the recorded baseline |
| Weekly | Certificate expiry | `openssl s_client -connect host:443 -servername host </dev/null 2>/dev/null \| openssl x509 -noout -dates` |
| Monthly | Integrity | `dpkg -V`, `rpm -Va`, `aide --check` |
| Monthly | Backups restore-tested | Restore one file and one database to a scratch path |
| Monthly | Account review | `awk -F: '$3>=1000' /etc/passwd`, `getent group sudo`, `lastlog` |
| Quarterly | Patch and release upgrade plan | EOL audit, `do-release-upgrade` / `leapp` dry run |

Anything on this list that is done by hand will eventually be skipped. Move each line into cron or a
timer that writes to a status page, and treat a silent check as a failed check.

## When you suspect a compromise

Order matters more than tooling, and the first instinct — reboot — destroys most of the evidence.

1. **Preserve before you clean.** `date`, `uptime`, `who -a`, `last -50`, `ss -tulpen`, `ps auxf`,
   `nft list ruleset`, and a copy of `/var/log` and the journal
   (`journalctl -b -o short-iso --no-pager > /root/incident.log`). Snapshot the volume if the
   platform allows it.
2. **Isolate at the network layer**, not by shutting down: a nftables rule allowing only your
   management IP preserves the running state while stopping exfiltration.
3. **Identify the entry point.** `journalctl -u ssh --since -7d | grep Accepted`, `last`, recent
   `authorized_keys` changes, `dpkg -V`/`rpm -Va` for modified binaries, `crontab -l` and
   `/etc/cron.*` for persistence, `systemctl list-unit-files --state=enabled` for new units.
4. **Assume credential compromise.** Rotate every key and secret that touched the host, including
   cloud instance-role credentials — an attacker can read IMDS unless it is locked down.
5. **Rebuild rather than clean.** A cleaned host carries unknown persistence.

Have this written down before you need it, with names and a phone number.

## Change management, minimally

Configuration that is not in version control will diverge, and divergence is what makes a rebuild take
a day instead of fifteen minutes. The minimum viable practice: every host's config in a git repository
(one per role, not per host), applied by Ansible or a cloud-init template, with `--check --diff` run
before every apply. Manual changes are allowed in an incident and must be reconciled within the week —
a nightly drift check (`ansible-playbook --check`) exists to catch exactly that.

## Common mistakes

- `setenforce 0` or `apparmor_parser -R` to fix a denial, permanently.
- A firewall rule added for a test and left open; the weekly ruleset diff exists to catch this.
- Monitoring only CPU and disk, so a full `/var/log` or an expired certificate pages nobody.
- Backups that were never restored. The restore test is the only backup metric that counts.
- Treating "no alerts" as "no problem" when the agent itself died a month ago.

## Production notes

Write the baseline as code (Ansible role, cloud-init, or an image build) so it is reproducible and
reviewable, and run an automated benchmark — OpenSCAP with a CIS profile, Lynis, or the cloud
provider's security hub — monthly to catch drift. Keep the audit trail off the host (remote syslog or
a log platform) so an attacker cannot erase it with the disk. Document the break-glass path and test it
quarterly. A good posture is not the number of controls, but that every control has an owner, a check,
and a remediation step someone has actually performed.
