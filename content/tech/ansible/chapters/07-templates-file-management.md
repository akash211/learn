# Jinja2 Templates and File Management

Configuration files are often the main product of configuration management. Ansible's `template` module renders a Jinja2 template on the controller, transfers the result, and can apply ownership and permissions on the managed host. `copy` transfers a static file, while modules such as `lineinfile` and `blockinfile` manage targeted regions. Selecting the right file-ownership model avoids subtle drift and damaged configuration.

## Template the complete file you own

A template is appropriate when Ansible owns the complete generated file or a clearly defined file section. Keep the template close to its role under `templates/` and use `.j2` as a common suffix:

```jinja2
# Managed by Ansible; local edits will be replaced.
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    server {
        listen {{ web_listen_port }};
        server_name {{ web_server_name }};

        location /health {
            return 200 "ok";
        }
    }
}
```

```yaml
- name: Install nginx configuration
  ansible.builtin.template:
    src: nginx.conf.j2
    dest: /etc/nginx/nginx.conf
    owner: root
    group: root
    mode: '0644'
    validate: '/usr/sbin/nginx -t -c %s'
  notify: Reload nginx
```

The template is evaluated on the controller, then the resulting content is transferred. `validate` runs a validation command against a temporary candidate file before placing it at the destination; `%s` is replaced with the temporary path. Confirm that the application's validation command accepts this workflow and does not require the file already at its final location. A successful template task does not by itself prove the running service accepted the new configuration, so pair it with a change-triggered reload and an appropriate health check when needed.

Jinja control structures support loops, conditions and filters. Keep logic modest in templates; if a template contains complicated data transformations, normalize the variables in play logic or a filter first. Whitespace control can affect generated files, especially line-based formats. Review output with `--diff` in a safe environment and test syntax with the native application validator. Never treat a rendered diff as safe to publish when it might contain secrets.

## Static files and targeted edits

Use `ansible.builtin.copy` for a static artifact such as a script, certificate chain or unit file. Set owner, group and mode explicitly. `src` normally refers to a controller-side path, while `remote_src: true` means the source is already on the target. For downloading remote content, `ansible.builtin.get_url` can fetch to a target path and verify a checksum; use an immutable URL or checksum where supply-chain integrity matters. A moving URL can make repeated play runs change unpredictably.

`lineinfile` is useful for a simple single-line setting in a file that has no suitable structured module. `blockinfile` manages a marked block and can coexist with other content. Both can be risky when syntax permits duplicate keys, ordering matters, or another tool owns the file. For formats such as YAML, JSON or application-specific config, prefer a parser-aware module where available, or manage the whole file with a template. Do not combine several editing strategies on the same region; the last writer may undo the earlier one.

Directory and file state belongs to `ansible.builtin.file`: use `state: directory`, `state: file`, `state: absent`, or `state: link` as appropriate. Set `recurse: true` only when recursive ownership or mode changes are intended, because it can touch a large tree. `state: touch` intentionally updates timestamps and is often not idempotent in the operational sense. File modes should be quoted strings such as `'0600'` so YAML parsing cannot reinterpret them.

## Security and ownership

Every file task should answer who owns the target, who can read it, and whether Ansible owns the complete content. Secrets rendered to disk need restrictive modes and a clear rotation path. A private key or credential file should generally be owned by the service account or root and readable only by intended principals. Use `no_log: true` for tasks whose arguments or results contain sensitive values, but remember it does not eliminate secrets from every external log, controller process, backup or diff.

Avoid applying broad permissions recursively as a cleanup shortcut. It can alter executable bits, setuid bits, service-owned files and mount boundaries. If a task manages a file that an application rewrites, define whether Ansible will overwrite local changes, preserve them, or detect and fail. Configuration management works best when ownership is explicit and competing writers are removed.

File transfer and rendering also interact with SELinux, ACLs, symlinks and mounted filesystems. A correct Unix owner and mode may not be sufficient if the SELinux label prevents a service from reading a file; use the appropriate supported module options or policy management rather than disabling enforcement. A destination path that traverses a symlink may resolve somewhere unexpected, so inspect the actual target and use `follow` behavior intentionally. On systems where ACLs are part of the access model, changing the mode may alter or mask effective permissions. Avoid generating files in shared temporary directories with predictable names. For large artifacts, consider `get_url` with checksum and proxy handling rather than copying through the controller. After deployment, check file content, metadata and the consuming service's access as separate assertions.

If a file is part of a package-managed configuration, decide whether the role replaces it, installs a drop-in, or manages a vendor-supported include directory. Replacing the main file can discard distribution defaults and future package changes. Templates should be named and documented so that local administrators know they are managed and where to change source values. Where preservation of human edits is required, detect divergence and stop for review rather than silently clobbering it. File management is safest when the ownership and rollback behavior are explicit from the start.

## Common mistakes

- Using `lineinfile` to edit a structured configuration with duplicate or order-sensitive keys.
- Forgetting `owner`, `group` or `mode` and relying on controller umask or destination defaults.
- Leaving an unquoted file mode such as `0644`.
- Rendering a secret into a broadly readable file or exposing it through `--diff`.
- Writing a template and reloading a service without validating syntax first.
- Setting `recurse: true` across a large directory without understanding the changed files.

## Production notes

A generated file is an API boundary between automation and the service that consumes it. Keep template variables explicit, quote or escape values according to the target file format, and test edge cases such as spaces, comment characters and empty optional values. Jinja autoescaping is not generally a substitute for format-specific encoding in arbitrary configuration files. If output has a strict syntax, use the application's parser and a representative fixture in tests. Be cautious with `backup: true`: backups may preserve old credentials or configuration and accumulate indefinitely, so define their access and retention. If another process rewrites a managed file, decide whether Ansible should replace it, merge a region, or report drift; dual writers create unstable results. Run file tasks against a test host with the same umask and filesystem semantics as production, especially where ACLs or SELinux labels matter.

Make file ownership boundaries explicit, validate candidate configuration before activation, and trigger one handler after all relevant files are changed. Use versioned or checksummed artifacts for downloads. Test both rendered output and the target application's own parser, and verify service health after activation. For config files shared with another management tool, establish a single source of truth before introducing Ansible edits.