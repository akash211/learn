# Users, Groups, Permissions, sudo and PAM

Access control on Linux is a stack, not a switch: the kernel checks UID/GID and mode bits, then
extended ACLs, then capabilities; PAM decides who may authenticate; sudo decides who may become whom.
Almost every real privilege problem lives in one specific layer, and knowing which one saves hours.

## Identity: the four files

| File | Holds | Readable by |
|---|---|---|
| `/etc/passwd` | `name:x:uid:gid:gecos:home:shell` | Everyone |
| `/etc/shadow` | Password hash, ageing fields | root (mode 0640, `shadow` group) |
| `/etc/group` | `name:x:gid:members` | Everyone |
| `/etc/gshadow` | Group admins and passwords | root |

The `x` in `/etc/passwd` is where the hash used to be; it is now a pointer to `shadow`. Modern
distros use yescrypt (`$y$`) or SHA-512 (`$6$`); a `!` or `*` in the hash field means the account
cannot authenticate with a password, which is the correct state for service accounts.

UID conventions matter when you script: 0 is root, 1–999 are system accounts on Debian (1–200 on
RHEL), and `useradd` starts human accounts at 1000 (or `UID_MIN` in `/etc/login.defs`). A second
root-equivalent UID 0 account is a backdoor, not a workaround — audit with
`awk -F: '$3==0 {print $1}' /etc/passwd`.

```bash
useradd -m -s /bin/bash -G sudo deploy       # -m creates home from /etc/skel
usermod -aG docker deploy                    # -a is essential: without it, groups are replaced
id deploy                                    # effective groups, including the primary
chage -l deploy                              # password expiry and last-change dates
passwd -l svc-payments                       # lock a service account
```

`usermod -G` without `-a` silently removes every other supplementary group — a genuinely common
self-inflicted outage. Group membership also only applies to *new* sessions; the user must log out
and back in (`newgrp` for a shell).

## Mode bits, and the three special ones

Permissions are read(4)/write(2)/execute(1) for user, group, other. On a directory, `x` means
"traverse" and `r` means "list names", which is why `chmod 644` on a directory produces the
infuriating "cannot cd" with files that look readable.

| Bit | Octal | On a file | On a directory |
|---|---|---|---|
| setuid | 4000 | Runs as the file's owner (`/usr/bin/passwd`) | Ignored on Linux |
| setgid | 2000 | Runs with the file's group | New files inherit the directory's group |
| sticky | 1000 | No effect | Only the owner may delete entries (`/tmp`) |

setgid on a shared directory is the standard fix for "the team cannot edit each other's files":
`chgrp -R devs /srv/app && chmod 2775 /srv/app` gives group ownership on new files. The umask then
decides what a *new* file gets: `umask 022` yields 644/755, `umask 027` yields 640/750 and is the
right default for anything multi-tenant. Set it system-wide in `/etc/profile.d/` (or `UMASK` in
`/etc/login.defs`), not only in a shell rc file.

`setuid` on shell scripts is ignored by the kernel for good reason, and setuid binaries are a
liability: prefer file capabilities.

```bash
setcap cap_net_bind_service=+ep /opt/app/bin/api   # bind :443 without root
getcap -r / 2>/dev/null | head                      # what has capabilities today
```

## ACLs when the mode bits run out

ACLs add per-user and per-group entries without changing the owner or group:

```bash
setfacl -m u:analyst:rx /srv/reports
setfacl -R -m u:deploy:rwX /srv/app
setfacl -d -m u:deploy:rwX /srv/app     # default ACL: inherited by new files
getfacl /srv/reports
```

A `+` in `ls -l` output means an ACL exists. Because ACLs are easy to forget, they are also a common
audit finding: `getfacl -R /srv` should be greppable in your config management. The mask entry caps
effective ACL permissions, which is why setting an ACL sometimes appears to do nothing.

## sudo: delegation, not sharing

`sudo` is a setuid binary that consults `/etc/sudoers` and `/etc/sudoers.d/*`, checks the invoking
user against the rules, re-authenticates (by default), and executes the command as the target user,
logging to syslog/journald.

