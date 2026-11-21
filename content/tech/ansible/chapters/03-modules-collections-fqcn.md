# Modules, Collections and Fully Qualified Names

Modules are the units of work Ansible executes on a managed host or controller. A module accepts structured arguments and returns structured data such as `changed`, `failed`, messages and facts. Built-in modules cover common operating-system operations; collections add modules and plugins for cloud APIs, network platforms, databases and other domains. Choosing the right module is often the difference between a declarative, repeatable play and a fragile command transcript.

## Prefer state-aware modules

For common host configuration, use modules whose parameters describe the intended outcome:

```yaml
- name: Ensure the application account exists
  ansible.builtin.user:
    name: appsvc
    system: true
    shell: /usr/sbin/nologin
    state: present

- name: Ensure the application directory exists
  ansible.builtin.file:
    path: /srv/app
    state: directory
    owner: appsvc
    group: appsvc
    mode: '0750'

- name: Ensure the service is enabled and running
  ansible.builtin.service:
    name: app
    enabled: true
    state: started
```

The module can compare current and requested state and report meaningful change. `ansible.builtin.package` selects the platform package manager, while `ansible.builtin.apt` and `ansible.builtin.dnf` expose package-manager-specific options. `ansible.builtin.copy`, `template`, `lineinfile`, `blockinfile`, and `get_url` cover file workflows, but each has different semantics. For example, `lineinfile` manages a matching line, whereas `template` owns the complete generated file. Select the tool that matches the ownership boundary; do not use a one-line edit module to quietly take over a vendor-managed config without understanding its format.

Modules are not interchangeable just because they modify the same object. `ansible.builtin.command` runs a program without shell interpretation. `ansible.builtin.shell` invokes a shell and permits pipes, redirects and expansions, which introduces quoting and injection concerns. `ansible.builtin.raw` sends a command without requiring Python on the remote node and is mainly useful for bootstrap situations. If an appropriate module exists, use it rather than recreating its behavior in shell.

## Fully qualified collection names

A module's fully qualified collection name (FQCN) takes the form `namespace.collection.module`, for example `ansible.builtin.copy`, `ansible.builtin.apt`, or `ansible.posix.firewalld`. The prefix makes ownership explicit, avoids ambiguity when multiple collections provide a short name, and helps lint tools and maintainers resolve behavior. Use FQCNs consistently in maintained playbooks. A module may be available only after installing its collection, so a syntactically valid name does not prove the controller has the dependency.

Collections also provide inventory, connection, lookup, filter, callback and other plugins, plus roles. A playbook requiring a non-core collection should declare it in a project `requirements.yml` and install a known version in the execution environment:

```yaml
collections:
  - name: ansible.posix
    version: '>=1.5.0,<2.0.0'
```

For production, prefer a deliberate version pin or a tested bounded range, and capture the full controller dependency set in a reproducible environment. `ansible-galaxy collection install -r requirements.yml` installs declared collections. A collection upgrade is a code change: review release notes and rerun tests instead of allowing the controller to use whatever version happens to be current.

The built-in collection is `ansible.builtin`, distributed with `ansible-core`. Other common namespaces include `community.general` for broadly useful community modules and vendor namespaces for their maintained integrations. Module availability and behavior depend on `ansible-core`, collection versions, Python dependencies and the execution environment. Consult the documentation for the installed version, especially for parameters introduced recently or modules marked deprecated.

## Reading module contracts

`ansible-doc ansible.builtin.copy` displays a module's documentation locally. `ansible-doc -l` lists available plugins, and `ansible-doc -t connection -l` filters by plugin type. Read parameter types, required fields, defaults, platform support, return values, check-mode support and examples. A parameter name copied from a different module is not accepted merely because it sounds plausible. Some modules execute on the controller and call remote APIs; others run on the target. `delegate_to`, connection type, and credential context can therefore change where an action occurs.

The `register` keyword stores a module result in a variable, which can be inspected or used in later conditions. Use the module's documented return structure rather than assuming all modules use the same field names. For tasks that report structured output, inspect with a narrow debug task during development and remove or redact sensitive values before production. `no_log: true` suppresses task output but does not itself ensure external logging, callback plugins or controller diagnostics never capture related data; treat it as one layer of protection.

## Check mode and module limits

Many built-in modules support check mode (`--check`) and diff output (`--diff`), but support is module-specific and can be partial. A module may not know what it would change, and a command task cannot generally predict arbitrary side effects. Check mode is a useful preview, not a formal transaction or proof of safety. Use disposable environments, tests and backups for high-impact work. When a task must run in check mode to provide information, `check_mode: false` can force execution, but that should be rare and explicitly justified because it creates real side effects during a nominal dry run.

Custom modules can be written when an API or domain operation has no suitable implementation, but maintainers then own argument validation, idempotency, check-mode behavior, documentation and compatibility. Before building one, search the maintained collections and inspect whether a supported module already covers the need.

Some modules have an action plugin that performs part of the work on the controller while coordinating with a target module; others call cloud APIs from the controller. This affects required libraries, proxy settings and credential placement. Read the module's attributes and documentation for where it runs, whether it supports delegation, and whether it can operate without a managed host. If a task runs against `localhost`, use the appropriate local connection and ensure the execution environment has the required SDK. Avoid assuming that a dependency installed on a target is available to a controller plugin, or that a controller token is visible to the remote host. Explicitly document these requirements with the project's environment definition so local and CI runs have matching capability.

## Common mistakes

- Using `shell` for package, user or service management that already has a purpose-built module.
- Omitting collection names and relying on short-name resolution.
- Installing an unpinned collection ad hoc on a controller and assuming CI will match.
- Treating `--check` as a guarantee that no unsafe operation can occur or that all changes are predicted.
- Ignoring module return values and then building conditions around undocumented assumptions.

## Production notes

When module behavior is uncertain, reduce the question to a disposable target and inspect the exact return structure. The same module may have platform-dependent behavior, and controller-side plugins may require Python libraries or credentials not present on the remote host. Document these dependencies with the collection declaration and execution environment rather than as an informal setup step. Check deprecation warnings during upgrades; a warning may not break today's run, but it identifies future work and a migration path. For shell fallbacks, quote variables, avoid interpolating untrusted input into a command string, and use `argv` with `ansible.builtin.command` when appropriate to avoid shell parsing. Use `changed_when` only to represent whether the operation changed state, and test a second run. Keep module output and debug tasks free of secrets, even when the module itself is idempotent.

Use FQCNs, declare collection dependencies, test against the exact `ansible-core` and collection versions used in deployment, and review module documentation for check-mode and platform support. Keep API credentials scoped to the controller job that needs them. Module output is structured operational data: avoid returning secrets in debug messages and use `no_log` where task arguments or results contain sensitive material.