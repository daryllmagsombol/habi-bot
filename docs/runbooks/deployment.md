# Deployment runbook: staging and production compose stacks

Status: **not deployed.** This runbook describes and locally validates a Compose
topology. No remote host was contacted, no image was pushed or pulled from a
registry, and no DNS, certificate, email, or SSO configuration exists. Nothing
here proves a staging or production deployment.

It complements [`deploy/README.md`](../../deploy/README.md), which covers
topology, ports, caps, rollback, and the non-P1 owner decisions. This file is the
authoritative description of the **P1 wiring**: which variables each stack
passes, what each P1 flag means, why a value is required, and what the health
probes actually assert. Where the two disagree on the worker health check or the
required-value table, this file is current.

## What the stacks now provide

Both `compose.staging.yaml` and `compose.production.yaml` start a stack that can
actually run P1, not only `/health`:

| Service | P1 wiring |
|---|---|
| `postgres` | unchanged private database, no published port |
| `migrate` | one-shot, profile-gated runner for the real `migrations/` schema |
| `api` | `DATABASE_URL`, session/auth gates, `/api` surface when `HABI_P1_API=1` |
| `worker` | `HABI_P1_WORKER` plus the Hermes provider pair; runs `dist/worker.js` |
| `web` | `HABI_API_URL` and `HABI_AUTH_API_URL` so the same-origin BFF reaches the API |

Staging defaults to flag-on (it exists to validate P1). Production defaults every
P1 gate to off: enabling a P1 surface in production is an owner decision, and
this file never makes it silently.

## Required values

Any value declared with `${VAR:?message}` fails interpolation with that message
when it is absent. Compose does not start half-configured.

| Variable | Staging | Production | Notes |
|---|---|---|---|
| `POSTGRES_PASSWORD` | required | required | inject at deploy time; never commit it |
| `HABI_IMAGE_TAG` | optional, defaults to `staging` | required | immutable CI tag; never `latest` |
| `HABI_HERMES_BASE_URL` | required | optional, default empty | provider endpoint the worker calls |
| `HABI_HERMES_GATEWAY_KEY` | required | optional, default empty | provider credential; injected only |
| `POSTGRES_DB` / `POSTGRES_USER` | defaults `habi` / `habi` | same | interpolation defaults |
| `HABI_*_SPIKE`, `HABI_P1_API`, `HABI_P1_WORKER` | default `1` (worker hard-coded `1`) | default `0` | see the flag table |
| `HABI_REGISTRATION_MODE` | default `invite` | default `invite` | `closed` refuses signups |
| `HABI_LOG_LEVEL` | default `info` | default `info` | `debug`, `info`, `warn`, `error` |
| `HABI_API_URL`, `HABI_AUTH_API_URL` | default `http://api:3001` | same | web-side server origins |
| `API_HOST_PORT` / `WEB_HOST_PORT` | default 3001 / 3000 | same | loopback-bound |

`DATABASE_URL` is not a separate secret. Each P1 process derives it from the same
`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` values the database receives,
with the compose service host `postgres` and port 5432, never `localhost`. That
removes a duplicate credential and a mismatch class of bug, at one cost: the
password must be URL-safe (letters, digits, `-_.~`) or percent-encoded, because
it is embedded in a URL.

Production keeps `HABI_HERMES_BASE_URL`/`HABI_HERMES_GATEWAY_KEY` optional
because its worker gate defaults to off. Setting `HABI_P1_WORKER=1` without both
values makes the worker probe fail; the runner also throws when only one is set.

## P1 flags

Each flag is read once at process start. Only the exact value `1` enables a
surface; anything else, including unset, leaves it out of the application, so a
typo cannot half-enable a module.

| Flag | What `1` adds | Staging default | Production default |
|---|---|---|---|
| `HABI_P1_API` | `/api` chat routes (they still require an H-017 session) | `1` | `0` |
| `HABI_P1_WORKER` | the worker claim loop; `DATABASE_URL` becomes required | `1` (hard-coded) | `0` |
| `HABI_SESSION_SPIKE` | `/session-spike` fixture routes over the shared session core | `1` | `0` |
| `HABI_AUTH_SPIKE` | `/auth` signup/login/logout/recovery routes | `1` | `0` |

These are composition gates, **not product authentication**. `/api` always
requires a validated session cookie; enabling `HABI_P1_API` without a session
source yields a surface that answers `401`, not an open one. Enabling
`HABI_SESSION_SPIKE` exposes fixture logins (`session-fixture-a`,
`session-fixture-b`) that verify no password — they exist for tests and staging
validation, and that is why production defaults the flag off.

`HABI_REGISTRATION_MODE=invite` is the code default. `closed` refuses signups and
leaves login and recovery unchanged. Public registration is not implemented.

## Applying migrations first

