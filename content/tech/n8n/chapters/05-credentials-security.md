# Credentials, Encryption and Security

Credentials are valuable because workflows use them to act as a user or service. An n8n credential may contain an API token, OAuth client configuration, username and password, or other authentication material. The editor's credential abstraction prevents authors from needing to copy a secret into every node field, but it does not remove the need to limit access, protect storage, avoid leaking values into execution data and rotate credentials when appropriate.

## Credential storage and encryption key

In a typical self-hosted setup, n8n stores credential records in its database in encrypted form. `N8N_ENCRYPTION_KEY` supplies the key used to encrypt and decrypt credential data. If the key is not managed consistently, credentials may be inaccessible after a restart, migration or move to another instance. Set a strong, unique key through a protected secret-management mechanism and provide the same key to every process that must read the shared database, including queue workers. Do not commit it to Git, bake it into a container image or print it in startup diagnostics.

Back up the key separately from the database and restrict access to both. A database backup without the matching key may contain encrypted values that cannot be used; a stolen key plus a database backup can expose credentials. Treat the pair as sensitive recovery material. Rotating a key is not equivalent to changing an environment variable: previously encrypted records may still depend on the old key. Follow the current documented key-rotation or credential migration procedure and test on a restorable copy before changing production.

Cloud and self-hosted operations differ. n8n Cloud operates the platform's infrastructure and credential-storage implementation; the customer still controls which credentials are entered, what access they grant and which workflows may use them. Self-hosting makes the operator responsible for key generation, secure delivery, backups, filesystem and database permissions, and recovery. Check current product documentation for each deployment's credential and access-control behavior rather than assuming the same storage or administrative controls in both.

## Least privilege and workflow access

Create dedicated integration identities rather than using a personal administrator account. Scope OAuth grants and API tokens to the minimum actions and resources the workflow needs. Separate read-only from write credentials, development from production, and high-impact tasks from ordinary automations. When possible, restrict a token at the service boundary by IP, project, tenant or resource. A compromised workflow then has less authority.

Credential sharing and project permissions determine who can use or alter integrations. Grant edit access only to people who should be able to change the workflow's behavior. A person who cannot reveal a stored secret may still be able to make a workflow use it to send data elsewhere. Review who can edit workflows, create credentials, activate workflows and administer the n8n instance. For self-hosted installations, protect the editor with TLS, authentication and network controls; restricting editor access is more important than hiding the editor URL.

## Execution data and secrets in workflows

A secret can leak even when it is stored as a credential. Avoid manually embedding tokens in expressions, Code nodes, headers, URLs or static workflow JSON. Use the credential selector or an approved external secret mechanism. Never return a credential value as an output field for debugging. Execution inputs and outputs may be saved, shown to users with execution access, exported or sent to an error handler. Limit execution-data saving where appropriate, prune records, and redact or minimize data before passing it between nodes.

Be cautious with untrusted data. A workflow that lets an external webhook submit a URL and then calls HTTP Request with it may become a server-side request forgery path, reaching internal services or cloud metadata endpoints. Validate allowed hosts and schemes; do not let arbitrary user input control credentials, SQL, shell commands, file paths or code. Access to a Code node, community node or external package expands the attack surface. Review the node's source, permissions and maintenance status before installing it, and maintain an allowlist where supported.

## Network and platform hardening

For self-hosting, keep n8n, its database and Redis on private networks wherever possible. Use TLS at ingress, correctly configure trusted proxies, and set `WEBHOOK_URL` to the public HTTPS endpoint. Disable or restrict features that are unnecessary in your environment, such as public user registration if present in the deployment configuration. Keep the application and base image patched, restrict filesystem and container privileges, and run as a non-root user when supported by the deployment. Follow the current hardening guidance because configuration options evolve.

Audit workflows as software: review diffs, identify external destinations, assess data flows and require approval for changes that can move sensitive data or trigger irreversible actions. Keep secrets out of exported workflow files and sanitise diagnostic bundles. A workflow export is not necessarily secret-free in every configuration or node type; inspect it before sharing. Use synthetic data for examples and avoid committing production execution samples.

## Security checklist

- Store the encryption key outside source control and distribute it securely to all required instances.
- Back up and restore the database and key together as a tested recovery process.
- Use least-privilege service accounts and separate credentials by environment.
- Limit editor, project, credential and workflow-edit permissions.
- Minimize stored execution data and keep it only as long as necessary.
- Validate untrusted webhook inputs and destination URLs.
- Pin and review community nodes, containers and upgrades.

## Identity, audit and incident response

Use named user accounts and the supported access-control features of the deployment rather than sharing an administrator login. Remove access when a collaborator leaves, and review dormant credentials and workflows periodically. A credential can outlive the employee or integration that created it. Rotating service tokens should include a plan to update the corresponding n8n credential and test the workflow before revoking the old token. Prefer short-lived or revocable tokens where the external provider supports them.

If a credential or instance is suspected to be compromised, treat workflow definitions and execution history as evidence as well as the secret itself. Disable affected workflows if necessary, revoke credentials at the issuing service, preserve relevant logs securely, and identify destinations that may have received data. Rotating the n8n encryption key alone does not revoke an API token already copied by an attacker. Recovery must address both platform access and external identity. Document the incident steps before an emergency.

## Common mistakes

- Assuming a credential selector makes the resulting workflow safe from misuse.
- Changing `N8N_ENCRYPTION_KEY` without a migration plan.
- Sharing a production credential with development workflows by convenience.
- Sending full execution input to a chat alert or retaining it forever.
- Allowing a webhook caller to choose arbitrary URL, SQL or executable code.
- Assuming hosted operation removes the need for scoped access and data review.
