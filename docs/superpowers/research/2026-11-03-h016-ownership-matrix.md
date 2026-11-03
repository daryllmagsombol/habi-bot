# H-016 — Tenant ownership boundary matrix (foundational slice)

- **Status:** Foundational slice implemented and tested. **#16 remains open; no acceptance is claimed and no security sign-off is given.** Only the boundaries that exist in this repository are enforced; every other boundary listed in the issue is recorded as pending against the issue that will implement it.
- **Date:** 2026-11-03
- **Phase:** P1 — Security (H-016, [#16](https://github.com/daryllmagsombol/habi-bot/issues/16)).
- **Scope:** A dependency-free, default-deny ownership helper, its adoption in the gated spike run service, focused tests, and this matrix. No authentication, database, queue, schema, file, event-stream, cache, or product feature was added.
- **Status vocabulary:**
  - **Enforced now** — a code path in this repository applies the check and a test in this slice or an existing suite exercises it.
  - **Pending** — no code path exists. Listing an issue is a dependency, not partial coverage.

## 1. What changed

| Path | Change |
|---|---|
| `apps/backend/src/ownership/ownership.ts` | New helper: `OwnedResource`, `OwnershipPolicy`, `assertOwned`, `assertOwnedById`, single `OwnershipDeniedError`, salted-hash audit event and sinks. Dependency-free except `node:crypto`. |
| `apps/backend/src/spike/spike-runs.service.ts` | `findOwnedRun` now delegates to `assertOwned` instead of comparing owners inline, and records denials to an injectable audit sink. No route, status code, or response shape changed. |
| `apps/backend/test/ownership-helper.smoke.mjs` | 14 tests: helper unit cases, audit behavior, service wiring, and an HTTP two-user matrix over the existing spike routes. |
| `docs/superpowers/research/2026-11-03-h016-ownership-matrix.md` | This matrix, residual risks, and remaining acceptance work. |

The existing `spike-isolation.smoke.mjs` suite was not edited or duplicated; it still runs unchanged and remains the fuller two-user route matrix.

## 2. Helper contract

```ts
interface OwnedResource { ownerUserId: string; deletedAt?: string | null }

interface OwnershipPolicy<T extends OwnedResource> {
  readonly resourceType: string;
  findById(id: string): T | undefined | Promise<T | undefined>;
}

assertOwned<T extends OwnedResource>({ actorUserId, resource }): T
assertOwnedById<T extends OwnedResource>({ actorUserId, id, policy }): Promise<T>
```

Decision rule: return the resource only when the actor id is a non-blank string, the resource exists, its server-recorded `ownerUserId` is non-blank and exactly equals the actor, and `deletedAt` is absent, `null`, or empty. Every other case throws one `OwnershipDeniedError` with `name`, `message`, and `code` all fixed to `ownership_denied`; there is no reason field, no existence detail, and no per-case subclass. `assertOwnedById` maps a not-found lookup onto the same error, so "unknown" and "not yours" are indistinguishable.

Audit:

```ts
{ event: 'ownership.denied', actorUserId, resourceType, resourceIdHash, at }
```

`resourceIdHash` is HMAC-SHA-256 of the raw id under a caller-supplied salt (`hashResourceId`); the raw resource id, resource content, and every other field are never recorded. There is no `reason` field because distinguishing `foreign` from `unknown` would recreate the enumeration oracle. A missing salt with a configured sink is a `TypeError` (programming error), not a default and not a grant. A sink that throws is swallowed so a denial can never become an allow or a distinguishable server error.

Deliberate non-features: no admin/service-account flag, no root/owner override, no `trusted` parameter, no "if internal then allow". A caller cannot pass a client-supplied owner field as authorization because the helper reads only `resource.ownerUserId` from the object it is given; callers are required to pass the server-loaded record. There is no HTTP coupling: status mapping is the caller's responsibility.

## 3. Boundary matrix

| # | Boundary (issue scope) | Enforced now | Enforcement point / evidence | Status | Next issue |
|---|---|---|---|---|---|
| 1 | API — run read, list, events, audit, tool attempt | Owner succeeds; foreign, unknown, deleted, and harness-id requests are denied identically | `findOwnedRun` → `assertOwned`; controller maps `undefined` to the existing 404. `ownership-helper.smoke.mjs` (HTTP matrix), `spike-isolation.smoke.mjs` (10 tests). Spike surface only, gated by `HABI_SPIKE_MODE=1`. | **Enforced now (spike)** | #25 for product acceptance |
| 2 | API — product conversations, messages, Bots, attachments | No product route exists | — | **Pending** | #19 (conversations/messages), #24 (Bot profiles), #26 (attachments) |
| 3 | Database predicates | No database, schema, or ORM exists | Only the in-memory run map does an owner lookup; `listOwnedRuns` filters `ownerUserId` in memory and does not exclude `deletedAt` rows (no delete path exists). | **Pending** | #19 (owner + conversation predicates, deleted-at filters, missing-predicate tests) |
| 4 | Queue payloads and worker lookups | No queue or worker ownership path | The worker is inert. | **Pending** | #22 (owner/conversation in payload, reject stale owner at execution) |
| 5 | File paths and object keys | No upload or object store exists | — | **Pending** | #26 (user/conversation prefixes, traversal and cross-prefix rejection) |
| 6 | Event streams and reconnect tokens | No streaming or replay endpoint exists | The run events route is an API read covered by row 1, not a stream. | **Pending** | #20 (stream/replay scoped to run owner and conversation) |
| 7 | Harness/session identifiers | Harness ids are never lookup keys and never accepted as authorization | `harness_…` in `:runId` returns 404 on every spike route (`ownership-helper.smoke.mjs`, `spike-isolation.smoke.mjs`); H-005 triage shows the harness has one trust domain (gateway key) and no per-user ownership. | **Enforced now (spike)**; product mapping **Pending** | #21 (server-side harness↔run mapping, never a bearer token) |
| 8 | Cache keys and invalidation | No cache exists | — | **Pending** | #19 and #22 (owner/conversation in keys; invalidate on deletion/transfer) |
| 9 | Conversation isolation under the same Bot | No product conversation or Bot resource exists | The spike's conversation id is an opaque field, not an authorization scope. | **Pending** | #19 with #24 |
| 10 | Audit visibility without existence leak | In-memory sink records one hash-only event per denial in the helper and spike service | `createInMemoryAuditSink`, `AuditSink`; tests assert exact event keys, one event per denial, no content, no raw id. | **In-memory only** | #19 (durable store) and #20 (authorized event exposure) |
| 11 | Deleted or transferred resources | Helper denies a non-empty `deletedAt` on the loaded record | Unit and service-wiring tests set `deletedAt` and assert denial. No delete/transfer operation exists to exercise end to end. | **Helper rule only**; stale-id paths **Pending** | #19, #32 |

## 4. Verification performed

| Command | Result |
|---|---|
| `pnpm --filter @habi/backend build` | pass |
| `pnpm --filter @habi/backend typecheck` | pass |
| `pnpm --filter @habi/backend lint` | pass |
| `node --test --test-concurrency=1 apps/backend/test/ownership-helper.smoke.mjs` | pass 14, fail 0 |
| `node --test --test-concurrency=1 apps/backend/test/spike-isolation.smoke.mjs` | pass 10, fail 0 (existing suite unchanged) |
| `pnpm --filter @habi/backend test` | pass 51, fail 0 (all backend smoke suites) |
| `pnpm exec turbo run test --force` | 8 tasks successful, 0 cached; backend 51 pass, 0 fail |
| `pnpm verify:foundation` | pass (frozen install, forced build, typecheck, lint, forced tests, graph checks) |

The tests cover: owner match allowed; foreign actor, unknown id, blank/missing actor, blank owner, and deleted resource all denied with one error shape; exactly one audit event per denial with exact keys, no content, and no raw id; deterministic salted hash and salt sensitivity; no admin/service-account/empty-actor/client-owner-field bypass; helper wiring in `SpikeRunsService`; unchanged HTTP contract and cross-user 404 equality; harness id rejected as a key; and a spoofed `ownerUserId` in the create body ignored.

## 5. Residual risks

1. **Adoption is voluntary, not structural.** Any future handler that reads storage directly bypasses the helper. There is no request pipeline or repository layer that forces the check; #19 must adopt it in every service method and test the storage layer with owner predicates.
2. **Spike-only exposure.** With `HABI_SPIKE_MODE` unset, no route uses the helper. "Enforced now" means the gated spike surface, not a product API.
3. **List paths differ from item paths.** `listOwnedRuns` filters by owner in memory rather than calling the helper, and does not filter `deletedAt`. List/search ownership must be a database predicate (#19), not a post-filter that can forget the deleted state.
4. **Error-to-response mapping is caller-owned.** The helper throws a domain error; the spike controller maps it to the non-enumerating 404. A future handler that forgets the mapping can produce a 500 (a denial, but an inconsistent and potentially noisy one) — never a grant. #25 should exercise denial shapes per route.
5. **Audit is in-memory and unreachable.** The default sink is created inside the service, is not exported, and is lost on restart. Denials are not currently visible to an operator. Durable, access-controlled audit needs #19, with #20 for exposure.
6. **Salt lifecycle.** The spike uses a per-process random salt, so hashes are not comparable across restarts. Cross-restart correlation would need a managed salt, which is a secret-lifecycle concern (#17), not a reason to log raw ids.
7. **Broken sinks fail closed but silently.** A throwing audit sink loses the event while still denying. This preserves the authorization outcome but is not an audit guarantee; the durable implementation must define failure handling and monitoring.
8. **No transfer semantics.** `deletedAt` is a convention on the record the helper receives. There is no deleted/transferred state in storage, no transaction, and no stale-identifier test end to end.
9. **No abuse controls.** Any authenticated actor can generate denial audit volume. Rate limiting and alert thresholds are outside this slice and unset.
10. **Admin/service access is unmodelled.** The helper has no bypass, which satisfies default deny now. A future operator/admin feature must model privileged access explicitly (audited, scoped) instead of adding a flag to this helper.
11. **Resource provenance is a contract, not a type.** `ownerUserId` is trusted once present on the object. A mapper that builds resources from request JSON would defeat the check; only the spike's create-body test covers that class today.

## 6. What acceptance still requires

| #16 acceptance criterion | Status |
|---|---|
| Every listed boundary has an ownership check and a negative test | **Not met.** Only the API run boundary and harness-id-as-key are enforced (spike fidelity); DB/queue/files/events/cache do not exist. |
| Cross-user access denied consistently with a non-enumerating error | **Partially met at spike fidelity.** The helper and spike routes use one shape; product routes are untested. |
| Conversations isolated by default under the same Bot | **Not met.** No conversation or Bot resource exists. |
| Queue, cache, file, event, and harness identifiers are not sufficient authorization | **Only harness ids proven.** The rest do not exist. |
| Authorization failures audit-visible without leaking existence | **Not met.** Hash-only events are produced in memory but not durable or visible. |
| Deleted or transferred resources cannot be read through stale identifiers | **Not met.** The helper rule exists; no delete/transfer path or storage predicate does. |
| Security review accepts the matrix as an exposure gate | **Not met.** This note is engineering evidence and an inventory, not a review. |

Also still required by the issue's work checklist: two-user tests for read, write, list, search, download, cancel, steer, and event replay (#25 over #19/#20/#22/#26), and negative tests for guessed ids and modified payloads on each product surface. This slice covers only read/list/item-access equivalents that exist in the spike.

## 7. Non-claims

No production readiness, no tenant-isolation guarantee, no authentication quality, no persistence or concurrency result, no real harness wiring, no queue/file/cache/event enforcement, no durable audit, no legal or security sign-off, and no passed P1 gate. The helper is a mechanism awaiting adoption, not proof that every boundary is covered.

## 8. References

- [#16 — Enforce tenant ownership at every boundary](https://github.com/daryllmagsombol/habi-bot/issues/16)
- [H-002 object and context model](./2026-10-21-object-model-and-auth-constraints.md)
- [H-005 isolation triage](./2026-11-03-h005-isolation-triage.md)
- [P0 two-user ownership results](./2026-11-03-p0-spike-two-user-ownership-results.md)
- [H-006 no-tool boundary evidence](./2026-11-03-h006-no-tool-boundary-evidence.md)
- Code: `apps/backend/src/ownership/ownership.ts`, `apps/backend/src/spike/spike-runs.service.ts`
- Tests: `apps/backend/test/ownership-helper.smoke.mjs`, `apps/backend/test/spike-isolation.smoke.mjs`
