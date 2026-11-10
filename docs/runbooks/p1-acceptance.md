# P1 acceptance runbook (H-025 / issue #25)

This runbook operates the repeatable H-025 acceptance harness. The harness
executes every scenario that can run without a deployed staging VM, records
`pass | fail | blocked` with evidence, and leaves the P1 exit decision to the
owner.

The harness never declares a go. A run with zero failures but blocked scenarios
is **incomplete acceptance evidence**, not a pass.

## Command

```sh
node scripts/acceptance/run.mjs
```

Useful forms:

```sh
node scripts/acceptance/run.mjs --list
node scripts/acceptance/run.mjs --scenario isolation,auth
node scripts/acceptance/run.mjs --scenario backup-restore --out /tmp/habi-acceptance
node scripts/acceptance/run.mjs --build
```

- `--scenario <ids>` runs only the named scenarios. A filtered run is diagnostic;
  it is not a full acceptance run.
- `--out <dir>` writes the two reports to that directory. The default is a fresh
  directory under the OS temp directory. Do not write reports into the repository
  tree.
- `--build` rebuilds `@habi/contracts` and `@habi/backend` first. Without it, the
  harness builds only when `apps/backend/dist` is missing.
- `--keep` leaves the disposable PostgreSQL container running for inspection and
  prints its name. It never prints the database URL or password. Remove the
  container manually when finished.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | No scenario failed. Blocked scenarios may remain; the summary says they are not acceptance. |
| `1` | At least one scenario failed. Do not treat the run as a P1 go. |
| `2` | Usage or environment error before scenarios could run (for example, a failed build). |

The harness writes `acceptance-report.json` (machine-readable) and
`acceptance-report.md` (matrix and evidence summary) and prints the matrix to
stdout.

## What the harness boots

1. One disposable `postgres:18.6-alpine` container on an ephemeral loopback port,
   with a random password that is never logged or reported.
2. The real SQL migrations in `migrations/`, through `scripts/db/migrate.mjs`.
3. Two fixture accounts and their Bot, conversation, message, Run, event,
   artifact, attachment, memory, skill, and search data. Accounts are inserted
   as local rows; every owned resource is created through the real service
   classes.
4. The real compiled Nest API. The chat surface runs in-process with only
   `HABI_P1_API=1`; the auth surface runs in a child process with
   `HABI_AUTH_SPIKE=1` so each module's in-memory session store is exercised as
   deployed.
5. The real compiled worker (`dist/worker.js`) where a scenario needs execution,
   pointed at a local Hermes-compatible HTTP stub. The stub implements create,
   status, SSE events, stop, and steer. It is a test double at the documented
   adapter boundary: no real provider, credential, or paid call is involved.

Teardown always stops children, closes the in-process app and stub, removes the
temporary storage directory, and removes the container. A scenario failure does
not skip teardown.

## Statuses

| Status | Meaning |
| --- | --- |
| `pass` | The check ran and the observed behavior met the requirement. |
| `fail` | The check ran and the behavior did not meet the requirement. Failures are never converted to blockers. |
| `blocked` | The check could not run (no host, no provider registration, missing tool), or the product deliberately does not expose the capability yet. The reason and evidence are recorded. |

Scenario status is the worst check status: any `fail` makes the scenario `fail`;
otherwise any `blocked` makes it `blocked`; otherwise `pass`.

### Docker unavailable

If `docker info` fails, every Docker-dependent scenario is reported `blocked`
with the reason “Docker daemon unavailable”. The VM-impact scenario still runs
and remains blocked unless a host is configured. The harness exits `0` because
nothing failed, and the summary explicitly says a blocked run is not acceptance.
It never reports a skip as a pass.

## Environment freeze

The report records, before scenarios mutate the process environment:

- repository commit and whether the worktree was dirty;
- Node and platform;
- Docker server version and the PostgreSQL image with its local digest, when
  available;
- the number of migrations applied;
- whether `pg_dump`, `pg_restore`, and `psql` are present;
- presence or absence of every relevant configuration key, with the literal
  value `present (value not recorded)` or `absent`. Values are never written.

Keys checked include `DATABASE_URL`, the `HABI_P1_*` flags, `HABI_AUTH_SPIKE`,
`HABI_REGISTRATION_MODE`, the Hermes base URL/key and timeouts, worker tuning
values, every required SSO registration key (including the Microsoft issuer),
`HABI_ACCEPTANCE_VM_HOST`.

To reproduce on a staging VM, the VM must already run the Compose stack with the
P1 chat, worker, and auth flags and a database URL in its environment. The
harness itself only uses a disposable local database; it does not deploy.
`HABI_ACCEPTANCE_VM_HOST` enables the VM-impact check. That check is read-only:
it verifies SSH reachability, looks for Habi containers, and samples
`docker stats --no-stream`. It stays blocked when the stack is not running there
or when a configured host is unreachable.

## Evidence and redaction

Evidence is built from request/response statuses, closed error codes, resource
ids, sequence numbers, row counts, and adapter call counts. It does not contain:

- passwords, invite tokens, recovery tokens, CSRF tokens, session cookies, or
  bearer headers;
- the PostgreSQL password or a connection string with credentials;
- provider or SSO client secrets;
- real user data (fixtures are generated locally).

Two guards apply: scenarios avoid collecting credential values, and
`scripts/acceptance/lib/report.mjs` redacts sensitive keys and credential-bearing
strings (URL userinfo, `habi_session` cookies, bearer tokens) before writing.
Reports default to the OS temp directory, outside the repository.

