# Loops, Conditionals and Error Handling

Loops and conditions let one task handle a collection of resources or host differences. Error controls decide whether a failed operation stops a play, is handled locally, or is ignored. These features are useful, but they can obscure behavior when used to encode complicated logic. Prefer simple, explicit state transitions and make exceptional paths visible.

## Looping over data

The modern general-purpose loop syntax is `loop`. It iterates over a list and exposes the current item as `item` by default:

```yaml
- name: Ensure packages are installed
  ansible.builtin.package:
    name: "{{ item }}"
    state: present
  loop:
    - curl
    - ca-certificates
    - jq
```

When each item has multiple attributes, use mappings so the data is self-describing:

```yaml
- name: Create service directories
  ansible.builtin.file:
    path: "{{ item.path }}"
    state: directory
    owner: "{{ item.owner }}"
    group: "{{ item.group }}"
    mode: "{{ item.mode }}"
  loop: "{{ service_directories }}"
```

A loop is usually one task repeated for each item, and Ansible reports the item result. `loop_control.label` can shorten output for large or sensitive objects; it does not redact module arguments in every output path. `loop_control.loop_var` changes the variable name when nested includes or role code would otherwise shadow `item`. `index_var` can expose a zero-based index, but avoid treating list order as a stable identity unless the data contract says so.

`with_items` and other `with_*` forms are older loop syntax still seen in existing code. New code generally uses `loop` with filters such as `query('dict', mapping)` or `dict2items` for the desired structure. Do not add a loop when a module already accepts a list: passing a package list to one package task is clearer and can be more efficient than invoking the module separately for each package.

## Conditions and assertions

`when` takes a Jinja expression but is written without `{{ }}`. Conditions evaluate as expressions, not as strings to render. A simple platform condition might use `ansible_facts['os_family'] == 'Debian'`. Combine related conditions with `and`, `or`, and parentheses, but move repeated logic into a well-named variable or task grouping if it becomes difficult to read. A `when` attached to a block applies to its tasks; a condition on an include may be evaluated when included tasks run, so understand static versus dynamic inclusion behavior.

```yaml
- name: Install a Debian-specific package
  ansible.builtin.apt:
    name: apparmor-utils
    state: present
  when: ansible_facts['os_family'] == 'Debian'
```

`ansible.builtin.assert` checks preconditions and gives maintainers a useful error message. Assert required variables, supported platforms, and mutually exclusive options before changing a host. `ansible.builtin.fail` can stop a run with an explicit message when a known invalid state is detected. Conditions should express actual constraints, not work around unexpected failures by skipping the task silently.

## Registering and interpreting results

`register` captures a task result, including module-specific keys, `changed`, and status fields. When the task loops, the registered result commonly contains a `results` list. Use the documented return values for the module and inspect data during development. Do not assume that a successful command implies the application reached a healthy state; query an appropriate service or API if health is the actual requirement.

A task can use `changed_when` to define whether an operation changed state and `failed_when` to express a domain-specific failure condition. These are especially useful for commands with imperfect exit behavior, but they should be based on reliable output or state. If conditions are lists, Ansible combines them with logical AND by default; use a single expression with `or` when any one condition should fail the task. Document the logic so future maintainers do not mistake a suppressed error for success.

## Failures, blocks and recovery

By default, an unhandled task failure stops further tasks for that host. Other hosts may continue depending on strategy and failure settings. `block`, `rescue` and `always` provide structured error handling:

```yaml
- name: Apply and verify application configuration
  block:
    - name: Install configuration
      ansible.builtin.template:
        src: app.conf.j2
        dest: /etc/app/app.conf
        mode: '0640'
      notify: Restart app
  rescue:
    - name: Record a useful failure marker
      ansible.builtin.debug:
        msg: "Configuration failed; investigate before retrying this host."
  always:
    - name: Capture current service state
      ansible.builtin.command: systemctl is-active app
      changed_when: false
      failed_when: false
```

A successful rescue means the block's original failure is treated as recovered for play flow, so rescue should perform a real recovery or make the state explicitly visible—not merely print a comforting message. Tasks in `always` run whether the block succeeds or fails, subject to unreachable-host and controller-level exceptions. Avoid using `ignore_errors: true` broadly; it can leave a host partially configured while the run appears successful. If a task is allowed to fail, capture and report that fact deliberately.

`any_errors_fatal: true` can stop execution across hosts after a fatal task failure. `max_fail_percentage` and `serial` can bound rollout. `meta: clear_host_errors` can reactivate unreachable or failed hosts in specific recovery flows; it should not be a routine way to hide connection problems. A failure in a task can leave prior tasks applied, so playbooks should be safe to retry and should make intermediate state coherent wherever possible.

Loops over registered results and conditionals that inspect `item` need care because a failure or skipped result can have a different shape from a normal successful result. Use documented return keys and branch explicitly on `is failed`, `is skipped` or `is changed` where appropriate. A `failed_when` expression should describe the actual failure contract and not be written to accept every unfamiliar output. For transient operations, retries and `until` can help, but select a bounded retry count and delay, and make sure repeating the operation is safe. A retry loop that repeatedly changes state can magnify the original problem. Capture enough context to diagnose the final failure, including the host and item, while avoiding credentials and other sensitive values in the resulting logs.

## Common mistakes

- Using a loop around a module that already accepts a list of names.
- Writing `when: "{{ condition }}"`, which mixes templating with expression syntax.
- Ignoring failures to get a green pipeline while leaving a broken service behind.
- Assuming `rescue` is just logging; a successful rescue changes how failure is reported.
- Using `changed_when: false` to conceal a task that mutates the host.
- Depending on a command's text output without validating it against the module or command's contract.

## Production notes

Remember that condition evaluation and module execution happen across hosts with potentially different facts and prior task results. A condition that is true on one host may be false on another; summarize which branch applied instead of assuming all hosts took the same path. For loops, large input lists can create noisy output and many remote calls, so first ask whether the module can accept a list in one operation. If each item must be applied separately, make item identifiers visible in task output and keep any sensitive fields out of labels. Failure policy should match service impact: a failed optional monitoring-agent task may not justify halting every host, while a broken database migration probably should. Document why tolerated failures are safe and alert on them; ignored errors otherwise become invisible operational debt.

Keep loops data-driven and conditions short. Validate inputs before destructive tasks, use meaningful failure messages, and test both success and failure branches. Choose rollout settings based on service redundancy and recovery capability. For tasks that may fail after partial mutation, design an idempotent retry, explicit rollback, or operator handoff rather than assuming Ansible can automatically reverse changes.