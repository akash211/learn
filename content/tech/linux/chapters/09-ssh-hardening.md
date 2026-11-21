# SSH Hardening and Key Management

SSH is the only door on most servers. Everything else — the firewall, sudo policy, audit logging —
assumes that door is guarded. Hardening it is a fifteen-minute exercise with a permanent payoff, and
the failure mode (locking yourself out) is entirely avoidable with a second session open.

## The client side first, because it prevents outages

```bash
ssh-keygen -t ed25519 -a 100 -C "alice@laptop-2026"     # modern default
ssh-keygen -t rsa -b 4096 -o -a 100                     # only for legacy targets
ssh-copy-id -i ~/.ssh/id_ed25519.pub alice@host
```

Ed25519 is the right default: short keys, fast verification, no parameter choices to get wrong. RSA
below 2048 bits and DSA are refused by current OpenSSH builds. Always set a passphrase on the key;
`ssh-agent` exists so you type it once per session, not never.

`~/.ssh/config` is where operational discipline lives:

```
Host prod-*
  User deploy
  IdentityFile ~/.ssh/id_ed25519_prod
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  ServerAliveInterval 30
  ServerAliveCountMax 3

Host bastion
  HostName bastion.example.net
  User jumper

Host db-1
  HostName 10.20.4.11
  ProxyJump bastion
```

`ProxyJump` replaces `ssh -L` tunnels and, importantly, replaces `ForwardAgent yes`. Agent forwarding
exposes your key to root on the jump host — anyone who compromises the bastion can use your key for as
long as your agent is loaded. `ssh -A` should be a deliberate exception, never a default.

For fleets, `~/.ssh/known_hosts` does not scale. `HostKeyAlias` plus a
`@cert-authority *.example.net ssh-ed25519 AAAA...` line in `known_hosts` turns host verification into
a CA check, so a rebuilt host does not produce a scary mismatch.

## sshd_config: the settings that matter

```ini
# /etc/ssh/sshd_config.d/10-hardening.conf  (Debian/Ubuntu includes this dir)
# /etc/ssh/sshd_config.d/10-hardening.conf  (RHEL 9+ ships Include /etc/ssh/sshd_config.d/*.conf)
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
AllowGroups ssh-users
MaxAuthTries 3
MaxSessions 4
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
UseDNS no
LogLevel VERBOSE
```

Notes on the ones people get wrong:

- `PermitRootLogin prohibit-password` allows root with a key, denies password. `no` is stricter and
  usually better; make sure a non-root sudo user works first.
- `KbdInteractiveAuthentication` is the setting that actually disables PAM-based password and 2FA
  prompts on modern OpenSSH; `ChallengeResponseAuthentication` is the deprecated name.
- `AllowGroups` is the cheap allow-list. Without it, any account with a shell and a key gets in.
- `UseDNS no` avoids a reverse lookup on every connection; the default can add seconds on hosts with
  slow or missing PTR records.
- `LogLevel VERBOSE` logs key fingerprints, which is what you need to attribute a login to a key.

Validate before restarting — `sshd -t` parses the config, `sshd -T` prints the effective result
(including defaults you did not write). Then reload, do not restart:
`systemctl reload sshd` keeps existing sessions alive; `restart` drops them, which is how people lock
themselves out mid-change.

## Key hygiene that actually holds up

`authorized_keys` supports per-key restrictions, and they are the closest thing to per-key policy:

```
from="203.0.113.0/24",command="/usr/local/bin/backup-only.sh",no-port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... backup@vendor
```

`restrict` is the modern shorthand for "disable everything optional" (PTY, forwarding, agent, X11,
user-rc). For an automation key, `restrict,command="…"` is the right shape; for a human key it is
usually too strict.

File modes are enforced, not advisory: `~/.ssh` 700, `authorized_keys` 600, home directory not
group-writable. OpenSSH silently ignores keys when the permissions are wrong, and it does not always
say why — `ssh -vvv` plus `/var/log/auth.log` is how you find out.

Rotation is the part everyone skips. Keys never expire by default, are copied between laptops, and
end up in CI variables. Manage them with:

- An inventory: which key, which person or service, which hosts, added when, expires when.
- A removal path: `authorized_keys` deployed by configuration management, never hand-edited, so
  removing a leaver is one commit.
- Short-lived SSH certificates instead of long-lived keys (below).

## Certificates beat keys at scale

An SSH certificate authority signs user and host keys. Servers trust the CA once; users get a
certificate valid for hours, with a principal (username) and critical options baked in.