The evidence bundle is the two report files plus the scenario names and ids in
them. Screenshots are not produced because the harness drives HTTP and SSE, not a
browser; browser/mobile rendering remains a web-lane check.

## Scenario map

| Scenario id | What runs | Where |
| --- | --- | --- |
| `isolation` | Two accounts; every P1 HTTP surface (`/api/bots`, Bot detail and threads, messages read/write, Run events, cancel) plus artifact, attachment, memory, skill, and search services. Foreign and malformed ids must all be the same `404 not_found`; foreign writes must not land. | `scenarios/isolation.mjs` |
| `auth` | Real signup with a seeded invite, single-use invite, uniform login failure, login, CSRF-guarded logout, recovery for known/unknown addresses, and session continuity into the chat surface. | `scenarios/auth.mjs` |
| `sso` | Provider advertisement and `/auth/sso/<provider>/start` routing. Each provider is blocked with the exact missing registration keys unless it is configured; a configured provider is still blocked at the callback without a real registration or stub IdP. | `scenarios/sso.mjs` |
| `reconnect` | Live SSE, disconnect after two events, continue the Run, reconnect with `Last-Event-ID`, assert no duplicate or lost sequence, and reject a cursor from another Run. | `scenarios/reconnect.mjs` |
| `run-lifecycle` | Duplicate submission, explicit user retry, pre-dispatch cancel, dispatched-cancel refusal, hard worker kill and recovery, bounded timeout, and graceful restart. Executed by the real worker against the local stub. | `scenarios/run-lifecycle.mjs` |
| `provider-exhaustion` | Stub HTTP 402 through the real Hermes adapter: failed with `provider_exhausted`, hold released, zero charged, one attempt, no fallback, and a later Run admitted. | `scenarios/provider-exhaustion.mjs` |
| `backup-restore` | `scripts/backup/pg-backup.sh`, then `scripts/backup/pg-restore-rehearsal.sh` with exact table counts. The rehearsal drops its target by design, so a second direct `pg_restore` is used to verify owner reads and seven cross-user denials after restore. | `scenarios/backup-restore.mjs` |
| `vm-impact` | Blocked with no host. With `HABI_ACCEPTANCE_VM_HOST`, a read-only SSH check and `docker stats` sample against the H-007 1.4 GiB / 1.5 vCPU ceilings. Never estimated. | `scenarios/vm-impact.mjs` |

## What this harness does not prove

- It does not run against a deployed staging VM. Deployed compose wiring,
  reverse-proxy behavior, real TLS, and host-level resource impact remain
  unverified unless a host is configured and the stack is actually running.
- It does not call a real provider, so vendor billing, rate-limit, and latency
  behavior are out of scope. Provider outcomes are proven against the real
  adapter with a local stub.
- It does not perform a real SSO sign-in. A provider without registered client
  credentials is an external blocker; a configured provider only proves routing.
- It does not send email. Recovery records a hashed token but delivery is not
  implemented.
- It does not run a browser or measure mobile rendering; mobile behavior here is
  the SSE reconnect contract.
- It does not measure sustained load or peak-hour CPU. A single VM sample is not
  a capacity pass.
- The backup timestamp and archive are disposable; this is not a production
  restore drill.

## Residual risks and known gaps to carry into a real deployment

1. **Sessions are non-durable.** They are in-memory and per-process, so a
   restart drops every session. Backup restore therefore verifies ownership at
   the data/service layer, not a replayed browser session. (#98 made one
   session authority per process; durability is a separate, still-open gap.)
2. **A hard worker kill leaves provider output after the last persisted event
   unrecoverable.** The Run becomes `execution_uncertain` and is not
   re-dispatched, to avoid duplicate paid work. A deliberate safety tradeoff,
   not a silent success.
3. **No stack has been *deployed*.** `compose.staging.yaml` has now been built
   and started locally, which retires the "never booted" part of this risk:
   all four services reached `healthy`, the migrate service applied 18
   migrations on a fresh database, `GET /api/bots` answered `401` without a
   session and `200` with one, `GET /api/account` returned the six identity
   fields, and a write through the web BFF succeeded while the same write
   direct to the API with a mismatched `Origin` was refused `403 csrf_invalid`.
   What remains owner-held is a **deployed** run: a host, a registry, an
   immutable `HABI_IMAGE_TAG`, and the production flag decisions. A local boot
   is evidence the stack is coherent, not that it survives a real deployment.

   Note for whoever reproduces this: the images need more memory than the
   2 GiB default this repository's Docker VM had — the build is OOM-killed
   (exit 137) below roughly 4 GiB.

Closed since this runbook was written, recorded so the history is traceable:

- **Login sessions reach the P1 chat surface** — one `SessionCoreModule` owns
  the service, its clock and both guards (#98). The `auth` scenario is 7/7.
- **Dispatched runs can be cancelled** — `POST /api/runs/:id/cancel` records a
  durable intent and the owning worker claims it atomically, calls
  `adapter.cancel` at most once, and terminalizes honestly (#99). The
  `run-lifecycle` scenario is 7/7.
- **Every terminalization appends exactly one terminal event**, including
  pre-dispatch cancel, through the shared `runs/finalization.ts` path (#99).
- **Artifacts, attachments, memories, skills and search are exposed over
  HTTP** with two-account isolation proven per route (#101). The `isolation`
  scenario is 12/12.

## P1 exit

P1 exit is an owner decision after reviewing the complete matrix, blockers,
residual risks, and a deployed-stack run. This harness does not declare go, does
not move issues, and does not authorize P2. A run with a failure is a stop; a run
with blockers remains incomplete even when the exit code is `0`.
