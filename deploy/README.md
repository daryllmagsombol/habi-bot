# Deploying Habi (staging and production)

**Status: not deployed.** These files describe and locally validate a Compose topology only. No remote host was contacted, no image was pushed or pulled from a registry, and no DNS, certificate, email, or SSO configuration exists. Nothing here proves a staging or production deployment, and no production claim is made.

Owner decisions that must land before a real deployment are listed in [Owner decisions still required](#owner-decisions-still-required). Do not invent them.

## What was verified, and where

| Claim | Evidence |
|---|---|
| Both Compose files parse and interpolate | `docker compose ... config --quiet` on 2026-11-03, Compose 5.7.0 |
| Required secrets/tags fail fast when missing | `config` exits non-zero with the documented message |
| The staging stack starts from repo-root builds | `up -d --wait`: postgres, api, web healthy; worker running |
| API and web answer on loopback | `curl 127.0.0.1:3001/health` → `{"status":"ok","service":"api"}`; `curl 127.0.0.1:3000/` → HTTP 200 |
| PostgreSQL has no published port | `docker compose port postgres 5432` → `:0`; container is on the internal network only |
| Caps and restart policy applied | `docker inspect`: 512/512/512/384 MiB, 0.5 CPU each, `unless-stopped` |
| A failing API health check is detected | `SIGSTOP` on the API container → `unhealthy` after ~90 s; `SIGCONT` → `healthy`, `/health` 200 |
| Cleanup is complete | `down -v`: containers, volume, and both networks removed |

The run was on a macOS workstation with Docker 29.5.2 under colima, not on the shared VM. It is a local smoke test of the authored files, not Linux capacity, staging, or production evidence.

## Files

| Path | Purpose |
|---|---|
| [`compose.staging.yaml`](../compose.staging.yaml) | Staging stack: postgres, api, worker, web |
| [`compose.production.yaml`](../compose.production.yaml) | Production stack, same services, immutable image tag required |
| [`staging.env.example`](./staging.env.example) | Placeholder values for staging |
| [`production.env.example`](./production.env.example) | Placeholder values for production |
| [`compose.yaml`](../compose.yaml) | Unchanged local PostgreSQL-only file; not used for deployment |

The env examples are named `deploy/*.env.example` rather than `.env.staging.example` so the CI release secret scan does not reject them as committed `.env` files. Only `.env.example` is exempt from that rule.

## Services and topology

| Service | Image / target | Published port | Network(s) | Memory / CPU | Health check |
|---|---|---|---|---|---|
| `postgres` | `postgres:18.6-alpine` | none | `internal` | 512 MiB / 0.5 | `pg_isready` |
| `api` | `habi-api`, `apps/backend/Dockerfile` target `api` | `127.0.0.1:${API_HOST_PORT:-3001}` | `internal`, `edge` | 512 MiB / 0.5 | HTTP `GET /health` |
| `worker` | `habi-worker`, target `worker` | none | `internal` | 384 MiB / 0.5 | none (see below) |
| `web` | `habi-web`, `apps/web/Dockerfile` target `runtime` | `127.0.0.1:${WEB_HOST_PORT:-3000}` | `edge` | 512 MiB / 0.5 | HTTP `GET /` |

- `internal` is a Docker `internal: true` network: no gateway to the internet, no published ports. Only `api`, `worker`, and `postgres` join it.
- `edge` carries the two loopback-published ports. Only `api` and `web` join it.
- Caps come from the accepted H-007 decision (1.4 GiB and 1.5 vCPU total). Log rotation is `json-file`, 10 MB × 3 files per service.
- `api` and `worker` share one image target family; the worker starts `dist/worker.js` and exposes no port.
- `api` and `worker` get `stop_grace_period: 20s` so SIGTERM shutdown is not cut off at the 10 s default.
- Startup order: `postgres` healthy → `api` and `worker`; `api` healthy → `web`.

The worker's probe depends on the stack. With `HABI_P1_WORKER=0` it is inert and exposes no listener, so a health check would only assert that Node can exit; a crashed worker still shows as exited and is restarted by `restart: unless-stopped`, but liveness is not asserted. With `HABI_P1_WORKER=1` the stack runs `scripts/ci/probe-worker.mjs`, which fails when the runner cannot reach the database or when either Hermes value is missing, so "healthy" means it can actually claim work. See [the deployment runbook](../docs/runbooks/deployment.md).

## Staging versus production

| Aspect | Staging | Production |
|---|---|---|
| Compose project | `habi-staging` | `habi-production` |
| Networks | `habi-staging-edge`, `habi-staging-internal` | `habi-production-edge`, `habi-production-internal` |
| Volume | `habi-staging-postgres-data` | `habi-production-postgres-data` |
| Image tag | defaults to `staging`, overridable | `HABI_IMAGE_TAG` is required; must be an immutable CI tag |
| Image source | local build is expected | CI-built image only; `pull_policy: always`, deploy with `--no-build` |
| Loopback ports | 3000 / 3001 by default | 3000 / 3001 by default |
| Data | disposable | persistent; backup/restore is H-012 and not rehearsed |
| Restart policy, caps, health checks | identical | identical |

Both files keep the API and web ports bound to `127.0.0.1`. Neither terminates TLS, and neither is reachable from another host as written. Public exposure requires the owner's proxy/domain/TLS decision first.

## Required values

| Variable | Staging | Production |
|---|---|---|
| `POSTGRES_PASSWORD` | required (`${VAR:?}`) | required (`${VAR:?}`) |
| `HABI_IMAGE_TAG` | optional, defaults to `staging` | required (`${VAR:?}`) |
| `POSTGRES_DB` | defaults to `habi` | defaults to `habi` |
| `POSTGRES_USER` | defaults to `habi` | defaults to `habi` |
| `API_HOST_PORT` / `WEB_HOST_PORT` | defaults 3001 / 3000 | defaults 3001 / 3000 |

No domain, token, certificate, SMTP, or SSO value is declared, because no service consumes one yet. Adding placeholder variables for those would encode a decision the owner has not made.

Secrets are injected from the deploy shell or an env file passed with `--env-file`. They are not in the Compose files, images, or logs. A filled env file must live outside the repository; the CI secret scan rejects any tracked `.env` or `.env.*` file except `.env.example`.

Note that Compose environment values are visible to `docker inspect` on the host. That is inherent to environment injection; restrict host access instead of assuming the value is hidden.

## Staging commands

Run from the repository root.

```bash
# 1. Validate interpolation without starting anything.
export POSTGRES_PASSWORD='replace-with-a-throwaway-value'
export HABI_IMAGE_TAG=local
docker compose -f compose.staging.yaml config --quiet

# 2. Build web, API, and worker from the repository root.
docker compose -f compose.staging.yaml build

# 3. Start and wait for healthy services.
docker compose -f compose.staging.yaml up -d --wait --wait-timeout 180

# 4. Verify.
docker compose -f compose.staging.yaml ps
curl -fsS http://127.0.0.1:3001/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
docker compose -f compose.staging.yaml port postgres 5432   # prints `:0`: no host port
docker compose -f compose.staging.yaml logs -f api web worker

# 5. Stop. `down` keeps the volume; `down -v` destroys staging data.
docker compose -f compose.staging.yaml down
# docker compose -f compose.staging.yaml down -v
```

`docker compose version` must report a Compose v2 release. If it reports `unknown command: docker compose`, install the Compose CLI plugin before continuing; the `docker-compose` standalone binary runs the same files if needed.

## Production commands

Production is **not** authorized or rehearsed yet. The commands below are the intended path once image distribution and the remaining owner decisions exist. They never build on the host and never run from a dirty tree.

```bash
# On the deploy host, at a clean checkout of the released commit.
export HABI_IMAGE_TAG='replace-with-the-ci-commit-sha'
export POSTGRES_PASSWORD='replace-with-the-production-secret'

docker compose --env-file deploy/production.env -f compose.production.yaml config --quiet
docker compose --env-file deploy/production.env -f compose.production.yaml pull
docker compose --env-file deploy/production.env -f compose.production.yaml up -d --no-build --wait --wait-timeout 180
```

`pull` currently cannot succeed: H-010 builds images without publishing them, so the registry/pull path is undecided. Until that is resolved, no production start is possible from CI-built images, and a local `--build` must not be substituted. The three production services set `pull_policy: always`, so a start resolves the named tag from its published source rather than reusing a same-named local image.

## Rollback

Record the running image tag before any change:

```bash
docker compose --env-file deploy/production.env -f compose.production.yaml ps --format '{{.Image}}' | sort -u
```

Roll back to the previous image set:

```bash
export HABI_IMAGE_TAG='replace-with-the-previously-deployed-tag'
docker compose --env-file deploy/production.env -f compose.production.yaml config --quiet
docker compose --env-file deploy/production.env -f compose.production.yaml pull
docker compose --env-file deploy/production.env -f compose.production.yaml up -d --no-build --wait
curl -fsS http://127.0.0.1:3001/health
```

- Both stacks use one tag for all three images, so a rollback is a single value change and cannot mix API and web versions from different commits.
- If the previous image is unavailable, `down` (without `-v`) stops the stack and keeps the database volume; it does not restore service.
- Database policy: the repository has no schema or migration files, so there is no migration rollback to run. The stated policy is forward-fix plus restore from backup, and **no restore has been rehearsed** — that is H-012. A `down -v` or volume deletion destroys data with no recovery path.

## Exposure and security notes

- PostgreSQL and the worker are on the internal network only; neither has a `ports:` entry in either file.
- API and web publish on `127.0.0.1` only. Nothing is exposed on a host interface until an owner-approved proxy and TLS configuration exist.
- No nginx/`edge` service, Cloudflare configuration, certificate, or forwarded-header handling is included. Each depends on the domain and proxy topology decision, and unverifiable TLS config was deliberately not added.
- No Hermes service exists. The issue mentions Hermes and Cloudflare, but the repository has no Hermes image or integration; adding one now would describe behavior that does not exist.
- Worker concurrency stays at one; no scaling or replicas are configured.

## Owner decisions still required

| Decision | Current state | What it blocks |
|---|---|---|
| Public domain and DNS | not decided | any public routing; no server name or hostname is assumed |
| TLS termination and certificate source | not decided | HTTPS and the `edge`/proxy service; nothing terminates TLS today |
| Reverse proxy topology, forwarded headers, request size/timeouts | not decided | request-size limits, timeouts, and client-IP handling from the issue |
| Cloudflare proxying | not decided | Cloudflare cannot be configured before domain/proxy; no account detail exists |
| Email sender / SMTP credentials | not decided | no mail configuration is present |
| SSO provider and registrations | not decided | authentication is not implemented |
| Image distribution and retention | not decided | `pull` in production, immutable artifact identifiers, CI retention (also open in H-010) |
| Deploy host access and who runs releases | not decided | no SSH, deploy automation, or credentials were authored |
| Backup, restore, and migration policy | not rehearsed | database rollback and disaster recovery (H-012) |
| Hermes hosting and private-network placement | not implemented | the Hermes service and its health check |

## Not covered

- No staging or production deployment, no registry push/pull, no DNS, no certificate issuance.
- No clean-host deploy log; the only run was on the authoring workstation.
- No Linux/VM capacity validation; H-007 sizes are ceilings, not measured Habi load.
- No backup/restore rehearsal, no migration tooling.
- No CI changes and no application code changes: this issue adds deployment configuration and documentation only.