```bash
# On the CA (offline or in a vault)
ssh-keygen -t ed25519 -f ca_user -C "user-ca"
ssh-keygen -s ca_user -I "alice-$(date +%Y%m%d)" -n alice,deploy \
  -V +8h -z 1042 ~/.ssh/id_ed25519.pub
# → id_ed25519-cert.pub, valid 8 hours for principals alice and deploy
```

`sshd_config` then contains `TrustedUserCAKeys /etc/ssh/ca_user.pub`, and `authorized_keys` becomes
optional. Revocation is a KRL (`ssh-keygen -k -f revoked_keys`) referenced by `RevokedKeys`, or simply
waiting for expiry — which is the real win: an 8-hour certificate cannot be forgotten for three years.
Host certificates solve the `known_hosts` problem the same way (`HostCertificate`,
`@cert-authority`).

Tools like Vault, step-ca, Teleport, or your cloud IdP issue these; the point in an interview is that
you know the model, not the vendor.

## Second factors and brute-force resistance

- **TOTP**: `pam_google_authenticator` (`auth required pam_google_authenticator.so`) with
  `AuthenticationMethods publickey,keyboard-interactive` in sshd. Two factors, ordered.
- **FIDO2**: `ssh-keygen -t ed25519-sk` produces a key bound to a hardware token; the private key
  never leaves the device. `-O resident` makes it discoverable. This is the strongest practical
  option for humans.
- **Rate limiting**: `fail2ban` watching `/var/log/auth.log` or the journal
  (`backend = systemd`, `journalmatch = _SYSTEMD_UNIT=sshd.service`), or nftables' `limit`/`recent`
  match. A default `sshd` with keys only is already resistant, but the log noise alone justifies it.
- **Port changes and `AllowUsers`** are noise reduction, not security. `MaxStartups` and
  `PerSourceMaxStartups` limit connection floods without touching the port.

Whitelist your own address before enabling any rate limit. fail2ban banning the bastion is a classic
self-inflicted outage.

## Access patterns worth standardising

| Need | Pattern |
|---|---|
| Admin access to private hosts | Bastion + `ProxyJump`, no public SSH on the hosts |
| CI/CD deploys | One key per pipeline, `restrict,command="deploy.sh"`, source IP allow-list |
| Vendor support | Time-boxed certificate, session recorded (`tlog`/`script`), account disabled after |
| Emergency access | Break-glass account with a sealed credential, alerts on use, reviewed monthly |
| File transfer | `internal-sftp` with `ChrootDirectory` (must be root-owned, not writable by the user) |

For SFTP chroot, the directive set is `Subsystem sftp internal-sftp`, then a `Match Group sftponly`
block with `ChrootDirectory /srv/sftp/%u`, `ForceCommand internal-sftp`, and
`AllowTcpForwarding no`. The chroot path and every parent must be root-owned and not group-writable,
or sshd refuses the login — the most common cause of "sftp worked yesterday".

## Auditing what happened

```bash
sshd -T | grep -E 'permitrootlogin|passwordauthentication|allowgroups'
last -Fai | head -20                  # successful logins, with source IP
lastb | head -20                      # failed logins
journalctl -u ssh --since today | grep -E 'Accepted|Failed|Invalid'
journalctl _COMM=sshd -o verbose -n 50   # key fingerprint per accepted login
```

`last` reads `/var/log/wtmp`, `lastb` reads `/var/log/btmp`; both are binary and rotate under
logrotate. If `wtmp` is empty, `systemd-logind` may be the writer instead — check
`journalctl -u systemd-logind`.

## Common mistakes

- Disabling password authentication before proving key auth works, in the only session you have.
- `chmod 644 ~/.ssh/authorized_keys` and then wondering why the key is ignored.
- Copying a private key to a server "for a script", which turns one host compromise into all of them.
- `ForwardAgent yes` globally; the agent socket is usable by root on every host you touch.
- Restarting sshd instead of reloading, dropping the session you were using to test.
- Trusting a changed host key prompt with `yes` because "it was rebuilt" — verify out of band, every
  time.

## Production notes

Deploy `sshd_config` fragments through configuration management, keep `sshd -t` in the pipeline, and
test the new config in a second session before closing the first. Centralise auth (SSO + short-lived
certificates) before the fleet is large enough that key distribution becomes the bottleneck. Log key
fingerprints and correlate them to people; an `authorized_keys` line nobody can attribute is a finding.
Rotate host keys when an image is cloned — a hundred VMs sharing one host key defeats host
verification entirely, and it is common on templates built from a running instance.
