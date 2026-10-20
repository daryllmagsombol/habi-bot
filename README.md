# Habi

> **Weave ideas into action.**

Habi is planned as a mobile-first, multi-user conversational AI workspace for private chats with customizable Bots. The first product is a browser experience for mobile and desktop: sign in, choose or create a Bot, and hold a private conversation.

## Current status

The repository now contains a **runnable development foundation**, not a usable product. The workspace, web shell, API health endpoint, headless worker entrypoint, shared packages, and local PostgreSQL Compose configuration are implemented. Application smoke tests pass; Compose CLI validation requires the Docker Compose plugin. Authentication, chat, Bots, model calls, Hermes, persistence, queues, and deployment are not implemented.

GitHub Actions now runs the foundation verification and both focused OpenCode review and SonarQube workflow test suites. The SonarQube scan itself is optional and configuration-gated; no live analysis result is claimed.

- **Repository:** [daryllmagsombol/habi-bot](https://github.com/daryllmagsombol/habi-bot)
- **Roadmap board:** [Habi Roadmap, Project #1](https://github.com/users/daryllmagsombol/projects/1)
- **Issues:** [H-001 through H-046](https://github.com/daryllmagsombol/habi-bot/issues)
- **Foundation design:** [2026-10-19 initial foundation design](docs/superpowers/specs/2026-10-19-initial-foundation-design.md)
- **Implementation plan:** [2026-10-19 initial foundation plan](docs/superpowers/plans/2026-10-19-initial-foundation.md)
- **Execution ledger:** [Foundation progress ledger](docs/superpowers/plans/2026-10-19-initial-foundation-progress.md)
- **Source:** Habi product and engineering handoff, October 18, 2026 (Asia/Manila).

The foundation is a tooling-only exception to the P0 sequence. **H-009 remains open**, no phase gate has passed, and no P0 or P1 issue is complete merely because this foundation exists. The GitHub issue text is a work specification, not evidence that a feature exists.

### Implemented

- One pnpm workspace orchestrated by Turborepo with a single lockfile and exact dependency pins.
- A minimal Next.js 16, React 19, and Tailwind CSS 4 web shell with an honest foundation notice. It has no sign-in, chat, Bot, model, or Hermes behavior.
- A NestJS 12 API with a loopback health endpoint on port 3001.
- A separate NestJS headless worker entrypoint that opens no HTTP listener, performs no polling or provider connections, and exits cleanly on `SIGTERM` or `SIGINT`.
- Shared `@habi/contracts` and `@habi/config` packages. The contract is type-only; the compiled runtime module is intentionally empty.
- A local-only PostgreSQL 18 Compose service with loopback binding, a healthcheck, resource caps, and a named volume.
- Smoke tests for the API health response, invalid API configuration, worker lifecycle and inertness, and the honest web page.
- GitHub Actions foundation verification, read-only OpenCode review automation, and focused SonarQube workflow checks. The SonarQube scan is optional and configuration-gated.

### Not implemented

- Email/password or Google, Microsoft, and Facebook authentication, sessions, or authorization.
- Users, workspaces, Bots, conversations, messages, memory, attachments, or artifacts.
- Model calls, provider selection, Hermes, or any agent runtime.
- Database schema, migrations, ORM, durable queue, cache, or background jobs.
- Release automation, application container images, Nginx, Cloudflare, backups, or production deployment.
- Bun launch paths or Bun benchmarks. Node.js is the baseline.

The PostgreSQL service is tooling-only. The API and worker do not connect to it yet.

## Quick start

**Prerequisites:** the Node.js version in [`.node-version`](.node-version), the pnpm version in [`package.json`](package.json) (`packageManager`), and the Docker Compose CLI plugin if you want the local database. Bun is deferred.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Run the development workspace:

```bash
pnpm dev
```

- Web shell: `http://127.0.0.1:3000`
- API health: `http://127.0.0.1:3001/health`

The health response is exactly:

```json
{ "status": "ok", "service": "api" }
```

Run the API or web production entrypoints after a build:

```bash
pnpm --filter @habi/backend start
pnpm --filter @habi/web start
```

Run the headless worker after building the backend:

```bash
pnpm --filter @habi/backend start:worker
```

The worker has no HTTP port and no provider connection. Stop it with `SIGTERM` or `SIGINT`. It should exit `0` without hanging.

Start local PostgreSQL:

```bash
cp .env.example .env
# Set a local-only POSTGRES_PASSWORD in .env. Never commit .env.
docker compose up -d --wait postgres
docker compose down
```

`docker compose down` does not delete the named volume. Compose requires the Docker Compose plugin. The API and worker do not use this database yet, and no real password is committed.

Run the integrated foundation check:

```bash
pnpm verify:foundation
```

This runs the focused verification-runner tests, rejects application dotenv files before install/build (a root `.env` for local Compose is allowed), performs a fresh forced Turbo build with provider and database credentials stripped, typecheck, lint, forced tests, and Turbo graph assertions for build/dev ordering. Ordinary `pnpm build` remains cacheable. It deliberately does not perform destructive clean-install automation; successful forced compilation is not a clean-install proof.

Run only the focused runner checks with:

```bash
pnpm test:verification
```

## Automation and agent guidance

- [CI workflow](.github/workflows/ci.yml) runs `pnpm verify:foundation`, `node --test .github/scripts/review.test.mjs`, and `node --test scripts/ci/sonarqube.test.mjs`.
- [OpenCode pull-request review](docs/ci/opencode-review.md) is read-only and informational. It loads only its three trusted base prompts; it does not load `AGENTS.md`, native skills, or the Sonar guidelines automatically. Editing guidance does not change review policy; trusted prompt changes require a separately reviewed manual update.
- [SonarQube operations](docs/ci/sonarqube.md) cover the optional self-hosted scan, variables, TLS/certificate handling, and configuration-gated behavior. The workflow uses the standalone analyzer config `tsconfig.sonar.json`. Missing configuration skips; configured results may pass or fail. No live SonarQube result, LCOV coverage, or numeric server-gate mandate is claimed.
- [SonarQube engineering guidelines](docs/SONAR_GUIDELINES.md) are pragmatic repository guidance, not a server quality profile.
- [AGENTS.md](AGENTS.md) contains the project-specific agent instructions.
- Focused workflow checks are `node --test .github/scripts/review.test.mjs` and `node --test scripts/ci/sonarqube.test.mjs`. These are distinct from `pnpm test` and `pnpm test:verification`.

## Intended journey

This is the product intent, not current functionality:

1. **Landing** — understand the product and its POC boundary.
2. **Signup or login** — email/password or Google, Microsoft, or Facebook SSO.
3. **Workspace** — enter a personal workspace and see existing Bots and conversations.
4. **Choose a Bot** — create or select a Bot with a name, description, avatar fallback, and Markdown instructions.
5. **Private conversation** — exchange messages in a conversation that is isolated by default.

SSO proves identity only. Mailbox, calendar, and file permissions require a separate, explicit future consent flow. Persistent memory and project-wide context require deliberate opt-in and visible controls. Bot Markdown can guide style and workflow, but it never grants permissions.

## POC scope

The planned POC is a usable private chat product. **None of the product capabilities below are implemented in the current foundation.**

- Browser-based, responsive on mobile and desktop.
- Email/password authentication plus Google, Microsoft, and Facebook sign-in.
- Private conversations with customizable Bots.
- Backend-enforced tenant isolation and a no-tool policy.
- Durable run lifecycle, cancellation, retry, and reconnect recovery.
- Scoped attachments, bounded extraction and citations, and downloadable text/Markdown artifacts in P2.
- Explicit memory controls, owned-history search, and reusable Markdown skills in P2.

The POC explicitly excludes arbitrary shell access, autonomous browsing, browser or computer use, sending messages, payments, external account actions, and job applications. Public-web search is undecided and must remain off unless a later decision explicitly enables it.

Future and research-only areas include scoped routines, projects and shared context, public-web research, multi-Bot handoffs, voice and image input, richer artifact formats, browser/computer workers, connectors, a job-application assistant, AWS migration, native clients, and team features. These are not POC commitments.

## Security and context boundaries

These requirements apply to all future product work:

- Accounts, conversations, attachments, Bot configurations, memories, sessions, queue jobs, caches, and artifacts must be isolated between users.
- Conversations must be isolated from one another by default, even when the same Bot is used.
- Persistent memory and project-wide context require deliberate opt-in; there must be no silent cross-conversation recall.
- Bot Markdown must be treated as untrusted guidance. Effective capability must be enforced by the backend and limited by the intersection of user identity, the Bot's allowed capabilities, and the selected conversation context.
- Every queued run must have an owner, conversation, idempotency key, status, timestamp, usage budget, and terminal outcome.
- Uploads are untrusted content. Scope them to the selected conversation, validate type and size, process them in a controlled environment, and never grant tools based on file contents.
- SSO identity and authorization for mail/files must remain separate. Provider account linking requires authenticated action and verification. Facebook may omit email.
- No keys, tokens, or secrets belong in the repository, frontend, ordinary chat, or task logs. Provider keys must stay server-side.
- A free provider reaching its limit must return a recoverable error. There must be no silent paid-provider fallback.
- Hermes must stay on a private application/API path. Its sessions, tools, and persisted memory require isolation testing before multi-user exposure.
- The POC is planned to have no arbitrary shell, browser, autonomous browsing, unsafe file tools, or unrelated MCP tools. The tool policy must be enforced independently of prompts and Bot Markdown.

## Architecture

### Implemented foundation

- One Git repository and a **pnpm workspace orchestrated by Turborepo**, with one lockfile and exact package versions.
- **Next.js, React, and Tailwind** for the responsive web shell.
- **NestJS** with separate API and worker entrypoints. The API exposes only `GET /health`; the worker is headless and inert.
- **`@habi/contracts`** for the shared, type-only health contract and **`@habi/config`** for shared TypeScript and ESLint configuration.
- **PostgreSQL 18** through a loopback-only local Compose service. The application does not connect to it yet.

### Planned product architecture

The broader product architecture from the handoff is still planned:

- **PostgreSQL** for relational data, chat messages, and JSONB metadata.
- A **PostgreSQL-backed durable queue**, such as pg-boss, for background runs. The initial plan does not add Redis or a NoSQL database.
- **Docker Compose** behind **Nginx** and **Cloudflare** for deployment.
- **Bun** may run Next.js and potentially compiled NestJS, but it is experimental here. Node launch scripts remain the fallback until dependency and production tests pass.

Habi, rather than Hermes, is intended to own identities, authorization, conversations, memory selection, task state, and spending policy. Module boundaries, APIs, storage abstractions, and durable job payloads should keep a later AWS migration possible without premature service splitting.

### Agent runtime — planned

- **Hermes** is the preferred harness in the plan, behind a replaceable adapter.
- Direct model calls are an evaluated fallback option, not a silent default.
- Initial model access is planned around **OpenCode Zen free models**, selected only after H-003 verifies the current model ID, limits, data handling, and Hermes compatibility.
- Automatic paid fallback must remain off. An OpenCode Go key is not assumed suitable for a multi-user general assistant.
- No model key or provider credential may be placed in the repository, frontend, ordinary chat, or task logs.

### Deployment constraints — planned

Initial hosting is planned for an existing shared VM with:

- four EPYC Rome vCPUs,
- 8 GB RAM,
- a 60 GB RAID SSD, and
- other applications already running on the host.

CI must build the images. Worker concurrency must be capped, containers must have memory and CPU limits, logs and artifacts must be bounded, and backups must be encrypted and stored off-VM. Baseline and peak resource use must be measured before enabling a browser worker or multiple simultaneous agent runs. AWS is a later option, not a current deployment.

## Repository layout

```text
habi-bot/
├── .github/
│   ├── review/              # trusted OpenCode review prompts
│   ├── scripts/             # review helpers and focused tests
│   └── workflows/           # ci.yml, opencode-review.yml, sonarqube.yml
├── apps/
│   ├── web/                 # Next.js web shell
│   └── backend/             # Nest API and headless worker
├── packages/
│   ├── contracts/           # @habi/contracts, compiled to dist
│   └── config/              # @habi/config, shared tsconfig and ESLint base
├── scripts/
│   ├── ci/                  # SonarQube workflow checks
│   └── verify-foundation*   # foundation runner and focused tests
├── docs/
│   ├── ci/                  # OpenCode review and SonarQube operations
│   ├── SONAR_GUIDELINES.md  # engineering guidance
│   └── superpowers/         # design, plan, and execution ledger
├── AGENTS.md                # project-specific agent guidance
├── compose.yaml             # local PostgreSQL only
├── sonar-project.properties
├── tsconfig.sonar.json      # analyzer-only TypeScript config
├── .env.example             # local PostgreSQL placeholders
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── turbo.json
```

There are no application Docker build contexts, production Compose stack, or release/deploy manifests yet. CI workflows exist; the SonarQube scan is optional and its live service result is unverified.

## Planning principles

- Keep modules narrow and use a single PostgreSQL database until a measured need justifies more.
- Implement access checks before exposing a record in an API, stream, tool, or download.
- Keep secrets server-side and never put user-controlled text into a privileged instruction channel.
- Block disallowed tools independently of prompts, Bot Markdown, or uploaded content.
- Preserve a Node launch path while Bun is evaluated.
- Record product and technical decisions when they change; do not treat experiments or research as commitments.
- Add future backlog items only when research identifies concrete scope.
- Treat issue acceptance evidence, not issue creation, as the signal that work is complete.

## Roadmap phases

The board has 46 issues. Phase counts are issue counts, not effort estimates. A later phase does not start automatically because its issues exist.

| Phase | Issues | Count | Exit gate |
|---|---|---:|---|
| **P0 — Feasibility** | [H-001](https://github.com/daryllmagsombol/habi-bot/issues/1) – [H-008](https://github.com/daryllmagsombol/habi-bot/issues/8) | 8 | H-001–H-008 accepted: provider evidence, Hermes lifecycle, multi-user isolation, no-tool policy, VM/Bun measurement, auth constraints, object model, and POC boundary. An H-005 isolation failure blocks launch. |
| **P1 — Usable private chat** | [H-009](https://github.com/daryllmagsombol/habi-bot/issues/9) – [H-025](https://github.com/daryllmagsombol/habi-bot/issues/25) | 17 | Monorepo, CI, deployment, backups, observability, identity, tenant ownership, chat, durable runs, limits, Bot profiles, and the H-025 acceptance suite with evidence. |
| **P2 — Useful conversations** | [H-026](https://github.com/daryllmagsombol/habi-bot/issues/26) – [H-032](https://github.com/daryllmagsombol/habi-bot/issues/32) | 7 | Scoped attachments, bounded extraction and citations, artifacts, owned-history search, explicit memory controls, Markdown skills, and export/delete, with security evidence. No P3 issue starts automatically. |
| **P3 — Repeatable scoped workflows** | [H-033](https://github.com/daryllmagsombol/habi-bot/issues/33) – [H-035](https://github.com/daryllmagsombol/habi-bot/issues/35) | 3 | Scoped-routine design and go/no-go, scheduled routine implementation with no external side effects, and in-app notifications first. |
| **P4 — Optional capabilities** | [H-036](https://github.com/daryllmagsombol/habi-bot/issues/36) – [H-043](https://github.com/daryllmagsombol/habi-bot/issues/43) | 8 | Research-first decisions and explicit go/no-go gates for projects/shared context, public-web research, multi-Bot handoffs, voice/image, richer artifacts, browser/computer worker, connectors, and job applications. |
| **P5 — Expansion** | [H-044](https://github.com/daryllmagsombol/habi-bot/issues/44) – [H-046](https://github.com/daryllmagsombol/habi-bot/issues/46) | 3 | Research-first decisions and go/no-go gates for AWS migration, native clients, and team features. No dates or delivery commitments. |

## Using the board

The project has four views: **Current P0–P2**, **Future P3–P5**, **All work**, and **Ready**. The views use board layouts and filters. The public Projects API does not expose a mutation for view grouping, so **Group by: Status remains a manual one-time board setting**; do not assume the automated setup is a fully grouped kanban.

Status meanings:

- **Backlog** — Scoped but not ready. Dependencies, phase gates, or external prerequisites are not satisfied.
- **Ready** — The phase gate is met, hard dependencies are accepted, external prerequisites are evidenced, and an owner has capacity. Moving to Ready is deliberate, not a bulk action.
- **In progress** — Work has started and evidence is being produced.
- **Review** — Work is complete enough for review; acceptance evidence is attached and independent verification is pending.
- **Blocked** — Work cannot proceed. Record the blocker and what would unblock it.
- **Done** — Acceptance criteria and the risk-based done rule are met with evidence. Code alone is not Done.

Only three issues are initially **Ready**:

- **H-001 — Lock POC boundary and user journeys** — no implementation dependency; the first planning gate.
- **H-003 — Verify Zen free provider** — requires confirmed OpenCode Zen account/API access. Access is a prerequisite, not evidence of provider behavior; record actual responses rather than fabricating results.
- **H-007 — Measure VM and Bun feasibility** — requires read-only access to the shared VM and current container/load data. Do not infer capacity from the handoff; record measurements.

Every other issue starts in Backlog. Creating or moving an issue does not authorize a later phase.

## Definition of done

A task is done when code, tests appropriate to the risk, user-visible behavior, observability, and documentation are complete. Security-sensitive changes need cross-user tests. Evidence must be attached to the issue: commands, test output, screenshots where relevant, and a clear pass/fail.

Research issues are done only when they produce a decision record, evidence, and a go/no-go. They are not done by starting an implementation. No issue may claim an implemented capability without evidence, and no status change starts a later phase automatically.

## P0 open decisions

These decisions remain open and should be settled during P0. Recommendations are from the handoff, not approved decisions.

1. Confirm the exact OpenCode Zen free endpoint and model, and what happens when quotas are exhausted.
2. Decide public registration versus invite-only for the first deployment. The handoff recommends invite-only on the shared VM until abuse controls are proven.
3. Decide which file types and maximum sizes P2 initially accepts. The handoff recommends text/Markdown and text PDFs first.
4. Decide whether a user can create unlimited Bots or starts with a small capped count.
5. Decide whether public-web research belongs in P1 or P4. The default is P4.
6. Measure Hermes' true cross-user memory and execution isolation. If it fails, use a segregated gateway/profile per user or switch to a simpler direct model adapter for P1.
7. Confirm the domain, reverse-proxy topology, current VM load, email sender, and SSO provider registrations before production rollout.

## Source and status

This README summarizes the approved planning handoff dated **October 18, 2026** and the current repository foundation. The board records issue state; the issues contain the actionable scope, dependencies, acceptance criteria, and evidence requirements.

The repository is a runnable foundation, not a product. H-009 remains open, no phase gate has passed, and no application feature is implied by the presence of the workspace or health endpoint. Foundation package versions are pinned in the manifests and lockfile; broader product choices remain open. The remote GitHub README may lag the local file until changes are pushed.

Decisions should be recorded in the relevant issue or decision note when they are made. No credentials, production domains, delivery dates, or license terms are established by this document.
