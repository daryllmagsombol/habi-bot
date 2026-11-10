/**
 * H-032 (#32) audit trail, Run reconciliation, and stale-access integration
 * smoke tests.
 *
 * Boots the real Nest application in-process with `HABI_AUTH_SPIKE=1` and
 * `HABI_P1_API=1` against an ephemeral PostgreSQL 18.6 container and the real
 * migrations, including 0018's `account_audit` table and append-only guard.
 * Accounts are created through the real signup route and seeded through the
 * real services, so every surface below is the product surface.
 *
 * Coverage:
 *   audit        an export writes one row with the section counts its manifest
 *                reported; the row carries no message/memory/artifact/skill
 *                body, email, credential, token, or storage key
 *   scoping      the owner reads their own trail and never another account's;
 *                query parameters cannot select an account
 *   refusal      a wrong confirmation is refused, audited, and changes nothing;
 *                the refused row is later removed with the account
 *   reconcile    a non-terminal Run receives the durable cancel intent
 *                (`requestCancel`) and a present worker terminalizes it inside
 *                the wait bound
 *   unreachable  with no worker, the deletion reports `unreconciledRuns`
 *                instead of claiming the Run was stopped
 *   retention    the deletion record survives the deletion with a NULL owner
 *                while every owner-scoped audit row is removed
 *   stale        after deletion, every previously working surface returns the
 *                same non-enumerating refusal (401 for the revoked session,
 *                404 or an owner-filtered body for another account's ids)
 *   flag-off     `/api/account/audit` does not exist without `HABI_P1_API=1`
 *
 * Docker unavailability skips the suite; the container, pool, app, and temp
 * storage are removed afterwards. No provider or external service is used.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const PASSWORD = 'correct horse battery staple';
const REQUEST_TIMEOUT_MS = 20000;
const RUN_CANCEL_WAIT_MS = 1500;
const SESSION_COOKIE_PATTERN = /^(?:__Host-)?habi_session=/;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const NOT_FOUND = { error: { code: 'not_found' } };
const INVALID_INPUT = { error: { code: 'invalid_input' } };
const INVALID_CURSOR = { error: { code: 'invalid_cursor' } };
const NON_TERMINAL = ['queued', 'running', 'retry_wait'];

function dockerAvailable() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], { stdio: 'ignore' });

    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function run(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output.stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output.stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out\n${output.stderr}`));
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, ...output });
    });
  });
}

function migrate(databaseUrl, { dryRun = false } = {}) {
  const args = [MIGRATE_SCRIPT, '--database-url', databaseUrl];

  if (dryRun) {
    args.push('--dry-run');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPOSITORY_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output.stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output.stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, ...output }));
  });
}

async function waitForDatabase(pool) {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error('PostgreSQL did not become ready for the account audit suite.');
}

function readSession(response) {
  const setCookie = response.headers
    .getSetCookie()
    .find((cookie) => SESSION_COOKIE_PATTERN.test(cookie));

  assert.ok(setCookie, 'response did not set a session cookie');

  return {
    cookie: setCookie.split(';')[0],
    csrfToken: response.headers.get('x-csrf-token'),
  };
}

function createClient(base, session) {
  return async function request(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };

    if (options.cookie !== false && session?.cookie !== undefined) {
      headers.cookie = session.cookie;
    }

    if (options.csrf === true) {
      headers['x-csrf-token'] = session.csrfToken;
    }

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body;

    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return { status: response.status, headers: response.headers, body, text };
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a test port.')));
        return;
      }

      const { port } = address;

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

function captureOutput(child) {
  const output = { stdout: '', stderr: '' };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk;
  });

  return output;
}

function waitForEvent(child, eventName, output, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${eventName}.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', check);
      child.stderr.off('data', check);
      child.off('exit', onExit);
    }

    function check() {
      for (const line of `${output.stdout}\n${output.stderr}`.split(/\r?\n/)) {
        if (line.trim() === '') {
          continue;
        }

        try {
          const event = JSON.parse(line);
          if (typeof event === 'object' && event !== null && event.event === eventName) {
            cleanup();
            resolve(event);
            return;
          }
        } catch {
          // Not a structured log line; keep scanning.
        }
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(
        new Error(
          `Process exited before ${eventName} (code=${code}, signal=${signal}).\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }

    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', onExit);
    check();
  });
}

async function forceStop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGKILL');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 5000).unref?.();
  });
}

const dockerReady = await dockerAvailable();

describe(
  'H-032 account audit, Run reconciliation, and stale access (PostgreSQL)',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let app;
    let base = '';
    let storageRoot = '';
    let storage;
    let request;
    let services;
    let accounts;
    let sessions;
    let worker;

    async function insertInvite(email) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');

      await pool.query(
        `INSERT INTO invites (email, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [email, tokenHash],
      );

      return token;
    }

    async function signup(email) {
      const inviteToken = await insertInvite(email);
      const response = await request('/auth/signup', {
        method: 'POST',
        cookie: false,
        body: { email, password: PASSWORD, inviteToken },
      });

      assert.equal(response.status, 201, response.text);

      return { session: readSession(response), user: response.body.user };
    }

    async function login(email) {
      const response = await request('/auth/login', {
        method: 'POST',
        cookie: false,
        body: { email, password: PASSWORD },
      });

      assert.equal(response.status, 200, response.text);

      return readSession(response);
    }

    /**
     * Seeds one account through the real services. `withRun` creates a
     * non-terminal, already-dispatched Run so deletion has something to
     * reconcile.
     */
    async function seedAccount(label, userId, { withRun }) {
      const bot = await services.bots.create(userId, {
        name: `${label} Bot`,
        instructionsMarkdown: `# ${label} instructions`,
      });
      const conversation = await services.conversations.create(userId, {
        botId: bot.id,
        title: `${label} thread`,
      });
      const message = await services.messages.append(userId, {
        conversationId: conversation.id,
        role: 'user',
        content: `${label}-message-marker`,
        clientMessageId: `${label}-message-1`,
      });
      const artifact = await services.artifacts.create(userId, {
        kind: 'markdown',
        title: `${label} artifact`,
        content: `${label}-artifact-marker`,
        conversationId: conversation.id,
      });
      const skill = await services.skills.create(userId, {
        name: `${label} skill`,
        description: `${label}-skill-description`,
        bodyMarkdown: `${label}-skill-body-marker`,
      });

      let runId = null;

      if (withRun) {
        const posted = await services.api.postMessage(userId, conversation.id, {
          content: `${label}-run-message-marker`,
          clientMessageId: `${label}-run-message`,
        });

        runId = posted.runId;
        await pool.query(
          `UPDATE runs
              SET status = 'running',
                  dispatch_state = 'dispatched',
                  started_at = now()
            WHERE id = $1
              AND owner_user_id = $2`,
          [runId, userId],
        );
      }

      return {
        botId: bot.id,
        conversationId: conversation.id,
        messageId: message.id,
        artifactId: artifact.artifact.id,
        skillId: skill.id,
        runId,
      };
    }

    /**
     * A stand-in for a present worker: while running, it terminalizes any of
     * the given Runs that has a durable cancel intent. It records what it saw so
     * the test can prove the intent reached a worker.
     */
    function startWorker(runIds) {
      const seen = [];
      let stopped = false;
      let busy = false;
      const timer = setInterval(() => {
        if (stopped || busy) {
          return;
        }

        busy = true;
        pool
          .query(
            `UPDATE runs
                SET status = 'cancelled',
                    finished_at = now(),
                    updated_at = now()
              WHERE id = ANY($1::uuid[])
                AND status = ANY($2::text[])
                AND cancel_requested_at IS NOT NULL
              RETURNING id`,
            [runIds, NON_TERMINAL],
          )
          .then((result) => {
            for (const row of result.rows) {
              seen.push(row.id);
            }
          })
          .catch(() => {
            // Teardown closes the pool; a late poll is not a test failure.
          })
          .finally(() => {
            busy = false;
          });
      }, 20);
      timer.unref?.();

      return {
        seen,
        stop() {
          stopped = true;
          clearInterval(timer);
        },
      };
    }

    async function auditRows(ownerUserId) {
      const result = await pool.query(
        `SELECT id, owner_user_id, actor_user_id, action, outcome, detail
           FROM account_audit
          WHERE owner_user_id = $1
          ORDER BY id`,
        [ownerUserId],
      );

      return result.rows;
    }

    before(async () => {
      containerName = `habi-h032-audit-${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');
      const container = await run('docker', [
        'run',
        '-d',
        '--rm',
        '--tmpfs',
        '/var/lib/postgresql:rw,noexec,nosuid',
        '--name',
        containerName,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-e',
        `POSTGRES_USER=${DOCKER_USER}`,
        '-e',
        `POSTGRES_DB=${DOCKER_DATABASE}`,
        '-p',
        '127.0.0.1::5432',
        POSTGRES_IMAGE,
      ]);

      assert.equal(container.code, 0, container.stderr);

      const published = await run('docker', ['port', containerName, '5432/tcp']);
      assert.equal(published.code, 0, published.stderr);

      const port = Number.parseInt(
        published.stdout.trim().split(':').pop() ?? '',
        10,
      );
      assert.ok(Number.isInteger(port) && port > 0, 'Docker did not publish PostgreSQL');

      pool = new Pool({
        host: '127.0.0.1',
        port,
        user: DOCKER_USER,
        password,
        database: DOCKER_DATABASE,
        max: 8,
      });

      await waitForDatabase(pool);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const pending = await migrate(databaseUrl, { dryRun: true });
      assert.equal(pending.code, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0018_account_audit\.sql/);

      const applied = await migrate(databaseUrl);
      assert.equal(applied.code, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.match(applied.stdout, /applied\s+0017_account_deletion\.sql/);
      assert.match(applied.stdout, /applied\s+0018_account_audit\.sql/);

      storageRoot = await mkdtemp(join(tmpdir(), 'habi-h032-audit-storage-'));

      process.env.NODE_ENV = 'test';
      process.env.HABI_AUTH_SPIKE = '1';
      process.env.HABI_P1_API = '1';
      process.env.DATABASE_URL = databaseUrl;
      process.env.HABI_ATTACHMENT_STORAGE_ROOT = storageRoot;
      process.env.HABI_ACCOUNT_RUN_CANCEL_WAIT_MS = String(RUN_CANCEL_WAIT_MS);

      const { AppModule } = await import('../dist/app.module.js');
      const { NestFactory } = await import('@nestjs/core');
      const { BotService } = await import('../dist/bots/index.js');
      const { ConversationRepository, MessageRepository } = await import(
        '../dist/persistence/index.js'
      );
      const { ApiService } = await import('../dist/api/api-service.js');
      const { ArtifactService } = await import('../dist/artifacts/index.js');
      const { LocalAttachmentStorage } = await import(
        '../dist/attachments/index.js'
      );
      const { SkillService } = await import('../dist/skills/index.js');

      storage = new LocalAttachmentStorage(storageRoot);
      await storage.initialize();

      services = {
        bots: new BotService(pool),
        conversations: new ConversationRepository(pool),
        messages: new MessageRepository(pool),
        api: new ApiService(pool),
        artifacts: new ArtifactService(pool),
        skills: new SkillService(pool),
      };

      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0, '127.0.0.1');

      const address = app.getHttpServer().address();
      assert.ok(
        address !== null && typeof address === 'object',
        'the app did not bind a TCP port',
      );
      base = `http://127.0.0.1:${address.port}`;
      request = createClient(base);

      const signedUpA = await signup('audit-a@example.test');
      const signedUpB = await signup('audit-b@example.test');
      const signedUpC = await signup('audit-c@example.test');
      const emailA = signedUpA.user.email;
      const emailB = signedUpB.user.email;
      const emailC = signedUpC.user.email;

      accounts = {
        A: {
          userId: signedUpA.user.userId,
          email: emailA,
          ...(await seedAccount('alpha', signedUpA.user.userId, { withRun: true })),
        },
        B: {
          userId: signedUpB.user.userId,
          email: emailB,
          ...(await seedAccount('beta', signedUpB.user.userId, { withRun: false })),
        },
        C: {
          userId: signedUpC.user.userId,
          email: emailC,
          ...(await seedAccount('gamma', signedUpC.user.userId, { withRun: true })),
        },
      };

      sessions = {
        A: await login(emailA),
        A2: signedUpA.session,
        B: await login(emailB),
        C: await login(emailC),
      };
    });

    after(async () => {
      worker?.stop();

      if (app !== undefined) {
        await app.close().catch(() => {});
      }

      if (pool !== undefined) {
        await pool.end().catch(() => {});
      }

      if (storageRoot !== '') {
        await rm(storageRoot, { recursive: true, force: true });
      }

      if (containerName !== '') {
        await run('docker', ['rm', '-f', containerName], 30000);
      }
    });

    test('audit route requires a session and rejects an invalid cursor', async () => {
      const anonymous = createClient(base);
      const missing = await anonymous('/api/account/audit');
      assert.equal(missing.status, 401, missing.text);
      assert.deepEqual(missing.body, UNAUTHENTICATED);

      const client = createClient(base, sessions.A);
      const badCursor = await client('/api/account/audit?cursor=not-a-cursor');
      assert.equal(badCursor.status, 400, badCursor.text);
      assert.deepEqual(badCursor.body, INVALID_CURSOR);

      const badLimit = await client('/api/account/audit?limit=0');
      assert.equal(badLimit.status, 400, badLimit.text);
      assert.deepEqual(badLimit.body, INVALID_INPUT);
    });

    test('records an export with the reported section counts and no content', async () => {
      const exported = await createClient(base, sessions.A)('/api/account/export');
      assert.equal(exported.status, 200, exported.text);

      const document = JSON.parse(exported.text);
      const stored = await auditRows(accounts.A.userId);
      const entry = stored.find((row) => row.action === 'export');

      assert.ok(entry, 'no export audit row was written');
      assert.equal(entry.actor_user_id, accounts.A.userId);
      assert.equal(entry.outcome, 'requested');
      assert.deepEqual(
        entry.detail.sections,
        document.manifest.counts,
        'audit counts differ from the manifest it describes',
      );
      assert.equal(entry.detail.sections.bots, 1);
      assert.equal(entry.detail.sections.messages, 2);
      assert.equal(entry.detail.sections.artifacts, 1);
      assert.equal(entry.detail.sections.skills, 1);

      // Only counts and identifiers: no body, email, credential, or storage key.
      const serialized = JSON.stringify(entry);
      for (const forbidden of [
        'alpha-message-marker',
        'alpha-artifact-marker',
        'alpha-skill-body-marker',
        'alpha-run-message-marker',
        PASSWORD,
        accounts.A.email,
        'storageKey',
        'csrf',
        'token',
      ]) {
        assert.equal(
          serialized.includes(forbidden),
          false,
          `audit detail leaked ${forbidden}`,
        );
      }

      const route = await createClient(base, sessions.A)('/api/account/audit');
      assert.equal(route.status, 200, route.text);
      assert.equal(route.headers.get('cache-control'), 'no-store');
      assert.equal(route.body.nextCursor, null);
      assert.ok(Array.isArray(route.body.entries));
      assert.equal(route.body.entries.length, 1);
      assert.equal(route.body.entries[0].action, 'export');
      assert.equal(route.body.entries[0].outcome, 'requested');
      assert.deepEqual(route.body.entries[0].detail.sections, document.manifest.counts);
      assert.ok(!Number.isNaN(Date.parse(route.body.entries[0].requestedAt)));

      // B's own export is recorded against B, so the isolation test has data.
      const exportedB = await createClient(base, sessions.B)('/api/account/export');
      assert.equal(exportedB.status, 200, exportedB.text);
    });

    test('scopes audit reads to the session owner', async () => {
      const aClient = createClient(base, sessions.A);
      const bClient = createClient(base, sessions.B);

      const aEntries = (await aClient('/api/account/audit')).body.entries;
      const bEntries = (await bClient('/api/account/audit')).body.entries;

      assert.ok(aEntries.length > 0);
      assert.ok(bEntries.length > 0);
      assert.equal(
        aEntries.every((entry) => Number.isSafeInteger(Number(entry.id))),
        true,
      );
      const aIds = new Set(aEntries.map((entry) => entry.id));
      assert.equal(
        bEntries.some((entry) => aIds.has(entry.id)),
        false,
        'an audit row was readable by another account',
      );

      // A query parameter cannot select an account.
      const foreign = await aClient(
        `/api/account/audit?ownerUserId=${accounts.B.userId}&userId=${accounts.B.userId}`,
      );
      assert.equal(foreign.status, 200, foreign.text);
      assert.deepEqual(
        foreign.body.entries.map((entry) => entry.id),
        aEntries.map((entry) => entry.id),
      );

      const aStored = await auditRows(accounts.A.userId);
      const bStored = await auditRows(accounts.B.userId);
      assert.equal(aStored.every((row) => row.actor_user_id === accounts.A.userId), true);
      assert.equal(bStored.every((row) => row.actor_user_id === accounts.B.userId), true);
    });

    test('records a refused deletion without touching account data', async () => {
      const client = createClient(base, sessions.A);
      const before = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM bots WHERE owner_user_id = $1) AS bots,
           (SELECT count(*)::int FROM runs WHERE owner_user_id = $1) AS runs,
           (SELECT status FROM users WHERE id = $1) AS status`,
        [accounts.A.userId],
      );

      const missing = await client('/api/account', { method: 'DELETE', csrf: true });
      assert.equal(missing.status, 400, missing.text);
      assert.deepEqual(missing.body, INVALID_INPUT);

      const refused = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        body: { confirm: 'not-the-account-email@example.test' },
      });
      assert.equal(refused.status, 400, refused.text);
      assert.deepEqual(refused.body, INVALID_INPUT);

      const after = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM bots WHERE owner_user_id = $1) AS bots,
           (SELECT count(*)::int FROM runs WHERE owner_user_id = $1) AS runs,
           (SELECT status FROM users WHERE id = $1) AS status`,
        [accounts.A.userId],
      );
      assert.deepEqual(after.rows[0], before.rows[0]);

      const stored = await auditRows(accounts.A.userId);
      const refusals = stored.filter(
        (row) => row.action === 'delete' && row.outcome === 'refused',
      );
      assert.equal(refusals.length, 2, 'each refused deletion must be audited');
      assert.deepEqual(
        refusals.map((row) => row.detail.reason),
        ['confirmation_invalid', 'confirmation_mismatch'],
      );

      const trail = await client('/api/account/audit');
      assert.equal(trail.status, 200, trail.text);
      assert.equal(
        trail.body.entries.some(
          (entry) => entry.action === 'delete' && entry.outcome === 'refused',
        ),
        true,
      );

      // The Run keeps no cancel intent from a refused request.
      const run = await pool.query(
        'SELECT cancel_requested_at FROM runs WHERE id = $1',
        [accounts.A.runId],
      );
      assert.equal(run.rows[0].cancel_requested_at, null);
    });

    test('writes the cancel intent and reconciles a present worker', async () => {
      worker = startWorker([accounts.A.runId]);
      const client = createClient(base, sessions.A);

      const response = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        body: { confirm: accounts.A.email },
      });

      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.deleted, true);
      assert.equal(response.body.accountId, accounts.A.userId);
      assert.equal(response.body.alreadyDeleted, false);
      assert.ok(response.body.sessionsRevoked >= 2);

      assert.deepEqual(response.body.runReconciliation.unreconciledRuns, []);
      assert.equal(response.body.runReconciliation.requested, 1);
      assert.equal(response.body.runReconciliation.reconciled, 1);
      assert.ok(response.body.runReconciliation.waitedMillis >= 0);
      assert.equal(
        worker.seen.includes(accounts.A.runId),
        true,
        'the worker never observed the durable cancel intent',
      );

      // The account's Runs are gone with the rest of its data.
      const runs = await pool.query(
        'SELECT count(*)::int AS count FROM runs WHERE owner_user_id = $1',
        [accounts.A.userId],
      );
      assert.equal(runs.rows[0].count, 0);
    });

    test('keeps the deletion record while removing the account trail', async () => {
      const owned = await auditRows(accounts.A.userId);
      assert.deepEqual(owned, [], 'owner-scoped audit rows survived deletion');

      const surviving = await pool.query(
        `SELECT owner_user_id, actor_user_id, action, outcome, detail
           FROM account_audit
          WHERE owner_user_id IS NULL
            AND actor_user_id = $1`,
        [accounts.A.userId],
      );
      assert.equal(surviving.rowCount, 1);

      const record = surviving.rows[0];
      assert.equal(record.owner_user_id, null);
      assert.equal(record.action, 'delete');
      assert.equal(record.outcome, 'deleted');
      assert.equal(record.detail.removed.bots, 1);
      assert.equal(record.detail.removed.runs, 1);
      assert.equal(record.detail.runReconciliation.reconciled, 1);
      assert.deepEqual(record.detail.runReconciliation.unreconciledRuns, []);

      const serialized = JSON.stringify(record);
      for (const forbidden of [PASSWORD, accounts.A.email, 'alpha-message-marker']) {
        assert.equal(
          serialized.includes(forbidden),
          false,
          `deletion record leaked ${forbidden}`,
        );
      }

      // The surviving record is not readable through the owner-scoped route.
      const bTrail = await createClient(base, sessions.B)('/api/account/audit');
      assert.equal(bTrail.status, 200, bTrail.text);
      assert.equal(
        bTrail.body.entries.some((entry) => entry.outcome === 'deleted'),
        false,
        'a surviving deletion record was exposed to another account',
      );
    });

    test('reports unreconciledRuns instead of a false stop when no worker runs', async () => {
      worker?.stop();
      const client = createClient(base, sessions.C);

      const startedAt = Date.now();
      const response = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        body: { confirm: accounts.C.email },
      });
      const elapsed = Date.now() - startedAt;

      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.deleted, true);
      assert.equal(response.body.runReconciliation.requested, 1);
      assert.equal(response.body.runReconciliation.reconciled, 0);
      assert.deepEqual(response.body.runReconciliation.unreconciledRuns, [
        accounts.C.runId,
      ]);
      assert.ok(
        response.body.runReconciliation.waitedMillis >= RUN_CANCEL_WAIT_MS / 2,
        'the deletion did not wait for the configured bound',
      );
      assert.ok(elapsed >= RUN_CANCEL_WAIT_MS / 2);

      // The row is removed even though the intent was never honoured; the
      // response, not a claim of success, carries the uncertainty.
      const runs = await pool.query(
        'SELECT count(*)::int AS count FROM runs WHERE owner_user_id = $1',
        [accounts.C.userId],
      );
      assert.equal(runs.rows[0].count, 0);

      const record = await pool.query(
        `SELECT outcome, detail
           FROM account_audit
          WHERE owner_user_id IS NULL
            AND actor_user_id = $1`,
        [accounts.C.userId],
      );
      assert.equal(record.rows[0].outcome, 'deleted');
      assert.deepEqual(record.rows[0].detail.runReconciliation.unreconciledRuns, [
        accounts.C.runId,
      ]);
    });

    test('stale access after deletion is the same non-enumerating refusal', async () => {
      const staleSession = createClient(base, sessions.A);
      const surfaces = [
        '/api/bots',
        `/api/threads/${accounts.A.conversationId}/messages`,
        `/api/artifacts/${accounts.A.artifactId}`,
        `/api/skills/${accounts.A.skillId}`,
        '/api/account',
        '/api/account/export',
        '/api/account/audit',
        `/api/runs/${accounts.A.runId}/events`,
      ];

      // The revoked session cannot reach any surface, including the old URLs.
      for (const path of surfaces) {
        const denied = await staleSession(path);
        assert.equal(denied.status, 401, `${path}: ${denied.text}`);
        assert.deepEqual(denied.body, UNAUTHENTICATED, path);
      }

      // Another account's live session cannot read A's old identifiers.
      const other = createClient(base, sessions.B);
      for (const path of [
        `/api/threads/${accounts.A.conversationId}/messages`,
        `/api/artifacts/${accounts.A.artifactId}`,
        `/api/skills/${accounts.A.skillId}`,
        `/api/runs/${accounts.A.runId}/events`,
      ]) {
        const missing = await other(path);
        assert.equal(missing.status, 404, `${path}: ${missing.text}`);
        assert.deepEqual(missing.body, NOT_FOUND, path);
      }

      const bots = await other('/api/bots');
      assert.equal(bots.status, 200, bots.text);
      assert.deepEqual(
        bots.body.bots.map((bot) => bot.id),
        [accounts.B.botId],
      );

      const profile = await other('/api/account');
      assert.equal(profile.status, 200, profile.text);
      assert.equal(profile.body.account.userId, accounts.B.userId);

      const exported = await other('/api/account/export');
      assert.equal(exported.status, 200, exported.text);
      const document = JSON.parse(exported.text);
      assert.equal(document.profile.userId, accounts.B.userId);
      for (const foreign of [
        accounts.A.email,
        'alpha-message-marker',
        'alpha-artifact-marker',
        'alpha-skill-body-marker',
      ]) {
        assert.equal(
          exported.text.includes(foreign),
          false,
          'the export leaked deleted data',
        );
      }

      const trail = await other('/api/account/audit');
      assert.equal(trail.status, 200, trail.text);
      assert.equal(
        trail.body.entries.every((entry) => entry.action === 'export'),
        true,
      );

      // Nothing A owned is left in the database.
      const owned = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM bots WHERE owner_user_id = $1) AS bots,
           (SELECT count(*)::int FROM messages WHERE owner_user_id = $1) AS messages,
           (SELECT count(*)::int FROM artifacts WHERE owner_user_id = $1) AS artifacts,
           (SELECT count(*)::int FROM skills WHERE owner_user_id = $1) AS skills,
           (SELECT count(*)::int FROM runs WHERE owner_user_id = $1) AS runs`,
        [accounts.A.userId],
      );
      assert.deepEqual(owned.rows[0], {
        bots: 0,
        messages: 0,
        artifacts: 0,
        skills: 0,
        runs: 0,
      });
    });

    test('the audit route does not exist when the P1 API flag is off', async () => {
      const port = await getFreePort();
      const env = {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        NODE_ENV: 'test',
      };

      for (const flag of [
        'HABI_P1_API',
        'HABI_AUTH_SPIKE',
        'HABI_SESSION_SPIKE',
        'HABI_SPIKE_MODE',
      ]) {
        delete env[flag];
      }

      const child = spawn(process.execPath, [ENTRY], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = captureOutput(child);

      try {
        await waitForEvent(child, 'api.ready', output, 15000);

        const response = await fetch(`http://127.0.0.1:${port}/api/account/audit`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        assert.equal(response.status, 404);
        const body = await response.json();
        assert.equal(body.statusCode, 404);
        assert.match(body.message, /Cannot GET \/api\/account\/audit/);
      } finally {
        await forceStop(child);
      }
    });
  },
);
