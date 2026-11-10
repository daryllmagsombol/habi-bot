/**
 * Missing P1 API routes: `PATCH /api/skills/:skillId` and `GET /api/account`.
 *
 * Boots the real Nest application in-process with `HABI_P1_API=1` against an
 * ephemeral PostgreSQL 18.6 container and the real migrations. Sessions are
 * minted through the H-017 `SessionService` (there is no product login route in
 * this slice), then both routes are driven over HTTP.
 *
 * Coverage:
 *   auth        both routes reject no session; the PATCH rejects no/wrong CSRF
 *   skills      each field patches individually; one appended version per patch
 *   history     every earlier version snapshot is unchanged; omitted fields kept
 *   conflicts   duplicate live name is 409; archived is 409; tombstone is 404
 *   bounds      name/description/body bounds, control characters, empty patch
 *   bodies      non-object and syntax-broken bodies are refused
 *   account     exact identity-only shape, server-loaded values, no-store
 *   isolation   B's PATCH of A's skill is the same 404 as a guessed id; B's
 *               account read returns B's profile and A's returns A's
 *   flag gate   both routes are absent when HABI_P1_API is unset
 *
 * Docker unavailability skips the Postgres suite; the container is removed
 * afterwards. No provider, credential, queue, or model call is involved.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
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
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const NOT_FOUND = { error: { code: 'not_found' } };

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

function expectError(body, code) {
  assert.deepEqual(body, { error: { code } });
}

const dockerReady = dockerAvailable();

describe(
  'PATCH skills and GET account',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let password = '';
    let databaseUrl = '';
    let pool;
    let app;
    let base = '';
    let sessionA;
    let sessionB;
    let requestA;
    let requestB;
    let userA;
    let userB;
    let emailA;
    let emailB;
    let skills;
    let archivedSkillId = '';
    let deletedSkillId = '';

    async function seedUser(email) {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO users (id, email, email_verified_at) VALUES ($1, $2, now())',
        [id, email],
      );
      return id;
    }

    async function createSkill(name, extra = {}) {
      const created = await requestA('/api/skills', {
        method: 'POST',
        csrf: true,
        body: { name, ...extra },
      });

      assert.equal(created.status, 201, JSON.stringify(created.body));

      return created.body.skill;
    }

    before(async () => {
      containerName = `habi-gaps-${randomBytes(6).toString('hex')}`;
      password = randomBytes(24).toString('hex');

      const container = spawnSync(
        'docker',
        [
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
      assert.match(applied.stdout, /applied\s+0017_account_deletion\.sql/);

      emailA = 'gaps-alpha@example.test';
      emailB = 'gaps-beta@example.test';
      userA = await seedUser(emailA);
      userB = await seedUser(emailB);

      const skillsModule = await import('../dist/skills/index.js');
      skills = new skillsModule.SkillService(pool);

      process.env.NODE_ENV = 'test';
      process.env.HABI_P1_API = '1';
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

    test('both routes reject a request with no session', async () => {
      const routes = [
        ['GET', '/api/account'],
        ['PATCH', `/api/skills/${randomUUID()}`],
      ];

      for (const [method, path] of routes) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' ? undefined : '{}',
        });

        assert.equal(response.status, 401, `${method} ${path}`);
        assert.deepEqual(await readBody(response), UNAUTHENTICATED);
      }
    });

    test('PATCH appends one version per field and preserves history', async () => {
      const skill = await createSkill('Patch target', {
        description: 'Original description.',
        bodyMarkdown: '# Original body\n',
      });

      assert.equal(skill.version, 1);
      assert.equal(skill.status, 'draft');
      assert.equal(skill.botId, null);

      const renamed = await requestA(`/api/skills/${skill.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'Renamed skill' },
      });

      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.skill.id, skill.id);
      assert.equal(renamed.body.skill.name, 'Renamed skill');
      assert.equal(renamed.body.skill.description, 'Original description.');
      assert.equal(renamed.body.skill.bodyMarkdown, '# Original body\n');
      assert.equal(renamed.body.skill.version, 2);
      assert.equal(renamed.body.skill.status, 'draft');
      assert.equal(renamed.body.skill.botId, null);

      let page = await skills.listVersions(userA, skill.id);
      assert.deepEqual(
        page.versions.map((version) => version.version),
        [2, 1],
      );
      assert.equal(page.versions[0].name, 'Renamed skill');
      assert.equal(page.versions[0].description, 'Original description.');
      assert.equal(page.versions[0].bodyMarkdown, '# Original body\n');
      assert.equal(page.versions[1].name, 'Patch target');

      const described = await requestA(`/api/skills/${skill.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { description: 'Updated description.' },
      });

      assert.equal(described.status, 200);
      assert.equal(described.body.skill.name, 'Renamed skill');
      assert.equal(described.body.skill.description, 'Updated description.');
      assert.equal(described.body.skill.bodyMarkdown, '# Original body\n');
      assert.equal(described.body.skill.version, 3);

      const rebody = await requestA(`/api/skills/${skill.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { bodyMarkdown: '# Updated body\n' },
      });

      assert.equal(rebody.status, 200);
      assert.equal(rebody.body.skill.name, 'Renamed skill');
      assert.equal(rebody.body.skill.description, 'Updated description.');
      assert.equal(rebody.body.skill.bodyMarkdown, '# Updated body\n');
      assert.equal(rebody.body.skill.version, 4);

      // Identity, lifecycle, attachment, and version number are not patchable.
      const ignored = await requestA(`/api/skills/${skill.id}`, {
        method: 'PATCH',
        csrf: true,
        body: {
          name: 'Renamed again',
          id: randomUUID(),
          ownerUserId: userB,
          version: 99,
          status: 'archived',
          botId: randomUUID(),
          archivedAt: new Date().toISOString(),
          deletedAt: new Date().toISOString(),
        },
      });

      assert.equal(ignored.status, 200);
      assert.equal(ignored.body.skill.id, skill.id);
      assert.equal(ignored.body.skill.name, 'Renamed again');
      assert.equal(ignored.body.skill.version, 5);
      assert.equal(ignored.body.skill.status, 'draft');
      assert.equal(ignored.body.skill.botId, null);
      assert.equal(ignored.body.skill.archivedAt, null);
      assert.equal(ignored.body.skill.deletedAt, null);

      page = await skills.listVersions(userA, skill.id);
      assert.deepEqual(
        page.versions.map((version) => version.version),
        [5, 4, 3, 2, 1],
      );
      // Every snapshot is the value set at that step; nothing was rewritten.
      assert.equal(page.versions[1].name, 'Renamed skill');
      assert.equal(page.versions[1].description, 'Updated description.');
      assert.equal(page.versions[1].bodyMarkdown, '# Updated body\n');
      assert.equal(page.versions[2].name, 'Renamed skill');
      assert.equal(page.versions[2].description, 'Updated description.');
      assert.equal(page.versions[2].bodyMarkdown, '# Original body\n');
      assert.equal(page.versions[3].name, 'Renamed skill');
      assert.equal(page.versions[3].description, 'Original description.');
      assert.equal(page.versions[4].name, 'Patch target');
      assert.equal(page.versions[4].bodyMarkdown, '# Original body\n');

      const stored = await pool.query(
        `SELECT owner_user_id, version, status, bot_id FROM skills WHERE id = $1`,
        [skill.id],
      );
      assert.deepEqual(stored.rows[0], {
        owner_user_id: userA,
        version: 5,
        status: 'draft',
        bot_id: null,
      });

      const history = await pool.query(
        'SELECT count(*)::int AS count FROM skill_versions WHERE skill_id = $1',
        [skill.id],
      );
      assert.equal(history.rows[0].count, 5);
    });

    test('PATCH refuses a duplicate live name and out-of-bounds input', async () => {
      const first = await createSkill('Conflict one');
      const second = await createSkill('Conflict two');

      const conflict = await requestA(`/api/skills/${first.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'Conflict two' },
      });
      assert.equal(conflict.status, 409);
      expectError(conflict.body, 'skill_name_conflict');

      // The live-name index is lower(name), so case alone cannot duplicate it.
      const caseConflict = await requestA(`/api/skills/${first.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'CONFLICT TWO' },
      });
      assert.equal(caseConflict.status, 409);
      expectError(caseConflict.body, 'skill_name_conflict');

      const untouched = await requestA(`/api/skills/${first.id}`);
      assert.equal(untouched.status, 200);
      assert.equal(untouched.body.skill.name, 'Conflict one');
      assert.equal(untouched.body.skill.version, 1);

      const other = await requestA(`/api/skills/${second.id}`);
      assert.equal(other.body.skill.version, 1);

      const target = await createSkill('Bounds target');

      const empty = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: {},
      });
      assert.equal(empty.status, 400);
      expectError(empty.body, 'invalid_input');

      const blankName = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: '   ' },
      });
      assert.equal(blankName.status, 400);
      expectError(blankName.body, 'invalid_input');

      const longName = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'n'.repeat(81) },
      });
      assert.equal(longName.status, 400);
      expectError(longName.body, 'invalid_input');

      const controlName = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'bad\rname' },
      });
      assert.equal(controlName.status, 400);
      expectError(controlName.body, 'invalid_input');

      const longestName = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'n'.repeat(80) },
      });
      assert.equal(longestName.status, 200);
      assert.equal(longestName.body.skill.name.length, 80);
      assert.equal(longestName.body.skill.version, 2);

      const longDescription = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { description: 'd'.repeat(501) },
      });
      assert.equal(longDescription.status, 400);
      expectError(longDescription.body, 'invalid_input');

      const longestDescription = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { description: 'd'.repeat(500) },
      });
      assert.equal(longestDescription.status, 200);
      assert.equal(longestDescription.body.skill.description.length, 500);
      assert.equal(longestDescription.body.skill.version, 3);

      const longBody = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { bodyMarkdown: 'b'.repeat(65537) },
      });
      assert.equal(longBody.status, 400);
      expectError(longBody.body, 'invalid_input');

      const longestBody = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { bodyMarkdown: 'b'.repeat(65536) },
      });
      assert.equal(longestBody.status, 200);
      assert.equal(
        Buffer.byteLength(longestBody.body.skill.bodyMarkdown, 'utf8'),
        65536,
      );
      assert.equal(longestBody.body.skill.version, 4);

      const wrongType = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 42 },
      });
      assert.equal(wrongType.status, 400);
      expectError(wrongType.body, 'invalid_input');

      // The JSON transport's strict mode refuses a primitive body before the
      // controller, so only the status is the shared 400 vocabulary.
      const nullBody = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: null,
      });
      assert.equal(nullBody.status, 400);

      const arrayBody = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: [{ name: 'array' }],
      });
      assert.equal(arrayBody.status, 400);
      expectError(arrayBody.body, 'invalid_input');

      const stringBody = await requestA(`/api/skills/${target.id}`, {
        method: 'PATCH',
        csrf: true,
        body: 'not-an-object',
      });
      assert.equal(stringBody.status, 400);

      // Syntax-broken JSON is refused by the transport before the controller.
      const malformed = await fetch(`${base}/api/skills/${target.id}`, {
        method: 'PATCH',
        headers: {
          cookie: `habi_session=${sessionA.sessionId}`,
          'x-csrf-token': sessionA.csrfToken,
          'content-type': 'application/json',
        },
        body: '{"name":',
      });
      assert.equal(malformed.status, 400);
      await malformed.text();

      const page = await skills.listVersions(userA, target.id);
      assert.deepEqual(
        page.versions.map((version) => version.version),
        [4, 3, 2, 1],
      );
    });

    test('PATCH refuses archived and deleted skills without rewriting history', async () => {
      const archived = await createSkill('Archived skill');
      archivedSkillId = archived.id;
      await skills.archive(userA, archived.id);

      const archivedPatch = await requestA(`/api/skills/${archived.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { description: 'not allowed' },
      });
      assert.equal(archivedPatch.status, 409);
      expectError(archivedPatch.body, 'skill_unavailable');

      const archivedRead = await requestA(`/api/skills/${archived.id}`);
      assert.equal(archivedRead.status, 200);
      assert.equal(archivedRead.body.skill.status, 'archived');
      assert.equal(archivedRead.body.skill.version, 1);
      assert.equal(archivedRead.body.skill.description, '');

      const archivedVersions = await skills.listVersions(userA, archived.id);
      assert.deepEqual(
        archivedVersions.versions.map((version) => version.version),
        [1],
      );

      // A tombstone is invisible through the live-skill lookup, so it stays the
      // same non-enumerating 404 as an unknown or foreign id.
      const deleted = await createSkill('Deleted skill');
      deletedSkillId = deleted.id;
      await skills.delete(userA, deleted.id);

      const deletedPatch = await requestA(`/api/skills/${deleted.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'resurrected' },
      });
      assert.equal(deletedPatch.status, 404);
      assert.deepEqual(deletedPatch.body, NOT_FOUND);

      const deletedRead = await requestA(`/api/skills/${deleted.id}`);
      assert.equal(deletedRead.status, 404);
      assert.deepEqual(deletedRead.body, NOT_FOUND);

      const retained = await pool.query(
        `SELECT s.status, s.version, count(v.id)::int AS versions
           FROM skills s
           JOIN skill_versions v ON v.skill_id = s.id
          WHERE s.id = $1
          GROUP BY s.status, s.version`,
        [deleted.id],
      );
      assert.deepEqual(retained.rows[0], {
        status: 'deleted',
        version: 1,
        versions: 1,
      });
    });

    test('PATCH requires the CSRF token; the account read does not', async () => {
      const skill = await createSkill('CSRF target');

      const noToken = await requestA(`/api/skills/${skill.id}`, {
        method: 'PATCH',
        body: { name: 'no csrf' },
      });
      assert.equal(noToken.status, 403);
      expectError(noToken.body, 'csrf_invalid');

      const wrongToken = await requestA(`/api/skills/${skill.id}`, {
        method: 'PATCH',
        csrf: 'wrong',
        body: { name: 'wrong csrf' },
      });
      assert.equal(wrongToken.status, 403);
      expectError(wrongToken.body, 'csrf_invalid');

      const unchanged = await requestA(`/api/skills/${skill.id}`);
      assert.equal(unchanged.body.skill.name, 'CSRF target');
      assert.equal(unchanged.body.skill.version, 1);

      const account = await requestA('/api/account');
      assert.equal(account.status, 200);
    });

    test('GET /api/account returns only the session actor identity', async () => {
      const response = await requestA('/api/account');

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');

      const { account } = response.body;
      assert.deepEqual(Object.keys(account).sort(), [
        'createdAt',
        'email',
        'emailVerifiedAt',
        'status',
        'updatedAt',
        'userId',
      ]);

      const stored = await pool.query(
        `SELECT id, email, status, created_at, updated_at, email_verified_at
           FROM users
          WHERE id = $1`,
        [userA],
      );
      const row = stored.rows[0];

      assert.equal(account.userId, row.id);
      assert.equal(account.email, emailA);
      assert.equal(account.email, row.email);
      assert.equal(account.status, row.status);
      assert.equal(account.status, 'active');
      assert.equal(account.createdAt, new Date(row.created_at).toISOString());
      assert.equal(account.updatedAt, new Date(row.updated_at).toISOString());
      assert.equal(
        account.emailVerifiedAt,
        new Date(row.email_verified_at).toISOString(),
      );

      // Not an export and not a credential/session/identity dump.
      for (const forbidden of [
        'passwordHash',
        'recoveryEmail',
        'manifest',
        'exportedAt',
        'counts',
        'bots',
        'conversations',
        'messages',
        'runs',
        'artifacts',
        'attachments',
        'skills',
        'memories',
        'sessions',
        'csrfToken',
        'ssoIdentities',
      ]) {
        assert.equal(forbidden in account, false, forbidden);
      }
    });

    test('two accounts are isolated on the skill patch and account read', async () => {
      const skill = await createSkill('Isolation target');
      const before = await skills.listVersions(userA, skill.id);
      assert.equal(before.versions.length, 1);

      const crossAccount = await requestB(`/api/skills/${skill.id}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'borrowed' },
      });
      assert.equal(crossAccount.status, 404);
      assert.deepEqual(crossAccount.body, NOT_FOUND);

      const guessed = await requestB(`/api/skills/${randomUUID()}`, {
        method: 'PATCH',
        csrf: true,
        body: { name: 'guessed' },
      });
      assert.equal(guessed.status, 404);
      assert.deepEqual(guessed.body, NOT_FOUND);

      const malformed = await requestB('/api/skills/not-a-uuid', {
        method: 'PATCH',
        csrf: true,
        body: { name: 'malformed' },
      });
      assert.equal(malformed.status, 404);
      assert.deepEqual(malformed.body, NOT_FOUND);

      // A's archived and tombstoned skills are indistinguishable from unknown
      // ids to another account: never a lifecycle-conflict hint.
      for (const foreignId of [archivedSkillId, deletedSkillId]) {
        const response = await requestB(`/api/skills/${foreignId}`, {
          method: 'PATCH',
          csrf: true,
          body: { name: 'foreign lifecycle' },
        });
        assert.equal(response.status, 404);
        assert.deepEqual(response.body, NOT_FOUND);
      }

      const unchanged = await requestA(`/api/skills/${skill.id}`);
      assert.equal(unchanged.status, 200);
      assert.equal(unchanged.body.skill.name, 'Isolation target');
      assert.equal(unchanged.body.skill.version, 1);
      assert.equal(
        (await skills.listVersions(userA, skill.id)).versions.length,
        1,
      );

      const accountA = await requestA('/api/account');
      const accountB = await requestB('/api/account');

      assert.equal(accountA.status, 200);
      assert.equal(accountB.status, 200);
      assert.equal(accountA.body.account.userId, userA);
      assert.equal(accountA.body.account.email, emailA);
      assert.equal(accountB.body.account.userId, userB);
      assert.equal(accountB.body.account.email, emailB);
      assert.notEqual(accountA.body.account.userId, accountB.body.account.userId);
      assert.notEqual(accountA.body.account.email, accountB.body.account.email);

      // A query identity field is not an access key: it cannot select B.
      const spoofed = await requestA(`/api/account?userId=${userB}&email=${emailB}`);
      assert.equal(spoofed.status, 200);
      assert.equal(spoofed.body.account.userId, userA);
      assert.equal(spoofed.body.account.email, emailA);
    });
  },
);

describe('PATCH skills and GET account flag gate', () => {
  test('HABI_P1_API unset registers neither route', async () => {
    const server = await startChildApi();

    try {
      const health = await fetch(`${server.base}/health`);
      assert.equal(health.status, 200);

      const routes = [
        ['GET', `/api/account`],
        ['PATCH', `/api/skills/${randomUUID()}`],
      ];

      for (const [method, path] of routes) {
        const response = await fetch(`${server.base}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' ? undefined : '{}',
        });

        // If the route existed, the session guard would answer 401. A 404
        // proves the module was not imported.
        assert.equal(response.status, 404, `${method} ${path}`);
        await response.text();
      }
    } finally {
      await server.stop();
    }
  });
});
