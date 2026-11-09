/**
 * P1 content HTTP surface smoke tests.
 *
 * Boots the real Nest application in-process with `HABI_P1_API=1` against an
 * ephemeral PostgreSQL 18.6 container and the real migrations. Sessions are
 * minted through the H-017 `SessionService` (there is no product login route in
 * this slice), then every new route is driven over HTTP.
 *
 * Coverage:
 *   flag          unset flag registers none of the new routes (child process)
 *   auth          every new route rejects no session; mutations reject no CSRF
 *   bots          create, partial edit, idempotent archive, server-owned id
 *   threads       create, rename, idempotent tombstone
 *   attachments   metadata, verified text bytes, markdown, non-text refusal
 *   artifacts     create, update, version append, metadata-only patch, restore,
 *                 version pages, hash verification
 *   memory        list page, propose from a thread, both gates, double approval
 *   skills        create, get, attach, detach, filter, page
 *   search        owner scope, Bot filter, query-bound cursor
 *   isolation     two accounts and guessed/malformed ids on every new route
 *   cursors       each list cursor pages without duplicates and rejects scope
 *   unavailable   an unconfigured storage root refuses bytes, not metadata
 *
 * Docker unavailability skips the Postgres suite; the container is removed
 * afterwards. No provider, credential, queue, or model call is involved.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const NOT_FOUND = { error: { code: 'not_found' } };
const CSRF_INVALID = { error: { code: 'csrf_invalid' } };

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 5000,
  });

  return result.status === 0;
}

function migrate(databaseUrl) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60000 },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(pool, containerName) {
  const deadline = Date.now() + 60000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  const logs = spawnSync('docker', ['logs', containerName], {
    encoding: 'utf8',
    timeout: 10000,
  });

  throw new Error(
    `PostgreSQL did not become ready: ${lastError?.message ?? 'unknown error'}\n${logs.stdout ?? ''}\n${logs.stderr ?? ''}`,
  );
}

async function readBody(response) {
  const text = await response.text();

  if (text === '') {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }

    function check() {
      for (const line of `${output.stdout}\n${output.stderr}`.split(/\r?\n/)) {
        if (line.trim() === '') {
          continue;
        }

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (typeof event === 'object' && event !== null && event.event === eventName) {
          cleanup();
          resolve(event);
          return;
        }
      }
    }

    function onData() {
      check();
    }

    function onExit(code, signal) {
      cleanup();
      reject(
        new Error(
          `Process exited before ${eventName} (code=${code}, signal=${signal}).\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    check();
  });
}

function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`${label} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);

    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }

    child.once('exit', onExit);
  });
}

async function forceStop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGKILL');

  try {
    await waitForExit(child, 5000, 'Child process');
  } catch {
    // Already torn down.
  }
}

async function startChildApi(envOverrides = {}) {
  const port = await getFreePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'test',
  };

  for (const name of [
    'HABI_SPIKE_MODE',
    'HABI_SESSION_SPIKE',
    'HABI_SESSION_SPIKE_TEST_CLOCK',
    'HABI_AUTH_SPIKE',
    'HABI_P1_API',
    'HABI_P1_API_SSE_HEARTBEAT_MS',
    'HABI_ATTACHMENT_STORAGE_ROOT',
    'DATABASE_URL',
  ]) {
    delete env[name];
  }

  Object.assign(env, envOverrides);

  const child = spawn(process.execPath, [ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);

  try {
    await waitForEvent(child, 'api.ready', output, READY_TIMEOUT_MS);
  } catch (error) {
    await forceStop(child);
    throw error;
  }

  return {
    base: `http://127.0.0.1:${port}`,
    output,
    async stop() {
      child.kill('SIGTERM');

      try {
        await waitForExit(child, EXIT_TIMEOUT_MS, 'API');
      } catch {
        // Fall through to forceStop.
      }

      await forceStop(child);
    },
  };
}

/** Minimal in-memory browser: session cookie plus CSRF synchronizer token. */
function createClient(base, session) {
  return async function request(path, options = {}) {
    const headers = {
      ...(options.headers ?? {}),
      cookie: `habi_session=${session.sessionId}`,
    };

    if (options.csrf === true) {
      headers['x-csrf-token'] = session.csrfToken;
    } else if (options.csrf === 'wrong') {
      headers['x-csrf-token'] = 'wrong-csrf-token';
    }

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(10000),
    });

    return {
      status: response.status,
      headers: response.headers,
      body: await readBody(response),
    };
  };
}