```
# /etc/sudoers.d/20-deploy  — validate with `visudo -cf` before installing
Defaults:deploy  timestamp_timeout=15, !requiretty, secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
deploy ALL=(root) NOPASSWD: /bin/systemctl restart api.service
%ops   ALL=(ALL) ALL
%ops   ALL=(root) NOPASSWD: /usr/bin/journalctl -u api *, /usr/bin/systemctl status api
```

Rules that keep this safe:

- `visudo -c` validates syntax; a broken sudoers file locks everyone out of `sudo`.
- Scope commands precisely. A wildcard like `/usr/bin/systemctl *` is root: it can `systemctl link`
  an attacker-written unit. `journalctl` with a wildcard can read any log.
- Prefer a wrapper script with a fixed argument set over a broad binary, and make it
  `root:root 0755`, not group-writable.
- `NOEXEC` and `SETENV` rarely behave as expected; `secure_path` and a clean environment matter more.
- Every `NOPASSWD` rule is a privilege escalation primitive for anyone who finds a shell as that
  user. Use it for one narrow action, not for "convenience".

`sudo -l` shows what *you* may run, `sudo -u postgres psql` runs as another user, and
`/var/log/auth.log` (or `journalctl -u sudo`) records every invocation with the full command line.
Distro default groups differ: Debian's `sudo` group and RHEL's `wheel` are the conventional admin
groups; check with `%sudo`/`%wheel` in `/etc/sudoers`.

## PAM: the authentication pipeline

PAM is a set of shared libraries called in a defined order by each service that accepts a login.
`/etc/pam.d/sshd`, `/etc/pam.d/sudo`, `/etc/pam.d/login` each name a stack; modules are grouped into
four types:

| Type | Question | Example module |
|---|---|---|
| `auth` | Who are you, and are the credentials valid? | `pam_unix`, `pam_google_authenticator` |
| `account` | Is the account allowed now (expired, locked, time-of-day)? | `pam_faillock`, `pam_access` |
| `session` | What must be set up or torn down? | `pam_systemd`, `pam_mkhomedir`, `pam_limits` |
| `password` | How are password changes handled? | `pam_unix`, `pam_pwquality` |

Control flags decide how failures combine: `required` fails the stack but keeps evaluating (so the
user cannot tell which factor failed), `requisite` fails immediately, `sufficient` passes the stack
if it succeeds, `optional` is advisory. The canonical hardening pattern is
`auth required pam_faillock.so preauth` before `pam_unix` and `auth [default=die] pam_faillock.so
authfail` after it, which locks an account after N failures — the mechanism behind
`faillock --user alice --reset`.

`/etc/nsswitch.conf` is the companion piece: it decides where identity is looked up, e.g.
`passwd: files sss` means "local files first, then SSSD/LDAP". If `getent passwd alice` works and
`id alice` does not, or SSH rejects a user who exists in LDAP, the ordering here is the suspect.

## Common mistakes

- `chmod -R 777` to make something work. It also makes every secret readable and every script
  writable by any user on the host.
- `usermod -G` without `-a`, dropping the user's other groups.
- Adding a user to a group and testing in the same SSH session; the session's group set is fixed at
  login.
- `chown -R user:user /` with a trailing space or wrong path, which is unrecoverable without a
  snapshot.
- Editing `/etc/sudoers` with a normal editor instead of `visudo`, then losing sudo entirely.
- Assuming `sudo` proves identity for auditing: shared accounts with one sudo rule mean the log names
  a human who may not have been there.

## Production notes

One human, one account, no shared logins; root login only through sudo, with the invoking user
recorded. Keep service accounts shell-less (`/usr/sbin/nologin`) and password-locked. Centralise
identity (SSSD/LDAP or an IdP) once there is more than a handful of hosts, because local
`/etc/passwd` edits do not scale and leave orphaned accounts behind. Treat `/etc/sudoers.d`,
`/etc/pam.d`, and group membership as reviewed configuration: in version control, deployed by
Ansible, and diffed in CI. Audit quarterly with `awk -F: '$3>=1000' /etc/passwd`, `getent group
sudo`, and a `getfacl -R` sweep over data directories.
