# Playbooks, Tasks, Handlers and Idempotency

A playbook is a YAML document describing one or more plays. Each play maps a host pattern to an ordered list of tasks and execution context such as variables, privilege escalation and strategy. A task invokes a module with arguments. The important mental model is not “a YAML script”: a playbook describes work that the Ansible executor interprets across hosts, with task results, errors and notifications.

## The shape of a playbook

```yaml
- name: Configure the web tier
  hosts: web
  become: true
  tasks:
    - name: Ensure nginx is installed
      ansible.builtin.package:
        name: nginx
        state: present

    - name: Install the site configuration
      ansible.builtin.template:
        src: nginx.conf.j2
        dest: /etc/nginx/nginx.conf
        owner: root
        group: root
        mode: '0644'
      notify: Validate and reload nginx

  handlers:
    - name: Validate and reload nginx
      ansible.builtin.command: nginx -t
      changed_when: false
      notify: Reload nginx
    - name: Reload nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
```

The task order is the order within the play for each host, but hosts are normally processed concurrently up to the configured fork count. A failure on one host does not inherently mean every other host stops at that instant. Strategy, failure thresholds and batching options affect that behavior. Use descriptive task names: they appear in console output and logs and are often the first useful diagnostic when a long run fails.

The module name is explicit here (`ansible.builtin.package`, `template`, `command`, `service`). Prefer modules that express desired state over shell commands. `package: state=present` can check the package database and report no change when already installed; `command: apt install nginx` simply runs a command and cannot infer that state correctly without extra logic.

## Handlers make change-triggered work explicit

A handler is a task that runs only when notified by a task reporting changed, normally at the end of a play. Multiple notifications for the same handler are coalesced, so editing three configuration files can result in one service reload. This is both a correctness and efficiency property: reload after a relevant change, not after every run. Handler names are identifiers and should remain stable; `listen` allows multiple handlers to respond to a shared topic when that organization is clearer.

Handlers are not immediate by default. If a later task must observe the effect before the play ends, `meta: flush_handlers` can run pending handlers at that point. Use it deliberately; scattering flushes can make a play harder to reason about. A handler is skipped if an earlier task fails before notifications are flushed, unless failure handling changes the flow. Consider whether a configuration change and service activation need an explicit recovery plan.

A reload and restart are not interchangeable. Use the service's supported reload operation when it safely rereads configuration; use restart only when the application requires it. For configuration validation, validate the candidate file before replacing the active version where possible, or use a validated template mechanism supported by the module. A failed reload should fail visibly rather than leave the run green while the service keeps stale state.

## Idempotency is a behavioral contract

An idempotent task converges a system toward a declared state and becomes a no-op once that state holds. `ansible.builtin.file` with `state: directory`, `ansible.builtin.user` with desired account properties, `ansible.builtin.service` with `state: started`, and package modules with `state: present` are intended for this model. Idempotency is not a magic property of every module or command. A task may report changed on every run if it executes an unconstrained command, downloads a moving artifact, or touches a timestamp unconditionally.

For commands that lack a dedicated module, add reliable guards such as `creates`, `removes`, or explicit `changed_when` and `failed_when` expressions. Those controls must represent the real state transition rather than suppressing inconvenient output. A command that can be safely repeated should still have its result semantics documented. Prefer `ansible.builtin.command` when shell parsing is unnecessary; use `ansible.builtin.shell` only when shell features such as pipelines or redirection are actually needed, and quote interpolated data carefully.

A useful test of idempotency is to run the play twice against a disposable target. The first run should make expected changes; the second should report no changes for converged resources. Some legitimate actions are inherently event-like—sending a notification or rotating a one-off credential—and should be modeled as explicit operations rather than pretending they are state declarations.

## Execution context and safe scope

`gather_facts: true` is the default for many playbooks and invokes fact gathering before tasks. Disable it when facts are not needed and performance or connectivity constraints justify it, but do not then rely on `ansible_facts` implicitly. `become: true` applies privilege escalation to tasks in its scope. Use `serial` to batch a rolling change, `any_errors_fatal` or `max_fail_percentage` when failure should stop broader rollout, and `--limit` for a controlled subset. These safety choices should be visible in playbook structure and deployment instructions.

`vars_files`, `vars`, role variables and inventory variables all contribute to the effective values, with a documented precedence order. Avoid hiding critical behavior in a chain of overrides. Set values at the narrowest practical level and use defaults for safe baseline behavior. A play should make it clear which groups it targets, which privileges it uses, what constitutes change, and what happens if one host fails.

`ansible-playbook --start-at-task` can be useful during development, but it skips earlier tasks that may establish variables, files or service state. It is not a safe recovery method unless the selected task is independently valid on the current host. Similarly, tags create a partial execution path; a tagged task may assume an earlier untagged setup step has run. Test the exact tag or start point used by operators and document prerequisites. Use `--step` for interactive task confirmation in a controlled environment, not as a replacement for review or test. If a play must support partial operations, expose them as clear, documented entry points with assertions for required state. Task names should remain stable enough for automation and operational references, but precise enough to describe effects rather than implementation trivia.

## Common mistakes

- Writing an entire playbook as a sequence of shell commands and losing state awareness.
- Assuming a handler runs immediately after notification rather than at the normal flush point.
- Using `changed_when: false` on a modifying command just to make reports look clean.
- Restarting every service on every run rather than notifying a handler on config change.
- Omitting task names, making failure output hard to interpret.
- Treating a successful syntax check as proof that a play is correct or safe.

## Production notes

A playbook is not transactional: if task six fails, tasks one through five may already have changed the host. Design tasks so retrying is safe and intermediate states are understandable. When there is a disruptive state transition, add a health check after the transition and a clear stop condition before advancing to additional hosts. Use `serial` for rolling changes, but choose its batch size from service redundancy and capacity rather than a round number. A handler restart can fail after a successful file update; operators need to know that the file is new while the process may still be using old state. Consider whether backups, release directories, or a rollback task are appropriate for the particular service. Avoid hiding every failure inside a rescue block. A green return code is only meaningful if the expected end state was actually verified.

Keep playbooks small enough to review, use roles for reusable configuration boundaries, and apply changes first to a test target or canary. Record the desired inputs and pin dependencies so an identical commit does not quietly acquire new behavior through a collection upgrade. Ensure a second run is clean for convergence-oriented plays. Where a task is intentionally non-idempotent, label it as such, constrain its scope, and design its retry and recovery behavior explicitly.