# Variables, Facts, Precedence and Templating

Variables make playbooks reusable across hosts and environments. They also create a subtle debugging problem: the same name can be defined in several places, and Ansible has a precedence order that determines the effective value. Reliable automation uses deliberate naming and narrow scopes rather than relying on accidental overrides.

## Where values come from

Variables can be defined in inventory, `group_vars/`, `host_vars/`, play-level `vars`, `vars_files`, role defaults, role vars, task vars, registered results, facts, and command-line options such as `-e`. `ansible-inventory --host web01` helps inspect inventory-provided values; `ansible-inventory --graph` shows group structure. To see the resolved values during a run, use `ansible.builtin.debug` carefully and avoid printing secrets.

Ansible's precedence rules are extensive. As a dependable headline, extra variables supplied with `-e` have very high precedence; role defaults are intentionally easy to override; role vars are harder to override; and variables from more specific host contexts can override broader inventory settings. There are nuances depending on the variable source and context, so consult the precedence documentation when behavior matters. Do not memorize a one-line ranking and assume it covers every source, especially connection variables, command-line options and registered data.

Use role defaults for supported customization points, such as an application port. Use inventory variables to express environment or host differences. Keep internal role implementation values private in naming and scope where practical. Avoid defining the same variable in several layers unless the override is intentional and tested. A clear `app_listen_port` is more maintainable than `port`, which could refer to SSH, a database or a web listener.

```yaml
# roles/web/defaults/main.yml
web_listen_port: 8080
web_worker_count: 4
```

Defaults let a consuming play override the role without editing the role. Avoid overusing extra vars as a normal configuration system: `-e` can unexpectedly override values and makes the actual run dependent on invocation details. For reproducibility, record those inputs alongside the change request or pipeline parameters.

## Facts describe the observed host

Facts are gathered observations, typically through `ansible.builtin.setup`, and are available under `ansible_facts`, with many commonly used facts also accessible through compatibility variables. They include operating-system distribution, interfaces, addresses, memory and device information. Facts are inputs about what the host is, not declarations of what it should become. For example, `ansible_facts['distribution']` can guide a platform-specific package choice, while a desired package version belongs in configuration variables.

```yaml
- name: Show the distribution family
  ansible.builtin.debug:
    msg: "Configuring {{ ansible_facts['os_family'] }}"
```

Fact gathering costs time and may fail on very minimal systems if remote Python is unavailable. Set `gather_facts: false` when you truly do not need facts, or use `ansible.builtin.raw` for bootstrap actions before Python exists. Fact caching can reduce repeated discovery across runs, but cached data can be stale and should not be mistaken for live host state. If a task changes a fact-relevant property, an explicit fact refresh may be appropriate.

## Jinja expressions and YAML types

Ansible uses Jinja expressions in values and templates. `{{ variable }}` interpolates a value, while conditionals and filters can transform it. YAML itself has types, and quoting matters: a value that looks like `yes`, a number, or a boolean may be parsed differently than intended. Quote strings that should remain strings, especially file modes (`'0644'`), versions and values containing punctuation. Modules often expect booleans as YAML booleans (`true`), not the string `"true"`.

```yaml
- name: Render a service port from configuration
  ansible.builtin.template:
    src: service.conf.j2
    dest: /etc/service/service.conf
    mode: '0640'
  vars:
    listen_address: "{{ ansible_facts['default_ipv4']['address'] }}"
```

Filters such as `default`, `mandatory`, `dict2items`, `selectattr`, `to_json` and `to_yaml` can make expressions concise. A default filter can hide a missing required input, so use it for genuinely optional values. Use `mandatory` or assertions to fail early for required configuration. Avoid complex nested Jinja in a task when a prior normalization step, clear variable or template is easier to review. Test expressions on supported Ansible versions; templating behavior and unsafe-value handling have evolved.

The `lookup` and `query` functions retrieve data on the controller, for example an environment variable or file. These are not remote reads unless a remote module is used. `lookup('env', 'DEPLOY_ENV')` reads the controller process environment, not the target's environment. This distinction is important for credentials and configuration. Avoid accidentally exposing values in a debug task or in a rendered file with overly broad permissions.

## Variable files and data structure

Organize data by ownership and stability. Group-level settings such as a timezone can live in `group_vars/all.yml`; role-specific values belong in role defaults or vars. Keep structured data as mappings and lists rather than encoding multiple fields in a single string that tasks must parse later. For environment-specific configuration, make differences explicit and avoid copying every shared value into each environment file, which creates drift.

`vars_files` loads a file during a play. `include_vars` loads variables dynamically and can select files by condition or directory, but dynamic loading makes the effective configuration less obvious. Use it where runtime selection is genuinely required; otherwise conventional `group_vars` and `host_vars` are easier to inspect. Validate required variables with `ansible.builtin.assert`, especially at role entry points, so a missing setting fails before partial changes.

Templating also has security implications beyond secret values. If a variable contains user-controlled text and is inserted into a shell command or a config language, quoting for YAML does not necessarily make it safe for that destination. Prefer module arguments with structured data, and validate values against allowed forms before rendering. Jinja filters should be selected for the target syntax, not merely because they make a string look quoted. When a template renders a list or mapping, define ordering where deterministic output matters; unstable order can create noisy diffs and unnecessary service reloads. Use small representative fixtures, including empty lists and unusual but valid names, to test rendered output. Keep a clear distinction between data observed from facts and trusted configuration values supplied by operators.

## Common mistakes

- Setting the same variable in inventory, a play, and `-e`, then diagnosing the wrong value.
- Assuming facts are desired state or are refreshed automatically after every change.
- Treating a controller-side lookup as a query of the remote host.
- Writing unquoted modes such as `0644`, which are vulnerable to YAML type interpretation.
- Using `default` for required configuration and silently deploying with an unintended fallback.
- Printing credentials through debug output or rendering them into world-readable files.

## Production notes

A useful troubleshooting method is to trace one variable from definition to consumption. Identify the file that is expected to provide it, whether that file is loaded for the selected group, any host-specific override, and any command-line extra variables supplied by the job. Then inspect how the template or module uses the value, including filters that coerce types or choose fallbacks. This beats adding a second definition at a different level and hoping it wins. For nested dictionaries, decide whether a child group should replace or merge parent data; Ansible's merge behavior depends on configuration and source. Make merge policy explicit and test it. Give secrets separate names and protected sources so they are not confused with ordinary settings. Required values should fail near role entry, before the first state-changing task.

Give variables names that encode their domain, establish a small supported interface for each role, and document required versus optional inputs. Test representative combinations of inventory, host facts and overrides. During diagnosis, inspect the resolved value from the same inventory, user and extra-variable context as the failing run. Keep secrets in protected variable sources, and treat rendered output permissions as part of the secret boundary.