The images contain compiled code only; they do not carry `migrations/`. The
probes assert `schema_migrations` exists, so the schema step is required before
the stack can report healthy:

```bash
docker compose -f compose.staging.yaml --profile tools run --rm migrate
```

The `migrate` service is profile-gated, so `up` never runs it. It uses the API
image with `entrypoint: ["node", "/app/scripts/db/migrate.mjs"]` and mounts
`./migrations` and `./scripts/db` read-only from the checkout. The checkout must
be the same revision as the image tag; a mismatched checkout applies different
SQL than the image expects. The runner tracks applied files in
`schema_migrations`, is idempotent, and serializes concurrent runs with an
advisory lock.

## What the health probes assert

A probe that only calls `/health` would report a flag-off API as healthy. These
probes are readiness checks for the deployed intent:

| Probe | Passes when | Cannot assert |
|---|---|---|
| `api` | `/health` is 200; `/api/bots` answers `401` when `HABI_P1_API=1` and `404` when it is `0`; with the flag on, the database answers a `schema_migrations` query | that a user can sign in, or that a real Run succeeds |
| `web` | `/` renders; with `HABI_P1_API=1` the same-origin `/api/bots` BFF returns 401/403 (a live upstream), not 404/502/503 | browser rendering, TLS, or a public origin |
| `worker` | with `HABI_P1_WORKER=1`: the provider pair is present and the database answers a `schema_migrations` query; with `0` the inert worker is intentionally healthy | that the claim loop is finding work; there is no heartbeat metric yet |

The API probe fails when the surface and the flag disagree in either direction,
so a stack cannot be declared healthy merely because the process is listening.
The worker publishes no port; a crash exits the container and `restart:
unless-stopped` restarts it, which is visible in `docker compose ps`.

## Origins and CSRF

There is no `HABI_WEB_ORIGIN` variable in this commit: no code reads one, so
declaring it would be configuration that silently does nothing. What exists:

- The browser only calls the web origin. `/api/**` and `/api/auth/**` are
  same-origin BFF routes; both forward to `HABI_API_URL`/`HABI_AUTH_API_URL`,
  which are server-only values and never enter a client bundle.
- The BFF asserts `Origin` to the API origin before forwarding, and the API's
  `SessionCsrfGuard` compares the request `Origin`/`Referer` host with its own
  `Host` header, rejecting a mismatch with `403 csrf_invalid`. In `NODE_ENV=
  production` an absent Origin/Referer is also rejected.
- Both stacks set these origins explicitly to `http://api:3001` and keep the API
  and web ports bound to `127.0.0.1`.

A public deployment therefore needs one web origin whose proxy reaches the API
so the Host/Origin comparison holds. That proxy, domain, and TLS decision is
still open; nothing here terminates TLS.

## Verification performed for this change

On 2026-11-05, on a macOS workstation with the standalone Compose binary
(`docker-compose` 5.7.0; the `docker compose` plugin is not installed on that
host):

```bash
# throwaway env file outside the repository
docker-compose --env-file "$TMP/dummy.env" -f compose.staging.yaml config --quiet
docker-compose --env-file "$TMP/dummy.env" -f compose.production.yaml config --quiet
# both exit 0

node --test scripts/ci/compose.test.mjs
# 11 tests, 11 pass, 0 fail
```

The dummy env file was created under the OS temp directory and deleted; it
contained no real credential. The same test asserts that a missing
`POSTGRES_PASSWORD` makes `config` exit non-zero with a message naming the
variable. No image was built and no container was started: this validates the
file contract, not runtime behaviour on a host.

The probe commands were also extracted from the files and executed against a
local HTTP stub (flag on/off, surface present/absent, upstream 401/404/503,
provider pair present/absent, database unreachable). They exited as documented
above. That exercised the probe logic, not the containers.

## Owner decisions still required

| Decision | Current state | What it blocks |
|---|---|---|
| Hermes provider endpoint and gateway key | not provided | a worker that claims and dispatches Runs |
| Image registry, distribution, retention, and the production tag | not decided | production `pull`, and therefore any production start |
| Public domain, DNS, reverse proxy, TLS certificate | not decided | public access; the API and web stay loopback-only |
| Production P1 gates (`HABI_P1_API`, `HABI_P1_WORKER`, session/auth) | default off | any production P1 surface; the owner must set them |
| Registration mode in production | defaults to `invite` | whether signups are open, invite-only, or `closed` |
| Session durability | in-memory, per process | restart drops every session; a durable store is not implemented |
| Backup, restore, and migration policy | tooling exists, restore not rehearsed | disaster recovery (see [`backups.md`](./backups.md)) |
| Deploy host, access, and who runs a release | not decided | executing any command in this runbook against a real host |

Until those are decided and a real run is recorded, describe these files as an
**authored and locally validated P1 deployment candidate**, not a deployment.
