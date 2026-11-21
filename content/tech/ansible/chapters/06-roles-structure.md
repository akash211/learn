# Roles and Role Structure

Roles package related automation into a predictable structure. They provide a way to reuse tasks, handlers, templates, files and defaults without copying blocks between playbooks. A role is not automatically a good abstraction: it is useful when its responsibility and inputs are clear, and harmful when every task is split into tiny wrappers that hide the actual execution path.

## The conventional layout

A role can contain these directories, each with a conventional entry file:

```text
roles/
  web_service/
    defaults/main.yml
    vars/main.yml
    tasks/main.yml
    handlers/main.yml
    templates/nginx.conf.j2
    files/healthcheck.sh
    meta/main.yml
```

`tasks/main.yml` is the role's primary task list. `handlers/main.yml` contains handlers. `defaults/main.yml` holds low-precedence user-facing defaults. `vars/main.yml` is for role data intended to be less readily overridden; use it sparingly because its precedence can surprise consumers. `templates/` and `files/` provide assets to `template` and `copy`. `meta/main.yml` can declare metadata and dependencies. `tests/` and `README.md` are useful project conventions even though they are not required runtime directories.

Role names should reflect a bounded capability: `nginx`, `node_exporter`, or `app_deploy` is clearer than `common` when a role does unrelated jobs. A role should state its supported platforms, required inputs, defaults, side effects and handlers. Document where it expects a service name or config path to come from and whether it assumes package repositories are already configured.

## Applying a role

A play can apply roles declaratively:

```yaml
- name: Configure web servers
  hosts: web
  become: true
  roles:
    - role: web_service
      vars:
        web_listen_port: 8080
```

This is convenient for a straightforward sequence of roles. The `import_role` and `include_role` task actions allow roles to be used within task lists. Imports are statically expanded during parsing; includes are dynamic and evaluated during execution. Dynamic inclusion enables runtime selection and loops over role invocations, while static imports are easier for some forms of inspection and tag processing. Because details such as tags, conditions and variable visibility differ, select intentionally and test invocation behavior with the project's Ansible version.

Role search paths can include a project's `roles/` directory and configured paths. In larger codebases, use `ansible.cfg` `roles_path` deliberately or store roles in collections. A role downloaded from Galaxy or another source should have a pinned version and review process. The same role name from a different search path can otherwise create confusing behavior. `ansible-galaxy role list` can show installed roles; `ansible-playbook --list-tasks` helps inspect what a play will run.

## Defaults are an interface

Role defaults define the supported customization surface. If a consumer should configure `web_listen_port`, give it a sensible default in `defaults/main.yml` and use that variable in tasks and templates. Validate required parameters early with `ansible.builtin.assert`. Avoid undocumented variable names that users must infer from task internals. Do not put secrets into role defaults; a public default file is often committed and distributed widely.

A role should avoid owning unrelated state. For example, an application role may configure the application and its service but should not silently create cloud networks or rewrite host firewall policy unless those responsibilities are explicit. Narrow responsibilities make testing and reuse easier and prevent a small role change from having surprising effects. Dependency declarations in `meta/main.yml` can express prerequisites, but a long chain of implicit dependencies makes execution order difficult to understand. Prefer an explicit play role list when the sequence matters operationally.

Handlers within roles can be notified by fully qualified handler names or listener topics. Keep names unique and meaningful, especially when multiple roles contribute handlers. A handler that restarts a shared system service may have broader impact than the role's own files, so document that side effect. Handler notifications are coalesced and normally run at the end of the play, just as with play-level handlers.

## Collections and role distribution

Collections group roles with related plugins and metadata. An installed collection role uses a namespaced name such as `acme.platform.web_service` (the precise namespace and collection must actually exist). Collections are helpful for distributing a supported set of automation artifacts and versioning them together. A project should declare the collection dependency and install it into the same execution environment used in CI and production. Avoid relying on a role found by chance on a developer's machine.

Roles should be testable independently where feasible, but integration behavior also matters: inventory variables, handlers and other roles influence the result. A role test should exercise representative defaults and overrides and check the resulting system, not merely assert that the YAML parses. Static checks catch syntax and style problems; integration tests validate side effects and idempotency.

Collections can be a useful ownership boundary for roles shared across multiple projects, especially when a team wants to ship modules, plugins and roles together. The tradeoff is release and dependency management: a breaking role change may require a collection version bump, migration notes and coordinated consumer updates. Keep a role README or collection documentation focused on the public contract rather than restating every task line. Examples should be runnable with a disposable inventory and safe dummy values. Avoid importing internal task files from outside the role, because those file paths are implementation details that constrain refactoring. If a role genuinely needs an extension point, define a supported variable or documented task include rather than relying on consumers to override internals.

## Common mistakes

- Putting user-overridable settings in `vars/main.yml` instead of role defaults.
- Making one giant `common` role the home for every unrelated host concern.
- Assuming role task ordering or tag behavior is identical for `import_role` and `include_role`.
- Using implicit role dependencies to hide important rollout steps.
- Installing Galaxy roles without version pinning or reviewing what they change.
- Treating role reuse as proof that a role is safe on every target platform.

## Production notes

A role's interface is more than its variable defaults. It also includes tags, handlers, task ordering, assumptions about elevated privileges, supported operating systems and side effects such as restarting a shared daemon. Treat changes to those behaviors as compatibility changes for consuming playbooks. Before publishing a role, provide an example play that shows its required inputs and expected privileges. Keep examples free of real credentials and production host names. If a role is intended for a Galaxy or collection release, build and test the artifact that consumers will actually install, not just the source checkout. Dependency roles and collections should be pinned in the consumer's execution environment. When roles share data, pass it through explicit variables rather than reaching into another role's private defaults or files; this keeps upgrades local and ownership understandable.

Treat the role defaults and documented variables as a public interface. Pin external role and collection dependencies, test the role in its supported runtime, and include idempotency checks. Use an explicit play for orchestration order and keep environment-specific configuration in inventory. When changing a shared role, identify every consuming playbook and test the widest relevant combination before rollout.