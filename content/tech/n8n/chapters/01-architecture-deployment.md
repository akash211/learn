# Architecture and Deployment

n8n is both a workflow editor and an execution service. Understanding how those responsibilities meet is important before moving a workflow from a laptop to a production environment. The same workflow graph can be run by a single process or by a distributed queue-mode deployment, but the surrounding database, encryption key, binary storage, networking and backup choices determine whether that deployment is recoverable and secure.

## The main components

A typical n8n process serves the editor and API, accepts triggers, schedules work and executes workflows. It reads workflow definitions, credentials and execution metadata from its database. By default, a small self-hosted installation can use SQLite; PostgreSQL is the usual choice when a deployment needs a separately operated database, concurrent access or queue-mode support. PostgreSQL itself must be backed up, monitored and upgraded. It is not made highly available by selecting it as the database.

A workflow's saved definition is not identical to an execution. A run has its own status, input and output data, timestamps and failure information. Execution data can contain personally identifiable information, authentication-adjacent values or entire API responses. The setting for saving successful, failed and manual executions should reflect debugging needs, storage capacity and retention obligations. Pruning limits database growth; it is not a substitute for a formal retention policy or backup procedure.

In Docker, the container image provides the n8n application, but important state usually lives outside the container. Persist the `.n8n` directory when using SQLite and local files, and persist the external database independently when using PostgreSQL. Keep the encryption key stable across restarts. Replacing a container without restoring its database and key may leave credentials unusable or workflows missing. A mounted volume is persistence, not a backup: accidental deletion or storage failure can still destroy it.

## A practical Docker deployment

For a local evaluation, `docker run` can launch n8n, but a Compose file makes the service and its dependencies reproducible. Bind the editor to a private interface or put it behind a trusted reverse proxy; do not expose an unauthenticated editor directly to the public internet. Set `N8N_ENCRYPTION_KEY` explicitly and store it outside the compose file in a secret mechanism or protected environment file. Configure a durable volume for application data and use TLS at the reverse proxy for remote access. On a server, restrict database and Redis ports to the private network.

Useful configuration names include `DB_TYPE=postgresdb`, `DB_POSTGRESDB_HOST`, `DB_POSTGRESDB_DATABASE`, `DB_POSTGRESDB_USER`, and `DB_POSTGRESDB_PASSWORD`. `N8N_HOST`, `N8N_PROTOCOL`, `N8N_PORT`, and `WEBHOOK_URL` affect externally generated webhook URLs and should agree with the reverse proxy. Behind a proxy, configure `N8N_PROXY_HOPS` to match the actual trusted proxy chain. Misconfigured external URLs can make the editor show a correct internal address while third parties call an unreachable webhook.

A container upgrade should be a deliberate migration. Read release notes, check compatibility and migration requirements, back up the database and encryption key, then deploy a pinned version rather than relying on an unqualified `latest` tag. Rollback may not be safe after a database migration. Test restores, not just backup creation; a usable recovery procedure needs the database, encryption key, configuration, and any required binary data or mounted files.

## Queue mode: Redis and workers

Queue mode separates the main process from the work of executing production workflow runs. A main instance manages the editor, API and trigger registrations, then places execution jobs on Redis. Worker processes consume jobs and execute workflows. Redis is a queue broker, not the source of truth for workflow definitions or credentials; those remain in the shared database. All participating processes need compatible n8n versions, access to the same database, and the same `N8N_ENCRYPTION_KEY` so encrypted credential data can be decrypted consistently.

Set `EXECUTIONS_MODE=queue` for the main and workers and configure the Redis connection with `QUEUE_BULL_REDIS_HOST`, `QUEUE_BULL_REDIS_PORT`, and, where needed, authentication and TLS settings. Start workers with the n8n worker command, for example `n8n worker --concurrency=5`. Concurrency is an operational setting: more concurrent jobs can increase throughput but also database load, memory use, API pressure and downstream contention. A worker process can be scaled horizontally, subject to available Redis, database and remote-service capacity. Queue mode is not a guarantee of exactly-once side effects; jobs can be retried or interrupted around external calls.

The main process still matters. It handles the editor and trigger management and must remain available for normal administration. Webhook handling may be separated into webhook processors in larger deployments, but proxy routing and supported configuration need to be checked against the deployed n8n release. Do not assume every component can be scaled independently without coordination. Queue depth, worker health, job failures, database latency and Redis availability are signals to monitor.

## Self-hosted and cloud responsibilities

With n8n Cloud, the provider operates the service infrastructure and deployment lifecycle. The user still owns the workflow's correctness, credential scope, access policies, data minimization and downstream effects. Cloud and self-hosted plans can differ in capabilities, limits and lifecycle behavior; verify current product documentation instead of assuming parity. Self-hosting provides infrastructure and data-location control but transfers patching, availability, networking, storage, backup and incident response to the operator. It does not automatically make a deployment private or compliant.

| Concern | Self-hosted | n8n Cloud |
|---|---|---|
| Runtime and upgrades | Operator deploys, patches and plans migrations | Provider operates the platform; user manages workflow changes |
| Data and network placement | Operator selects infrastructure and controls egress | Provider's service boundaries and available regions apply |
| Database, Redis and backups | Operator configures and tests them | Platform-managed details; review the service's current guarantees |
| Credentials and access | Operator controls key, identity and perimeter | User still scopes credentials and controls account access |
| Incident response | Operator diagnoses host, queue, database and proxy | Provider handles platform faults; user handles workflow and destination effects |

## Production notes

Start with the smallest architecture that meets recovery and concurrency requirements. A single process plus PostgreSQL can be a more understandable first production deployment than queue mode if one process has enough capacity. Introduce Redis and workers when you can identify the bottleneck and operate the additional components. Document the restore order, key custody, network paths, update procedure and execution-data policy. Rehearse an outage: losing Redis should not mean losing workflow definitions, while losing the database or encryption key has much more serious consequences.

## Common mistakes

- Treating a container restart as a backup or assuming the filesystem inside a container is durable.
- Putting `N8N_ENCRYPTION_KEY` in an image or rotating it without a credential migration plan.
- Running multiple instances that disagree on database, key or execution mode.
- Exposing editor, PostgreSQL or Redis ports publicly for convenience.
- Enabling queue mode without monitoring queue depth, worker failure and database capacity.
- Assuming cloud hosting eliminates responsibility for permissions, data retention and downstream failure handling.