/** Raw response reader for the attachment text route. */
async function requestText(base, session, path) {
  const response = await fetch(`${base}${path}`, {
    headers: { cookie: `habi_session=${session.sessionId}` },
    signal: AbortSignal.timeout(5000),
  });

  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

function expectError(body, code) {
  assert.deepEqual(body, { error: { code } });
}

async function* bytes(value) {
  yield Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

const dockerReady = dockerAvailable();

describe(
  'P1 content API',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let password = '';
    let databaseUrl = '';
    let pool;
    let app;
    let base = '';
    let storageRoot = '';
    let sessionA;
    let sessionB;
    let requestA;
    let requestB;
    let userA;
    let userB;
    let botA1;
    let botA2;
    let botAArchived;
    let botB1;
    let threadA1;
    let threadA2;
    let threadB1;
    let messageA1;
    let artifactA1;
    let artifactA2;
    let artifactB1;
    let attachmentAText;
    let attachmentAMarkdown;
    let attachmentAPng;
    let attachmentBText;
    let memoryA1;
    let memoryA2;
    let memoryB1;
    let skillA1;
    let skillA2;
    let skillB1;

    async function seedUser() {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
      return id;
    }

    async function ageRow(table, id, minutesAgo) {
      await pool.query(
        `UPDATE ${table} SET updated_at = now() - ($2::int * interval '1 minute') WHERE id = $1`,
        [id, minutesAgo],
      );
    }

    before(async () => {
      containerName = `habi-content-${randomBytes(6).toString('hex')}`;
      password = randomBytes(24).toString('hex');

      const container = spawnSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
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
        ],
        { encoding: 'utf8', timeout: 120000 },
      );

      assert.equal(container.status, 0, container.stderr);

      const portResult = spawnSync('docker', ['port', containerName, '5432/tcp'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(portResult.status, 0, portResult.stderr);

      const port = Number.parseInt(portResult.stdout.trim().split(':').pop() ?? '', 10);
      assert.ok(Number.isInteger(port) && port > 0, 'Docker did not publish PostgreSQL');

      pool = new Pool({
        host: '127.0.0.1',
        port,
        user: DOCKER_USER,
        password,
        database: DOCKER_DATABASE,
        max: 12,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0016_run_cancel_intent\.sql/);

      userA = await seedUser();
      userB = await seedUser();

      const [{ BotRepository }, persistence, artifactsModule, attachmentsModule, memoryModule, skillsModule] =
        await Promise.all([
          import('../dist/bots/index.js'),
          import('../dist/persistence/index.js'),
          import('../dist/artifacts/index.js'),
          import('../dist/attachments/index.js'),
          import('../dist/memory/index.js'),
          import('../dist/skills/index.js'),
        ]);

      const bots = new BotRepository(pool);
      const conversations = new persistence.ConversationRepository(pool);
      const messages = new persistence.MessageRepository(pool);

      botA1 = (
        await bots.create(userA, {
          name: 'Content Alpha',
          description: 'Alpha content bot.',
          instructionsMarkdown: '# Alpha',
        })
      ).id;
      botA2 = (await bots.create(userA, { name: 'Content Alpha Two' })).id;
      botAArchived = (await bots.create(userA, { name: 'Archived Alpha' })).id;
      botB1 = (await bots.create(userB, { name: 'Content Beta' })).id;

      await bots.archive(userA, botAArchived);

      threadA1 = (
        await conversations.create(userA, { botId: botA1, title: 'Alpha thread one' })
      ).id;
      threadA2 = (
        await conversations.create(userA, { botId: botA1, title: 'Alpha thread two' })
      ).id;
      threadB1 = (
        await conversations.create(userB, { botId: botB1, title: 'Beta thread one' })
      ).id;

      messageA1 = await messages.append(userA, {
        conversationId: threadA1,
        role: 'user',
        content: 'zebraalpha isolation marker',
        clientMessageId: 'content-a-1',
      });
      await messages.append(userA, {
        conversationId: threadA1,
        role: 'assistant',
        content: 'cursoralpha first page',
        clientMessageId: 'content-a-2',
      });
      await messages.append(userA, {
        conversationId: threadA2,
        role: 'user',
        content: 'cursoralpha second page',
        clientMessageId: 'content-a-3',
      });
      await messages.append(userB, {
        conversationId: threadB1,
        role: 'user',
        content: 'zebrabeta isolation marker',
        clientMessageId: 'content-b-1',
      });

      const artifacts = new artifactsModule.ArtifactService(pool);
      artifactA1 = await artifacts.create(userA, {
        kind: 'markdown',
        title: 'Alpha artifact one',
        content: '# Alpha one\n\nzebraalpha',
        conversationId: threadA1,
      });
      artifactA2 = await artifacts.create(userA, {
        kind: 'text',
        title: 'Alpha artifact two',
        content: 'alpha two',
        conversationId: threadA2,
      });
      artifactB1 = await artifacts.create(userB, {
        kind: 'text',
        title: 'Beta artifact',
        content: 'zebrabeta',
        conversationId: threadB1,
      });

      storageRoot = await mkdtemp(join(tmpdir(), 'habi-content-files-'));
      const attachments = new attachmentsModule.AttachmentService(
        pool,
        new attachmentsModule.LocalAttachmentStorage(storageRoot),
      );

      attachmentAText = await attachments.createUpload(userA, threadA1, {
        filename: 'alpha.txt',
        contentType: 'text/plain',
        source: bytes('zebraalpha attachment body'),
      });
      await attachments.finalize(userA, attachmentAText.id);

      attachmentAMarkdown = await attachments.createUpload(userA, threadA1, {
        filename: 'alpha.md',
        contentType: 'text/markdown',
        source: bytes('# Alpha markdown\n'),
      });
      await attachments.finalize(userA, attachmentAMarkdown.id);

      attachmentAPng = await attachments.createUpload(userA, threadA1, {
        filename: 'alpha.png',
        contentType: 'image/png',
        source: bytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      });
      await attachments.finalize(userA, attachmentAPng.id);

      attachmentBText = await attachments.createUpload(userB, threadB1, {
        filename: 'beta.txt',
        contentType: 'text/plain',
        source: bytes('zebrabeta attachment body'),
      });
      await attachments.finalize(userB, attachmentBText.id);

      const memory = new memoryModule.MemoryService(pool);
      memoryA1 = await memory.propose(userA, {
        botId: botA1,
        conversationId: threadA1,
        sourceMessageId: messageA1.id,
        content: 'zebraalpha memory one',
      });
      memoryA2 = await memory.propose(userA, {
        botId: botA1,
        conversationId: threadA2,
        content: 'zebraalpha memory two',
      });
      memoryB1 = await memory.propose(userB, {
        botId: botB1,
        conversationId: threadB1,
        content: 'zebrabeta memory',
      });

      const skills = new skillsModule.SkillService(pool);
      skillA1 = await skills.create(userA, {
        name: 'Alpha skill one',
        description: 'Alpha-owned skill.',
        bodyMarkdown: '# Alpha skill\n\nzebraalpha',
        botId: botA1,
        status: 'active',
      });
      skillA2 = await skills.create(userA, {
        name: 'Alpha skill two',
        description: 'Second alpha skill.',
        bodyMarkdown: '# Alpha skill two',
        status: 'active',
      });
      skillB1 = await skills.create(userB, {
        name: 'Beta skill',
        description: 'Beta-owned skill.',
        bodyMarkdown: '# Beta skill',
        botId: botB1,
        status: 'active',
      });

      await ageRow('bots', botA1, 1);
      await ageRow('bots', botA2, 2);
      await ageRow('bots', botAArchived, 3);
      await ageRow('bots', botB1, 4);
      await ageRow('conversations', threadA1, 1);
      await ageRow('conversations', threadA2, 2);
      await ageRow('conversations', threadB1, 3);
      await ageRow('artifacts', artifactA1.artifact.id, 1);
      await ageRow('artifacts', artifactA2.artifact.id, 2);
      await ageRow('artifacts', artifactB1.artifact.id, 3);
      await ageRow('skills', skillA1.id, 1);
      await ageRow('skills', skillA2.id, 2);
      await ageRow('skills', skillB1.id, 3);

      process.env.NODE_ENV = 'test';
      process.env.HABI_P1_API = '1';
      process.env.HABI_P1_API_SSE_HEARTBEAT_MS = '300';
      process.env.HABI_ATTACHMENT_STORAGE_ROOT = storageRoot;
      process.env.DATABASE_URL = databaseUrl;

      const { AppModule } = await import('../dist/app.module.js');
      const { NestFactory } = await import('@nestjs/core');
      const { SessionService } = await import('../dist/session/session.service.js');

      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0, '127.0.0.1');

      const address = app.getHttpServer().address();
      assert.ok(
        address !== null && typeof address === 'object',
        'API did not bind a TCP port',
      );
      base = `http://127.0.0.1:${address.port}`;

      const sessions = app.get(SessionService);
      sessionA = sessions.create(userA);
      sessionB = sessions.create(userB);
      requestA = createClient(base, sessionA);
      requestB = createClient(base, sessionB);
    });

    after(async () => {
      if (app !== undefined) {
        await app.close().catch(() => {});
      }

      if (pool !== undefined) {
        await pool.end().catch(() => {});
      }

      if (storageRoot !== '') {
        await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
      }

      if (containerName !== '') {
        spawnSync('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          timeout: 30000,
        });

        const inspect = spawnSync('docker', ['inspect', containerName], {
          stdio: 'ignore',
          timeout: 10000,
        });
        assert.notEqual(
          inspect.status,
          0,
          'temporary PostgreSQL container was not removed',
        );
      }
    });

    test('every new route rejects a request with no session as 401', async () => {
      const routes = [
        ['POST', '/api/bots', { name: 'x' }],
        ['PATCH', `/api/bots/${botA1}`, { name: 'x' }],
        ['DELETE', `/api/bots/${botA1}`, undefined],
        ['POST', `/api/bots/${botA1}/threads`, { title: 'x' }],
        ['PATCH', `/api/threads/${threadA1}`, { title: 'x' }],
        ['DELETE', `/api/threads/${threadA1}`, undefined],
        ['GET', `/api/threads/${threadA1}/attachments`, undefined],
        ['GET', `/api/attachments/${attachmentAText.id}`, undefined],
        ['GET', `/api/attachments/${attachmentAText.id}/content`, undefined],
        ['GET', '/api/artifacts', undefined],
        ['POST', '/api/artifacts', { kind: 'text', title: 'x', content: 'y' }],
        ['GET', `/api/artifacts/${artifactA1.artifact.id}`, undefined],
        ['PATCH', `/api/artifacts/${artifactA1.artifact.id}`, { title: 'x' }],
        ['GET', `/api/artifacts/${artifactA1.artifact.id}/versions`, undefined],
        ['POST', `/api/artifacts/${artifactA1.artifact.id}/restore`, { version: 1 }],
        ['GET', `/api/bots/${botA1}/memories`, undefined],
        ['POST', `/api/bots/${botA1}/memories`, { text: 'x', threadId: threadA1 }],
        ['POST', `/api/memories/${memoryA1.id}/approvals`, { bot: true, thread: false }],
        ['GET', '/api/skills', undefined],
        ['POST', '/api/skills', { name: 'x', bodyMarkdown: 'y' }],
        ['GET', `/api/skills/${skillA1.id}`, undefined],
        ['POST', `/api/skills/${skillA1.id}/attach`, { botId: botA1 }],
        ['POST', `/api/skills/${skillA1.id}/detach`, undefined],
        ['GET', '/api/search?q=zebraalpha', undefined],
      ];

      for (const [method, path, body] of routes) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

        assert.equal(response.status, 401, `${method} ${path}`);
        assert.deepEqual(await readBody(response), UNAUTHENTICATED);
      }
    });

    test('mutations require the session CSRF token', async () => {
      const noToken = await requestA('/api/bots', {
        method: 'POST',
        body: { name: 'No CSRF' },
      });
      assert.equal(noToken.status, 403);
      assert.deepEqual(noToken.body, CSRF_INVALID);

      const wrongToken = await requestA(`/api/artifacts/${artifactA1.artifact.id}`, {
        method: 'PATCH',
        csrf: 'wrong',
        body: { title: 'No CSRF' },
      });
      assert.equal(wrongToken.status, 403);
      assert.deepEqual(wrongToken.body, CSRF_INVALID);
    });

    test('bots create, partial edit, and idempotent archive over HTTP', async () => {
      const suppliedId = randomUUID();
      const created = await requestA('/api/bots', {
        method: 'POST',
        csrf: true,
        body: {
          name: '  Created Bot  ',
          description: 'Created through HTTP.',
          instructionsMarkdown: '# Created\n\nRules.',
          id: suppliedId,
          ownerUserId: userB,
          status: 'archived',
        },
      });

      assert.equal(created.status, 201);
      assert.equal(created.body.bot.name, 'Created Bot');
      assert.equal(created.body.bot.description, 'Created through HTTP.');
      assert.equal(created.body.bot.instructionsMarkdown, '# Created\n\nRules.');
      assert.equal(created.body.bot.status, 'active');
      assert.equal(created.body.bot.archivedAt, null);
      assert.notEqual(created.body.bot.id, suppliedId);
      assert.match(created.body.bot.id, UUID_PATTERN);

      const stored = await pool.query(
        'SELECT owner_user_id FROM bots WHERE id = $1',
        [created.body.bot.id],
      );
      assert.equal(stored.rows[0].owner_user_id, userA);

      const patched = await requestA(`/api/bots/${created.body.bot.id}`, {
        method: 'PATCH',
        csrf: true,
        body: {
          name: 'Renamed Bot',
          id: randomUUID(),
          ownerUserId: userB,
          status: 'archived',
        },
      });

      assert.equal(patched.status, 200);
      assert.equal(patched.body.bot.name, 'Renamed Bot');
      assert.equal(patched.body.bot.description, 'Created through HTTP.');
      assert.equal(patched.body.bot.status, 'active');

      const emptyPatch = await requestA(`/api/bots/${created.body.bot.id}`, {
        method: 'PATCH',
        csrf: true,
        body: {},
      });
      assert.equal(emptyPatch.status, 400);
      expectError(emptyPatch.body, 'invalid_input');

      const archived = await requestA(`/api/bots/${created.body.bot.id}`, {
        method: 'DELETE',
        csrf: true,
      });
      assert.equal(archived.status, 200);
      assert.equal(archived.body.bot.status, 'archived');
      assert.equal(typeof archived.body.bot.archivedAt, 'string');

      const repeated = await requestA(`/api/bots/${created.body.bot.id}`, {
        method: 'DELETE',
        csrf: true,
      });
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.bot.archivedAt, archived.body.bot.archivedAt);

      const listB = await requestB('/api/bots');
      assert.ok(!listB.body.bots.some((bot) => bot.id === created.body.bot.id));
    });

    test('threads create, rename, and idempotently tombstone over HTTP', async () => {
      const suppliedId = randomUUID();
      const created = await requestA(`/api/bots/${botA1}/threads`, {
        method: 'POST',
        csrf: true,
        body: { title: '  Created thread  ', id: suppliedId, ownerUserId: userB },
      });

      assert.equal(created.status, 201);
      assert.equal(created.body.thread.title, 'Created thread');
      assert.equal(created.body.thread.botId, botA1);
      assert.equal(created.body.thread.status, 'active');
      assert.notEqual(created.body.thread.id, suppliedId);
      assert.match(created.body.thread.id, UUID_PATTERN);

      const renamed = await requestA(`/api/threads/${created.body.thread.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { title: 'Renamed thread' },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.thread.title, 'Renamed thread');

      const listed = await requestA(`/api/bots/${botA1}/threads`);
      assert.ok(listed.body.threads.some((thread) => thread.id === created.body.thread.id));

      const deleted = await requestA(`/api/threads/${created.body.thread.id}`, {
        method: 'DELETE',
        csrf: true,
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.thread.status, 'deleted');
      assert.equal(typeof deleted.body.thread.id, 'string');

      const repeated = await requestA(`/api/threads/${created.body.thread.id}`, {
        method: 'DELETE',
        csrf: true,
      });
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.thread.id, created.body.thread.id);

      const after = await requestA(`/api/bots/${botA1}/threads`);
      assert.ok(!after.body.threads.some((thread) => thread.id === created.body.thread.id));

      const archivedBot = await requestA(`/api/bots/${botAArchived}/threads`, {
        method: 'POST',
        csrf: true,
        body: {},
      });
      assert.equal(archivedBot.status, 409);
      expectError(archivedBot.body, 'bot_unavailable');
    });

    test('attachment metadata and verified text bytes are owner scoped', async () => {
      const list = await requestA(`/api/threads/${threadA1}/attachments`);

      assert.equal(list.status, 200);
      assert.equal(list.body.nextCursor, null);
      const ids = list.body.attachments.map((attachment) => attachment.id);
      assert.ok(ids.includes(attachmentAText.id));
      assert.ok(ids.includes(attachmentAMarkdown.id));
      assert.ok(ids.includes(attachmentAPng.id));
      assert.ok(!ids.includes(attachmentBText.id));

      const textRow = list.body.attachments.find(
        (attachment) => attachment.id === attachmentAText.id,
      );
      assert.equal(
        textRow.sha256,
        sha256('zebraalpha attachment body'),
      );
      assert.equal(textRow.storageKey, undefined);

      const metadata = await requestA(`/api/attachments/${attachmentAText.id}`);
      assert.equal(metadata.status, 200);
      assert.equal(metadata.body.attachment.id, attachmentAText.id);
      assert.equal(metadata.body.attachment.contentType, 'text/plain');
      assert.equal(metadata.body.attachment.status, 'stored');
      assert.equal('storageKey' in metadata.body.attachment, false);

      const text = await fetch(`${base}/api/attachments/${attachmentAText.id}/content`, {
        headers: { cookie: `habi_session=${sessionA.sessionId}` },
        signal: AbortSignal.timeout(5000),
      });
      const textBody = await text.text();

      assert.equal(text.status, 200);
      assert.match(text.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(text.headers.get('cache-control'), 'no-store');
      assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(textBody, 'zebraalpha attachment body');
      // The bytes match the metadata digest recorded with the row.
      assert.equal(sha256(textBody), textRow.sha256);
      assert.equal(
        Number(text.headers.get('content-length')),
        Buffer.byteLength(textBody, 'utf8'),
      );

      const markdown = await requestText(
        base,
        sessionA,
        `/api/attachments/${attachmentAMarkdown.id}/content`,
      );
      assert.equal(markdown.status, 200);
      assert.match(markdown.headers.get('content-type') ?? '', /^text\/markdown/);
      assert.equal(markdown.text, '# Alpha markdown\n');

      const png = await requestA(`/api/attachments/${attachmentAPng.id}/content`);
      assert.equal(png.status, 415);
      expectError(png.body, 'unsupported_media_type');

      // Same id, other account: one not-found for metadata, bytes, and list.
      const foreignMetadata = await requestB(`/api/attachments/${attachmentAText.id}`);
      assert.equal(foreignMetadata.status, 404);
      assert.deepEqual(foreignMetadata.body, NOT_FOUND);

      const foreignContent = await requestB(
        `/api/attachments/${attachmentAText.id}/content`,
      );
      assert.equal(foreignContent.status, 404);
      assert.deepEqual(foreignContent.body, NOT_FOUND);

      const foreignList = await requestB(`/api/threads/${threadA1}/attachments`);
      assert.equal(foreignList.status, 404);
      assert.deepEqual(foreignList.body, NOT_FOUND);
    });

    test('artifacts create, update, versions, and restore over HTTP', async () => {
      const firstContent = 'first artifact body';
      const created = await requestA('/api/artifacts', {
        method: 'POST',
        csrf: true,
        body: {
          kind: 'markdown',
          title: '  HTTP artifact  ',
          content: firstContent,
          conversationId: threadA1,
          id: randomUUID(),
          ownerUserId: userB,
        },
      });

      assert.equal(created.status, 201);
      const artifactId = created.body.artifact.artifact.id;
      assert.match(artifactId, UUID_PATTERN);
      assert.equal(created.body.artifact.artifact.title, 'HTTP artifact');
      assert.equal(created.body.artifact.artifact.currentVersion, 1);
      assert.equal(created.body.artifact.version.version, 1);
      assert.equal(created.body.artifact.version.content, firstContent);
      assert.equal(created.body.artifact.version.contentSha256, sha256(firstContent));
      assert.equal(
        created.body.artifact.version.byteSize,
        Buffer.byteLength(firstContent, 'utf8'),
      );

      const read = await requestA(`/api/artifacts/${artifactId}`);
      assert.equal(read.status, 200);
      assert.equal(read.body.artifact.version.content, firstContent);

      const versionOne = await requestA(`/api/artifacts/${artifactId}?version=1`);
      assert.equal(versionOne.status, 200);
      assert.equal(versionOne.body.artifact.version.version, 1);
      assert.equal(versionOne.body.artifact.version.content, firstContent);

      const updated = await requestA(`/api/artifacts/${artifactId}`, {
        method: 'PATCH',
        csrf: true,
        body: { content: 'second artifact body' },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.artifact.artifact.currentVersion, 2);
      assert.equal(updated.body.artifact.version.content, 'second artifact body');
      assert.equal(
        updated.body.artifact.version.contentSha256,
        sha256('second artifact body'),
      );

      const metadataOnly = await requestA(`/api/artifacts/${artifactId}`, {
        method: 'PATCH',
        csrf: true,
        body: { title: 'Renamed only' },
      });
      assert.equal(metadataOnly.status, 200);
      assert.equal(metadataOnly.body.artifact.artifact.currentVersion, 3);
      assert.equal(metadataOnly.body.artifact.artifact.title, 'Renamed only');
      assert.equal(
        metadataOnly.body.artifact.version.content,
        'second artifact body',
      );

      const emptyPatch = await requestA(`/api/artifacts/${artifactId}`, {
        method: 'PATCH',
        csrf: true,
        body: {},
      });
      assert.equal(emptyPatch.status, 400);
      expectError(emptyPatch.body, 'invalid_input');

      const versionsPageOne = await requestA(
        `/api/artifacts/${artifactId}/versions?limit=2`,
      );
      assert.equal(versionsPageOne.status, 200);
      assert.deepEqual(
        versionsPageOne.body.versions.map((version) => version.version),
        [3, 2],
      );
      assert.equal(typeof versionsPageOne.body.nextCursor, 'string');
      assert.equal('content' in versionsPageOne.body.versions[0], false);

      const versionsPageTwo = await requestA(
        `/api/artifacts/${artifactId}/versions?limit=2&cursor=${encodeURIComponent(versionsPageOne.body.nextCursor)}`,
      );
      assert.equal(versionsPageTwo.status, 200);
      assert.deepEqual(
        versionsPageTwo.body.versions.map((version) => version.version),
        [1],
      );
      assert.equal(versionsPageTwo.body.nextCursor, null);

      const restored = await requestA(`/api/artifacts/${artifactId}/restore`, {
        method: 'POST',
        csrf: true,
        body: { version: 1 },
      });
      assert.equal(restored.status, 200);
      assert.equal(restored.body.artifact.artifact.currentVersion, 4);
      assert.equal(restored.body.artifact.version.content, firstContent);
      assert.equal(restored.body.artifact.version.contentSha256, sha256(firstContent));

      const badVersion = await requestA(`/api/artifacts/${artifactId}?version=nope`);
      assert.equal(badVersion.status, 400);
      expectError(badVersion.body, 'invalid_input');

      const tooLarge = await requestA('/api/artifacts', {
        method: 'POST',
        csrf: true,
        body: {
          kind: 'text',
          title: 'Too large',
          content: 'x'.repeat(1048577),
        },
      });
      // The transport's JSON limit (100 KB, configured outside this module)
      // refuses the body before the service's 1 MiB bound is reached.
      assert.ok(
        tooLarge.status === 413 || tooLarge.status === 400,
        `unexpected oversized status ${tooLarge.status}`,
      );
    });

    test('artifact list pages by keyset cursor and cannot be widened', async () => {
      const list = await requestA('/api/artifacts');
      assert.equal(list.status, 200);
      assert.ok(list.body.artifacts.some((item) => item.id === artifactA1.artifact.id));
      assert.ok(list.body.artifacts.some((item) => item.id === artifactA2.artifact.id));
      assert.ok(!list.body.artifacts.some((item) => item.id === artifactB1.artifact.id));

      const pageOne = await requestA('/api/artifacts?limit=1');
      assert.equal(pageOne.status, 200);
      assert.equal(pageOne.body.artifacts.length, 1);
      assert.equal(typeof pageOne.body.nextCursor, 'string');

      const pageTwo = await requestA(
        `/api/artifacts?limit=1&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(pageTwo.status, 200);
      assert.equal(pageTwo.body.artifacts.length, 1);
      assert.notEqual(pageTwo.body.artifacts[0].id, pageOne.body.artifacts[0].id);

      const filtered = await requestA(`/api/artifacts?conversationId=${threadA2}`);
      assert.equal(filtered.status, 200);
      assert.ok(filtered.body.artifacts.some((item) => item.id === artifactA2.artifact.id));
      assert.ok(!filtered.body.artifacts.some((item) => item.id === artifactA1.artifact.id));

      const foreignFilter = await requestA(`/api/artifacts?conversationId=${threadB1}`);
      assert.equal(foreignFilter.status, 200);
      assert.deepEqual(foreignFilter.body.artifacts, []);

      const wrongScope = await requestA(
        `/api/artifacts?conversationId=${threadA2}&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(wrongScope.status, 400);
      expectError(wrongScope.body, 'invalid_cursor');

      const badCursor = await requestA('/api/artifacts?cursor=nope');
      assert.equal(badCursor.status, 400);
      expectError(badCursor.body, 'invalid_cursor');
    });

    test('memory list, propose, and dual approvals stay owner scoped', async () => {
      const list = await requestA(`/api/bots/${botA1}/memories`);
      assert.equal(list.status, 200);
      const ids = list.body.memories.map((memory) => memory.id);
      assert.ok(ids.includes(memoryA1.id));
      assert.ok(ids.includes(memoryA2.id));
      assert.ok(!ids.includes(memoryB1.id));
      assert.equal(list.body.nextCursor, null);

      const pageOne = await requestA(`/api/bots/${botA1}/memories?limit=1`);
      assert.equal(pageOne.status, 200);
      assert.equal(pageOne.body.memories.length, 1);
      assert.equal(typeof pageOne.body.nextCursor, 'string');

      const pageTwo = await requestA(
        `/api/bots/${botA1}/memories?limit=1&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(pageTwo.status, 200);
      assert.equal(pageTwo.body.memories.length, 1);
      assert.notEqual(pageTwo.body.memories[0].id, pageOne.body.memories[0].id);

      const created = await requestA(`/api/bots/${botA1}/memories`, {
        method: 'POST',
        csrf: true,
        body: { text: '  new memory fact  ', threadId: threadA1 },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.memory.content, 'new memory fact');
      assert.equal(created.body.memory.botId, botA1);
      assert.equal(created.body.memory.conversationId, threadA1);
      assert.equal(created.body.memory.status, 'proposed');
      assert.equal(created.body.memory.botApproved, false);
      assert.equal(created.body.memory.conversationApproved, false);

      const noThread = await requestA(`/api/bots/${botA1}/memories`, {
        method: 'POST',
        csrf: true,
        body: { text: 'no provenance' },
      });
      assert.equal(noThread.status, 400);
      expectError(noThread.body, 'invalid_input');

      const oneGate = await requestA(
        `/api/memories/${created.body.memory.id}/approvals`,
        {
          method: 'POST',
          csrf: true,
          body: { bot: true, thread: false },
        },
      );
      assert.equal(oneGate.status, 200);
      assert.equal(oneGate.body.memory.botApproved, true);
      assert.equal(oneGate.body.memory.conversationApproved, false);
      assert.equal(oneGate.body.memory.status, 'proposed');

      const accepted = await requestA(
        `/api/memories/${created.body.memory.id}/approvals`,
        {
          method: 'POST',
          csrf: true,
          body: { bot: true, thread: true, threadId: threadA1 },
        },
      );
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.memory.botApproved, true);
      assert.equal(accepted.body.memory.conversationApproved, true);
      assert.equal(accepted.body.memory.status, 'accepted');

      const revoked = await requestA(
        `/api/memories/${created.body.memory.id}/approvals`,
        {
          method: 'POST',
          csrf: true,
          body: { bot: false, thread: true },
        },
      );
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.memory.botApproved, false);
      assert.equal(revoked.body.memory.status, 'proposed');

      // An approval is bound to this Memory's own source thread.
      const otherThread = await requestA(
        `/api/memories/${created.body.memory.id}/approvals`,
        {
          method: 'POST',
          csrf: true,
          body: { bot: true, thread: true, threadId: threadA2 },
        },
      );
      assert.equal(otherThread.status, 404);
      assert.deepEqual(otherThread.body, NOT_FOUND);

      const wrongGates = await requestA(
        `/api/memories/${created.body.memory.id}/approvals`,
        {
          method: 'POST',
          csrf: true,
          body: { bot: 'yes', thread: false },
        },
      );
      assert.equal(wrongGates.status, 400);
      expectError(wrongGates.body, 'invalid_input');
    });

    test('skills create, attach, detach, and list with ownership', async () => {
      const list = await requestA('/api/skills');
      assert.equal(list.status, 200);
      const ids = list.body.skills.map((skill) => skill.id);
      assert.ok(ids.includes(skillA1.id));
      assert.ok(ids.includes(skillA2.id));
      assert.ok(!ids.includes(skillB1.id));

      const filtered = await requestA(`/api/skills?botId=${botA1}`);
      assert.equal(filtered.status, 200);
      assert.ok(filtered.body.skills.some((skill) => skill.id === skillA1.id));
      assert.ok(!filtered.body.skills.some((skill) => skill.id === skillA2.id));

      const created = await requestA('/api/skills', {
        method: 'POST',
        csrf: true,
        body: {
          name: 'HTTP skill',
          description: 'Created through HTTP.',
          bodyMarkdown: '# HTTP skill\n',
          botId: botA2,
          id: randomUUID(),
          ownerUserId: userB,
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.skill.name, 'HTTP skill');
      assert.equal(created.body.skill.botId, botA2);
      assert.equal(created.body.skill.version, 1);
      assert.equal(created.body.skill.status, 'draft');
      assert.notEqual(created.body.skill.id, undefined);

      const read = await requestA(`/api/skills/${created.body.skill.id}`);
      assert.equal(read.status, 200);
      assert.equal(read.body.skill.bodyMarkdown, '# HTTP skill\n');

      const attached = await requestA(
        `/api/skills/${created.body.skill.id}/attach`,
        { method: 'POST', csrf: true, body: { botId: botA1 } },
      );
      assert.equal(attached.status, 200);
      assert.equal(attached.body.skill.botId, botA1);

      const detached = await requestA(
        `/api/skills/${created.body.skill.id}/detach`,
        { method: 'POST', csrf: true },
      );
      assert.equal(detached.status, 200);
      assert.equal(detached.body.skill.botId, null);

      const foreignBot = await requestA(
        `/api/skills/${created.body.skill.id}/attach`,
        { method: 'POST', csrf: true, body: { botId: botB1 } },
      );
      assert.equal(foreignBot.status, 404);
      assert.deepEqual(foreignBot.body, NOT_FOUND);

      const pageOne = await requestA('/api/skills?limit=1');
      assert.equal(pageOne.status, 200);
      assert.equal(pageOne.body.skills.length, 1);
      assert.equal(typeof pageOne.body.nextCursor, 'string');

      const pageTwo = await requestA(
        `/api/skills?limit=1&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(pageTwo.status, 200);
      assert.equal(pageTwo.body.skills.length, 1);
      assert.notEqual(pageTwo.body.skills[0].id, pageOne.body.skills[0].id);

      const badStatus = await requestA('/api/skills?status=bogus');
      assert.equal(badStatus.status, 400);
      expectError(badStatus.body, 'invalid_input');
    });

    test('search is owner scoped, Bot filtered, and cursor bound', async () => {
      const own = await requestA('/api/search?q=zebraalpha');
      assert.equal(own.status, 200);
      assert.ok(own.body.results.length > 0);
      for (const hit of own.body.results) {
        assert.ok([threadA1, threadA2].includes(hit.conversationId));
      }

      const foreign = await requestA('/api/search?q=zebrabeta');
      assert.equal(foreign.status, 200);
      assert.deepEqual(foreign.body.results, []);

      const foreignFilter = await requestA(`/api/search?q=zebraalpha&botId=${botB1}`);
      assert.equal(foreignFilter.status, 200);
      assert.deepEqual(foreignFilter.body.results, []);

      const ownB = await requestB(`/api/search?q=zebrabeta&botId=${botB1}`);
      assert.equal(ownB.status, 200);
      assert.ok(ownB.body.results.length > 0);

      const pageOne = await requestA('/api/search?q=cursoralpha&limit=1');
      assert.equal(pageOne.status, 200);
      assert.equal(pageOne.body.results.length, 1);
      assert.equal(typeof pageOne.body.nextCursor, 'string');

      const pageTwo = await requestA(
        `/api/search?q=cursoralpha&limit=1&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(pageTwo.status, 200);
      assert.equal(pageTwo.body.results.length, 1);
      assert.notEqual(pageTwo.body.results[0].messageId, pageOne.body.results[0].messageId);

      const wrongQuery = await requestA(
        `/api/search?q=zebraalpha&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(wrongQuery.status, 400);
      expectError(wrongQuery.body, 'invalid_cursor');

      const missingQuery = await requestA('/api/search');
      assert.equal(missingQuery.status, 400);
      expectError(missingQuery.body, 'invalid_input');

      const malformedFilter = await requestA('/api/search?q=zebraalpha&botId=nope');
      assert.equal(malformedFilter.status, 400);
      expectError(malformedFilter.body, 'invalid_input');
    });

    test('two accounts and guessed ids are isolated on every new route', async () => {
      const guessed = randomUUID();
      const probes = [
        ['PATCH', `/api/bots/${botA1}`, { name: 'cross-user' }],
        ['PATCH', `/api/bots/${guessed}`, { name: 'guessed' }],
        ['PATCH', '/api/bots/not-a-uuid', { name: 'malformed' }],
        ['DELETE', `/api/bots/${botA1}`, undefined],
        ['DELETE', `/api/bots/${guessed}`, undefined],
        ['DELETE', '/api/bots/not-a-uuid', undefined],
        ['POST', `/api/bots/${botA1}/threads`, { title: 'cross-user' }],
        ['POST', `/api/bots/${guessed}/threads`, { title: 'guessed' }],
        ['POST', '/api/bots/not-a-uuid/threads', { title: 'malformed' }],
        ['PATCH', `/api/threads/${threadA1}`, { title: 'cross-user' }],
        ['PATCH', `/api/threads/${guessed}`, { title: 'guessed' }],
        ['PATCH', '/api/threads/not-a-uuid', { title: 'malformed' }],
        ['DELETE', `/api/threads/${threadA1}`, undefined],
        ['DELETE', `/api/threads/${guessed}`, undefined],
        ['DELETE', '/api/threads/not-a-uuid', undefined],
        ['GET', `/api/threads/${threadA1}/attachments`, undefined],
        ['GET', `/api/threads/${guessed}/attachments`, undefined],
        ['GET', '/api/threads/not-a-uuid/attachments', undefined],
        ['GET', `/api/attachments/${attachmentAText.id}`, undefined],
        ['GET', `/api/attachments/${guessed}`, undefined],
        ['GET', '/api/attachments/not-a-uuid', undefined],
        ['GET', `/api/attachments/${attachmentAText.id}/content`, undefined],
        ['GET', `/api/attachments/${guessed}/content`, undefined],
        ['GET', '/api/attachments/not-a-uuid/content', undefined],
        [
          'POST',
          '/api/artifacts',
          {
            kind: 'text',
            title: 'cross-user',
            content: 'cross-user body',
            conversationId: threadA1,
          },
        ],
        ['GET', `/api/artifacts/${artifactA1.artifact.id}`, undefined],
        ['GET', `/api/artifacts/${guessed}`, undefined],
        ['GET', '/api/artifacts/not-a-uuid', undefined],
        ['PATCH', `/api/artifacts/${artifactA1.artifact.id}`, { content: 'cross-user' }],
        ['PATCH', `/api/artifacts/${guessed}`, { content: 'guessed' }],
        ['PATCH', '/api/artifacts/not-a-uuid', { content: 'malformed' }],
        ['GET', `/api/artifacts/${artifactA1.artifact.id}/versions`, undefined],
        ['GET', `/api/artifacts/${guessed}/versions`, undefined],
        ['GET', '/api/artifacts/not-a-uuid/versions', undefined],
        ['POST', `/api/artifacts/${artifactA1.artifact.id}/restore`, { version: 1 }],
        ['POST', `/api/artifacts/${guessed}/restore`, { version: 1 }],
        ['POST', '/api/artifacts/not-a-uuid/restore', { version: 1 }],
        ['GET', `/api/bots/${botA1}/memories`, undefined],
        ['GET', `/api/bots/${guessed}/memories`, undefined],
        ['GET', '/api/bots/not-a-uuid/memories', undefined],
        ['POST', `/api/bots/${botA1}/memories`, { text: 'cross-user', threadId: threadA1 }],
        ['POST', `/api/bots/${guessed}/memories`, { text: 'guessed', threadId: threadA1 }],
        ['POST', '/api/bots/not-a-uuid/memories', { text: 'malformed', threadId: threadA1 }],
        ['POST', `/api/memories/${memoryA1.id}/approvals`, { bot: true, thread: false }],
        ['POST', `/api/memories/${guessed}/approvals`, { bot: true, thread: false }],
        ['POST', '/api/memories/not-a-uuid/approvals', { bot: true, thread: false }],
        ['GET', `/api/skills/${skillA1.id}`, undefined],
        ['GET', `/api/skills/${guessed}`, undefined],
        ['GET', '/api/skills/not-a-uuid', undefined],
        ['POST', `/api/skills/${skillA1.id}/attach`, { botId: botB1 }],
        ['POST', `/api/skills/${guessed}/attach`, { botId: botB1 }],
        ['POST', '/api/skills/not-a-uuid/attach', { botId: botB1 }],
        ['POST', `/api/skills/${skillA1.id}/detach`, undefined],
        ['POST', `/api/skills/${guessed}/detach`, undefined],
        ['POST', '/api/skills/not-a-uuid/detach', undefined],
        ['GET', `/api/skills?botId=${botA1}`, undefined],
        ['GET', `/api/skills?botId=${guessed}`, undefined],
        ['GET', '/api/skills?botId=not-a-uuid', undefined],
      ];

      for (const [method, path, body] of probes) {
        const response = await requestB(path, {
          method,
          csrf: method !== 'GET',
          ...(body === undefined ? {} : { body }),
        });

        assert.equal(response.status, 404, `${method} ${path}`);
        assert.deepEqual(response.body, NOT_FOUND, `${method} ${path}`);
      }

      // A create cannot borrow another account's conversation even when the
      // body is otherwise valid.
      const skillBorrow = await requestB('/api/skills', {
        method: 'POST',
        csrf: true,
        body: { name: 'borrowed', bodyMarkdown: 'x', botId: botA1 },
      });
      assert.equal(skillBorrow.status, 404);
      assert.deepEqual(skillBorrow.body, NOT_FOUND);

      // Foreign writes left no owned rows behind.
      const counts = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM bots WHERE owner_user_id = $1) AS a_bots,
           (SELECT count(*)::int FROM bots WHERE owner_user_id = $2) AS b_bots,
           (SELECT count(*)::int FROM memories WHERE owner_user_id = $2) AS b_memories,
           (SELECT count(*)::int FROM skills WHERE owner_user_id = $2) AS b_skills,
           (SELECT count(*)::int FROM artifacts WHERE owner_user_id = $2) AS b_artifacts`,
        [userA, userB],
      );
      assert.equal(counts.rows[0].b_bots, 1);
      assert.equal(counts.rows[0].b_memories, 1);
      assert.equal(counts.rows[0].b_skills, 1);
      assert.equal(counts.rows[0].b_artifacts, 1);
    });

    test('an unconfigured storage root refuses bytes but not metadata', async () => {
      const { ApiRuntime } = await import('../dist/api/api-runtime.js');
      const previous = process.env.HABI_ATTACHMENT_STORAGE_ROOT;
      const previousDatabase = process.env.DATABASE_URL;
      delete process.env.HABI_ATTACHMENT_STORAGE_ROOT;
      process.env.DATABASE_URL = databaseUrl;

      const runtime = new ApiRuntime();

      try {
        const attachments = runtime.getAttachments();
        const metadata = await attachments.getMetadata(userA, attachmentAText.id);
        assert.equal(metadata.id, attachmentAText.id);

        await assert.rejects(
          () => attachments.readContent(userA, attachmentAText.id),
          (error) => {
            assert.equal(error.code, 'api_unavailable');
            assert.equal(error.status, 503);
            return true;
          },
        );
      } finally {
        await runtime.onModuleDestroy();
        if (previous !== undefined) {
          process.env.HABI_ATTACHMENT_STORAGE_ROOT = previous;
        }
        if (previousDatabase !== undefined) {
          process.env.DATABASE_URL = previousDatabase;
        }
      }
    });
  },
);

describe('P1 content API flag gate', () => {
  test('HABI_P1_API unset registers none of the content routes', async () => {
    const server = await startChildApi();

    try {
      const health = await fetch(`${server.base}/health`);
      assert.equal(health.status, 200);

      const routes = [
        ['POST', '/api/bots'],
        ['PATCH', `/api/bots/${randomUUID()}`],
        ['DELETE', `/api/bots/${randomUUID()}`],
        ['POST', `/api/bots/${randomUUID()}/threads`],
        ['PATCH', `/api/threads/${randomUUID()}`],
        ['DELETE', `/api/threads/${randomUUID()}`],
        ['GET', `/api/threads/${randomUUID()}/attachments`],
        ['GET', `/api/artifacts`],
        ['POST', '/api/artifacts'],
        ['GET', `/api/bots/${randomUUID()}/memories`],
        ['POST', `/api/memories/${randomUUID()}/approvals`],
        ['GET', '/api/skills'],
        ['GET', '/api/search?q=zebraalpha'],
      ];

      for (const [method, path] of routes) {
        const response = await fetch(`${server.base}${path}`, {
          method,
          headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
          body: method === 'GET' ? undefined : '{}',
        });

        // If the route existed, the session guard would answer 401. A 404
        // proves the module was not imported.
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    } finally {
      await server.stop();
    }
  });
});
