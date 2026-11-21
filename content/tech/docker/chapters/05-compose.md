# Compose for Local Stacks

Compose describes a multi-container application in one YAML file and runs it on one host. Its
value is not orchestration — it has none — but the elimination of a README page of `docker run`
commands that nobody keeps up to date. A checked-in `compose.yaml` is the difference between
"start the stack" being one command and being tribal knowledge.

## The file

```yaml
name: shop

services:
  api:
    build:
      context: .
      target: runtime
    environment:
      DATABASE_URL: postgresql://shop:shop@db:5432/shop
      REDIS_URL: redis://cache:6379/0
    ports:
      - "127.0.0.1:8080:8000"
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    develop:
      watch:
        - action: sync
          path: ./app
          target: /app/app
        - action: rebuild
          path: ./requirements.txt

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: shop
      POSTGRES_DB: shop
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shop -d shop"]
      interval: 5s
      timeout: 3s
      retries: 10

  cache:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]

  adminer:
    image: adminer:4
    ports: ["127.0.0.1:8081:8080"]
    profiles: ["tools"]

volumes:
  pgdata:
```

There is no `version:` key. Compose v2 ignores it and warns that it is obsolete; the file format
is the Compose Specification, and the version number stopped corresponding to anything useful
years ago. `docker compose config` renders the merged, interpolated result — the fastest way to
answer "what did it actually run".

## What Compose gives you that `docker run` does not

**A shared network and DNS.** Every service joins a project-scoped network and resolves the
others by service name. `db` in the connection string is the service key, not the container name,
and Compose keeps working when the container is recreated with a new ID.

**Start-order dependencies with readiness.** `depends_on` in its short list form only orders
startup; the process on the other side may still be initialising. The long form with
`condition: service_healthy` waits for the healthcheck to pass, which is what actually prevents
"connection refused" on the first request. `service_completed_successfully` is the right
condition for a one-shot migration job.

**Named volumes with a project prefix.** `pgdata` becomes `shop_pgdata`, so two checkouts of the
repository do not share a database by accident.

**Configuration layering.** `compose.override.yaml` is merged automatically on top of
`compose.yaml`, which is how a development setup adds bind mounts and a published debug port
without polluting the base file. `docker compose -f compose.yaml -f compose.prod.yaml up` does
the same explicitly. Merge rules are worth knowing: scalars are replaced, `ports` and `volumes`
lists are appended, and the `!reset` and `!override` tags force a value to be cleared or
replaced when appending would be wrong.

**Profiles.** `profiles: ["tools"]` keeps optional services — admin UIs, mail catchers, seed
jobs — out of the default `up` and available with `docker compose --profile tools up`.

## The workflow

```bash
docker compose up -d --build          # create/start, rebuilding images
docker compose ps                     # status, health, published ports
docker compose logs -f api            # follow one service
docker compose exec api python -m app.shell
docker compose run --rm api pytest    # one-off command in a fresh container
docker compose config                 # validate + render
docker compose watch                  # sync code on save, rebuild on dependency change
docker compose down                   # stop and remove containers/networks
docker compose down -v                # ...and volumes: this deletes your database
```

`docker compose run` does not publish the service's ports by default, which is deliberate: a
one-off test run should not collide with the running stack. Add `--service-ports` when it must.
`docker compose up --wait` blocks until healthchecks pass, which is what a Makefile target or a
CI smoke test wants.

Compose v2 is a CLI plugin — `docker compose` with a space. The old Python `docker-compose` (v1)
is end-of-life and its behaviour differs in ways that bite: no `--wait`, different dependency
semantics, and no watch mode.

## Environment and secrets

Three mechanisms, often confused:

| Mechanism | Applies to | Precedence |
|---|---|---|
| Shell environment | Variable interpolation in the YAML | Highest for interpolation |
| `.env` in the project directory | Variable interpolation in the YAML | Lower than shell |
| `env_file:` per service | Container environment | Lower than `environment:` |
| `environment:` | Container environment | Highest |

So a `DATABASE_URL` written literally in `environment:` wins over anything in `.env`, and
`${DATABASE_URL}` in the YAML is resolved at parse time from the shell, then `.env`, then the
file named by `--env-file`. That ordering explains most "my override did not take effect"
confusion.

Secrets do not become secret because they are in a file. `compose.yaml` gets committed;
`.env` should not. For anything shared, use a secret manager and inject at run time, or
Compose's `secrets:` with a file source, which mounts the value under `/run/secrets/` instead of
putting it in the environment where every `docker inspect` and crash dump can see it.

## Where Compose stops

Compose runs containers on one host and does not reschedule them. If the daemon restarts, a
`restart: always` policy brings them back; if the host dies, nothing does. There are no rolling
deployments, no health-based replacement, no service discovery across machines, and no
declarative reconciliation — `up` is a one-shot action, not a controller.

That makes Compose excellent for local development, CI integration tests, single-host internal
tools, and demos. It is not a production orchestrator, and the tell is a team running
`docker compose up -d` from a deploy script on a production host with no rollback path. If the
requirement is "survive a node failure", the answer is Kubernetes, Nomad, ECS or a managed
platform, and the Compose file becomes a development convenience that mirrors it.

## Common mistakes

- Relying on `depends_on` for readiness instead of a healthcheck condition.
- Committing `.env` with real credentials because "it is only local".
- `down -v` in a cleanup script that runs against a developer's machine with a populated database.
- Using `latest` for `postgres` or `redis` locally, so two developers run different majors.
- Editing the image's baked-in files through a bind mount, then debugging why the change vanishes
  in CI (where the mount does not exist).
- Adding `version: "3.8"`, which now produces a warning and no behaviour.

## Production notes

Keep `compose.yaml` in the repository and validate it in CI with `docker compose config -q`; a
YAML typo discovered at deploy time is avoidable. Pin image tags for third-party services to a
minor version at least. Use `--wait` in scripts so a smoke test runs only after the stack is
healthy. And when the same stack is also deployed to Kubernetes, keep the two descriptions close
enough that a developer can predict what production does — divergence between
`compose.yaml` and the Helm chart is where "works locally" bugs are born.
