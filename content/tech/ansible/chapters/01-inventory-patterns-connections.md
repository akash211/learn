# Inventory, Host Patterns and Connection Options

Inventory answers a deceptively important question: which machines can this run affect? It is both a source of host names and a model of group membership, connection data and environment boundaries. A good inventory makes the target set understandable before a command is launched. A bad one turns an ordinary playbook into a fleet-wide incident.

## Static inventory and groups

An inventory can be an INI file, YAML, or a dynamic source supplied by an inventory plugin. A small static INI inventory is easy to read:

```ini
[web]
web01.example.net ansible_user=deploy
web02.example.net ansible_user=deploy

[web:vars]
http_port=8080

[production:children]
web
api
```

The YAML equivalent expresses group structure explicitly:

```yaml
all:
  children:
    production:
      children:
        web:
          hosts:
            web01.example.net:
              ansible_user: deploy
            web02.example.net:
              ansible_user: deploy
        api:
          hosts:
            api01.example.net:
              ansible_user: deploy
```

Groups let plays target roles in the estate rather than hard-coded host lists. A host can belong to multiple groups, for example `production` and `web`, so shared and role-specific settings can be separated. Store environment boundaries in separate inventory directories or files when that improves review, and keep production credentials out of ordinary inventory. Inventory is configuration, not a secret store.

Use `ansible-inventory -i inventory/production.yml --graph` to inspect relationships and `--list` to inspect parsed variables. This catches a surprising amount of YAML indentation and naming confusion before a play runs. With multiple sources, provide them intentionally: `-i inventory/production -i inventory/cloud.yml`. Ansible merges the sources; understand the resulting host and group variables rather than assuming the last file simply replaces everything.

## Patterns are executable scope

The `hosts:` value in a play and the `--limit` option accept host patterns. `all`, a group such as `web`, an individual host, intersections with `&`, and exclusions with `!` can combine. For example, `production:&web:!canary` selects production web hosts except the canary group. Patterns are a powerful selector, not shell wildcards pasted into YAML. Quote patterns containing punctuation to avoid YAML interpretation, and use `--list-hosts` with the same inventory and limit before execution.

A safe operator habit is to inspect selection in layers:

```bash
ansible-playbook -i inventory/prod.yml site.yml --list-hosts --limit 'web:&canary'
ansible-playbook -i inventory/prod.yml site.yml --syntax-check
```

`--list-hosts` reports target hosts without running tasks. `--limit` restricts an otherwise matching play; it does not add hosts absent from the play's pattern. A misspelled group may produce no useful work, so treat an empty target set as a failed precondition in deployment automation. Dynamic inventory adds another reason to verify: cloud tags, API filters and cached results can change the actual membership over time.

## Connection variables and SSH

For ordinary Unix hosts, the default connection plugin is SSH. Common host variables include `ansible_host` for the address to connect to, `ansible_user` for the remote account, `ansible_port`, `ansible_ssh_private_key_file`, and `ansible_become` settings. These names are real Ansible variables; connection and privilege escalation settings should be documented where maintainers can find them, but private key material should not be committed.

```yaml
ansible_host: 192.0.2.20
ansible_user: automation
ansible_port: 22
ansible_become: true
ansible_become_method: sudo
```

The SSH connection plugin uses OpenSSH behavior and supports options through Ansible variables and configuration. Check host-key verification policy rather than disabling it as a generic workaround. In automation, manage known host keys or use a controlled host-key strategy; accepting any host silently weakens protection against connecting to an impostor. Persistent control connections can reduce repeated SSH setup cost, but they do not change authorization or host identity checks.

Privilege escalation is separate from the login identity. `become: true` asks Ansible to elevate for selected tasks, commonly using sudo. Prefer a dedicated automation account with narrowly scoped sudo policy over logging in as root. `--ask-become-pass` prompts for a sudo password where needed; it is not a substitute for storing and rotating credentials safely. Limit `become` to the play, block or task that requires it instead of elevating all work by habit.

## Beyond SSH

Ansible is not restricted to SSH. Windows management commonly uses the `ansible.builtin.winrm` connection plugin or PSRP in supported environments, and requires correctly configured transport, authentication and target prerequisites. Network devices often use network connection plugins such as `ansible.netcommon.network_cli` or HTTP API transports; the exact platform modules and collections matter. Local tasks can use `ansible_connection: local`, while `ansible.builtin.delegate_to` runs a task from a different host context. These are different execution models, so do not assume Linux shell commands work for Windows or network devices.

Dynamic inventories come from plugins that query cloud providers, CMDBs or other sources. Install the relevant collection and configure the plugin according to its documentation. Keep credentials in the controller's credential mechanism or environment, filter results deliberately, and test `ansible-inventory --graph` at the same revision and identity used by the playbook. A dynamic inventory source is live input; snapshots or carefully scoped filters can make change reviews safer.

Inventory can also carry environment-specific connection and role variables, but avoid mixing host identity with application policy. A hostname or cloud tag should determine membership; service-specific tuning belongs in clearly named group variables. Use `ansible-inventory --host <alias>` to inspect a single resolved host, and remember that its output may include sensitive values if you have placed them there. Treat inventory review as code review: check changes to child groups, group names and patterns for unintended inheritance. If an inventory plugin supports keyed groups or constructed groups, document the expressions used to create them and include a test that exercises representative API results. This makes a refactor of cloud tags or naming conventions less likely to silently change deployment scope. Where the inventory is generated, keep a narrow path to reproduce a selection locally without requiring production write credentials.

## Common mistakes

- Running against `all` in production without listing the selected hosts first.
- Treating `--limit` as a confirmation prompt; it is only another selector.
- Putting connection passwords or private keys in inventory committed to source control.
- Disabling SSH host-key checking to make a transient error disappear.
- Confusing `ansible_host` (address) with the inventory alias used in reports and patterns.
- Assuming `become` changes the SSH login account. It changes task privilege after login.

## Production notes

Inventory source precedence deserves a deliberate operational convention. If the same host or group appears in multiple sources, merged variables can be difficult to reason about, particularly when several environments reuse group names. Prefer explicit, environment-specific inventory roots and review the final merged output as the CI identity sees it. Avoid changing a production inventory by hand during an incident without capturing the change in version control afterward. Dynamic source caches should have a known refresh policy, and automation that uses cached results should record when they were collected. If a cloud API is unavailable, decide whether the job should fail closed rather than silently use stale membership. Use tags and group names to express durable ownership, not transient assumptions such as current IP address order. For a high-risk operation, keep the candidate list in the change record so the approval is about a concrete set of hosts, not merely a playbook name.

Keep inventories auditable and environment boundaries explicit. For a deployment, the pipeline should record the inventory revision, selected groups, limit, collection versions and commit being applied. Use a small canary group, then expand through a controlled batch. When dynamic sources are used, review the plugin filters and verify actual resolved membership immediately before making changes. Inventory is part of the safety boundary: the clearest playbook cannot compensate for an incorrectly broad target set.