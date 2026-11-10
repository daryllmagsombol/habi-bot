/**
 * H-028 (#28) artifact persistence integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies the real migrations (0001-0013), and exercises ArtifactService.
 * Two users with separate Bots and conversations prove owner isolation. Skips
 * cleanly when the Docker daemon is unavailable; the container and pool are
 * removed afterwards.
 *
 * Coverage:
 *   lifecycle           create -> append versions -> read current/historical
 *   immutability        version rows reject UPDATE/DELETE; the service only appends
 *   restore             a historical version is copied forward, history intact
 *   isolation           every operation for a foreign, guessed, or malformed id
 *   deletion            tombstone + stale reference, idempotent, foreign safe
 *   bounds              title, 1 MiB content, version, kind, and status
 *   content safety      NUL/UTF-16 refusal and injection-shaped text stays inert
 *   integrity           a tampered digest fails closed before text is returned
 *   listing             keyset artifacts and metadata-only version pages
 *   scope               conversation/run ownership and composite foreign keys
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const MAX_ARTIFACT_BYTES = 1_048_576;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
}

function dryRun(databaseUrl) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl, '--dry-run'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: 60000,
    },
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

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function rejectsWithPgCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function sha256Of(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const dockerReady = dockerAvailable();

describe(
  'H-028 artifacts',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let port = 0;
    let password = '';
    let pool;
    let artifacts;
    let databaseUrl = '';
    let userA;
    let userB;
    let conversationA1;
    let conversationA2;
    let conversationB1;
    let runA1;

    async function createArtifact(actor, overrides = {}) {
      return artifacts.create(actor, {
        kind: 'markdown',
        title: 'Artifact',
        content: 'body',
        ...overrides,
      });
    }

    before(async () => {
      containerName = `habi-h028-${randomBytes(6).toString('hex')}`;
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

      port = Number.parseInt(portResult.stdout.trim().split(':').pop() ?? '', 10);
      assert.ok(Number.isInteger(port) && port > 0, 'Docker did not publish PostgreSQL');

      pool = new Pool({
        host: '127.0.0.1',
        port,
        user: DOCKER_USER,
        password,
        database: DOCKER_DATABASE,
        max: 6,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const pending = dryRun(databaseUrl);
      assert.equal(pending.status, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0013_artifacts\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0007_attachments\.sql/);
      assert.match(applied.stdout, /applied\s+0011_memory\.sql/);
      assert.match(applied.stdout, /applied\s+0012_extraction\.sql/);
      assert.match(applied.stdout, /applied\s+0013_artifacts\.sql/);

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      const { ArtifactService } = await import('../dist/artifacts/index.js');

      artifacts = new ArtifactService(pool);

      userA = randomUUID();
      userB = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [userA, userB]);

      const botA = randomUUID();
      const botB = randomUUID();
      await pool.query(
        'INSERT INTO bots (id, owner_user_id) VALUES ($1, $2), ($3, $4)',
        [botA, userA, botB, userB],
      );

      conversationA1 = randomUUID();
      conversationA2 = randomUUID();
      conversationB1 = randomUUID();
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'A artifacts'), ($4, $2, $3, 'A pagination'),
                ($5, $6, $7, 'B artifacts')`,
        [
          conversationA1,
          userA,
          botA,
          conversationA2,
          conversationB1,
          userB,
          botB,
        ],
      );

      runA1 = randomUUID();
      await pool.query(
        'INSERT INTO runs (id, owner_user_id, conversation_id) VALUES ($1, $2, $3)',
        [runA1, userA, conversationA1],
      );
    });

    after(async () => {
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

    test('creates a draft artifact with a server-generated id and version 1', async () => {
      const content = '# Plan\n\nGenerated **text**.\n';
      const detail = await artifacts.create(userA, {
        kind: 'markdown',
        title: '  Plan  ',
        content,
        conversationId: conversationA1,
        runId: runA1,
      });

      assert.match(detail.artifact.id, UUID_PATTERN);
      assert.equal(detail.artifact.title, 'Plan');
      assert.equal(detail.artifact.kind, 'markdown');
      assert.equal(detail.artifact.status, 'draft');
      assert.equal(detail.artifact.currentVersion, 1);
      assert.equal(detail.artifact.conversationId, conversationA1);
      assert.equal(detail.artifact.runId, runA1);
      assert.equal(detail.artifact.deletedAt, null);

      assert.equal(detail.version.artifactId, detail.artifact.id);
      assert.equal(detail.version.version, 1);
      assert.equal(detail.version.content, content);
      assert.equal(detail.version.byteSize, Buffer.byteLength(content, 'utf8'));
      assert.equal(detail.version.contentSha256, sha256Of(content));
      assert.equal(detail.version.createdBy, userA);

      const stored = await pool.query(
        'SELECT owner_user_id FROM artifacts WHERE id = $1',
        [detail.artifact.id],
      );
      assert.equal(stored.rows[0].owner_user_id, userA);

      // Client-supplied ids and owners are not inputs the service reads.
      const forgedId = randomUUID();
      const forged = await artifacts.create(userA, {
        kind: 'text',
        title: 'Forged',
        content: 'not yours',
        id: forgedId,
        ownerUserId: userB,
      });
      assert.notEqual(forged.artifact.id, forgedId);

      const forgedOwner = await pool.query(
        'SELECT owner_user_id FROM artifacts WHERE id = $1',
        [forged.artifact.id],
      );
      assert.equal(forgedOwner.rows[0].owner_user_id, userA);
      await rejectsWithCode(artifacts.get(userA, forgedId), 'not_found');
    });

    test('appends versions without mutating history', async () => {
      const created = await createArtifact(userA, {
        title: 'Versioned',
        content: 'version one',
        conversationId: conversationA1,
      });
      const id = created.artifact.id;

      const updated = await artifacts.update(userA, id, {
        content: 'version two',
        title: 'Versioned twice',
        status: 'final',
      });

      assert.equal(updated.artifact.currentVersion, 2);
      assert.equal(updated.artifact.title, 'Versioned twice');
      assert.equal(updated.artifact.status, 'final');
      assert.equal(updated.version.version, 2);
      assert.equal(updated.version.content, 'version two');

      const first = await artifacts.get(userA, id, { version: 1 });
      assert.equal(first.version.version, 1);
      assert.equal(first.version.content, 'version one');
      // Metadata reads reflect the current artifact row, not the old version.
      assert.equal(first.artifact.currentVersion, 2);
      assert.equal(first.artifact.title, 'Versioned twice');

      const latest = await artifacts.get(userA, id);
      assert.equal(latest.version.version, 2);
      assert.equal(latest.version.content, 'version two');

      const persisted = await pool.query(
        `SELECT content FROM artifact_versions
          WHERE artifact_id = $1 AND version = 1`,
        [id],
      );
      assert.equal(persisted.rows[0].content, 'version one');

      // Omitted fields keep the stored kind, status, and title.
      const third = await artifacts.update(userA, id, { content: 'version three' });
      assert.equal(third.artifact.currentVersion, 3);
      assert.equal(third.artifact.kind, 'markdown');
      assert.equal(third.artifact.status, 'final');
      assert.equal(third.artifact.title, 'Versioned twice');
    });

    test('version rows are immutable at the database level', async () => {
      const created = await createArtifact(userA, {
        title: 'Immutable',
        content: 'original body',
        conversationId: conversationA1,
      });
      const id = created.artifact.id;

      await rejectsWithPgCode(
        pool.query(
          `UPDATE artifact_versions SET content = 'rewritten'
            WHERE artifact_id = $1 AND version = 1`,
          [id],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          'DELETE FROM artifact_versions WHERE artifact_id = $1 AND version = 1',
          [id],
        ),
        '23514',
      );

      const persisted = await pool.query(
        `SELECT content, content_sha256, byte_size FROM artifact_versions
          WHERE artifact_id = $1 AND version = 1`,
        [id],
      );
      assert.equal(persisted.rows[0].content, 'original body');
      assert.equal(persisted.rows[0].content_sha256, sha256Of('original body'));
      assert.equal(persisted.rows[0].byte_size, Buffer.byteLength('original body'));
    });

    test('restores a historical version by appending a copy', async () => {
      const created = await createArtifact(userA, {
        title: 'Restorable',
        content: 'original',
        conversationId: conversationA1,
      });
      const id = created.artifact.id;

      await artifacts.update(userA, id, { content: 'edited' });
      const restored = await artifacts.restoreVersion(userA, id, 1);

      assert.equal(restored.artifact.currentVersion, 3);
      assert.equal(restored.version.version, 3);
      assert.equal(restored.version.content, 'original');
      assert.equal(restored.version.contentSha256, sha256Of('original'));
      assert.equal(restored.version.createdBy, userA);

      assert.equal((await artifacts.get(userA, id, { version: 1 })).version.content, 'original');
      assert.equal((await artifacts.get(userA, id, { version: 2 })).version.content, 'edited');
      assert.equal((await artifacts.get(userA, id)).version.content, 'original');

      await rejectsWithCode(artifacts.restoreVersion(userA, id, 99), 'not_found');
      await rejectsWithCode(artifacts.restoreVersion(userA, id, 0), 'invalid_input');
    });

    test('owner isolation holds for every operation', async () => {
      const created = await createArtifact(userA, {
        title: 'Owned',
        content: 'owned body',
        conversationId: conversationA1,
      });
      const id = created.artifact.id;

      await rejectsWithCode(artifacts.get(userB, id), 'not_found');
      await rejectsWithCode(artifacts.get(userB, id, { version: 1 }), 'not_found');
      await rejectsWithCode(
        artifacts.update(userB, id, { content: 'hijacked' }),
        'not_found',
      );
      await rejectsWithCode(artifacts.delete(userB, id), 'not_found');
      await rejectsWithCode(artifacts.restoreVersion(userB, id, 1), 'not_found');
      await rejectsWithCode(artifacts.listVersions(userB, id), 'not_found');

      const foreignPage = await artifacts.list(userB, {
        conversationId: conversationA1,
      });
      assert.deepEqual(foreignPage.artifacts, []);
      assert.equal(foreignPage.nextCursor, null);

      const bPage = await artifacts.list(userB);
      assert.ok(bPage.artifacts.every((artifact) => artifact.id !== id));

      await rejectsWithCode(
        artifacts.create(userB, {
          kind: 'text',
          title: 'Foreign conversation',
          content: 'x',
          conversationId: conversationA1,
        }),
        'not_found',
      );
      await rejectsWithCode(
        artifacts.create(userB, {
          kind: 'text',
          title: 'Foreign run',
          content: 'x',
          conversationId: conversationA1,
          runId: runA1,
        }),
        'not_found',
      );

      const stillOwned = await artifacts.get(userA, id);
      assert.equal(stillOwned.version.content, 'owned body');
      assert.equal(stillOwned.artifact.status, 'draft');
    });

    test('guessed and malformed identifiers are one not-found', async () => {
      const guessed = randomUUID();

      await rejectsWithCode(artifacts.get(userA, guessed), 'not_found');
      await rejectsWithCode(artifacts.get(userA, guessed, { version: 1 }), 'not_found');
      await rejectsWithCode(
        artifacts.update(userA, guessed, { content: 'x' }),
        'not_found',
      );
      await rejectsWithCode(artifacts.delete(userA, guessed), 'not_found');
      await rejectsWithCode(artifacts.restoreVersion(userA, guessed, 1), 'not_found');
      await rejectsWithCode(artifacts.listVersions(userA, guessed), 'not_found');

      for (const malformed of ['', 'not-a-uuid', '../../etc/passwd']) {
        await rejectsWithCode(artifacts.get(userA, malformed), 'not_found');
        await rejectsWithCode(
          artifacts.update(userA, malformed, { content: 'x' }),
          'not_found',
        );
        await rejectsWithCode(artifacts.delete(userA, malformed), 'not_found');
        await rejectsWithCode(artifacts.listVersions(userA, malformed), 'not_found');
      }

      await rejectsWithCode(
        artifacts.list(userA, { conversationId: 'not-a-uuid' }),
        'not_found',
      );
      await rejectsWithCode(
        artifacts.list(userA, { cursor: 'not-a-cursor' }),
        'invalid_cursor',
      );
    });

    test('deleted artifacts are tombstones with retained history', async () => {
      const created = await createArtifact(userA, {
        title: 'Disposable',
        content: 'soon gone',
        conversationId: conversationA1,
      });
      const id = created.artifact.id;

      const deleted = await artifacts.delete(userA, id);
      assert.equal(deleted.status, 'deleted');
      assert.equal(deleted.currentVersion, 1);
      assert.notEqual(deleted.deletedAt, null);
      assert.ok(Number.isFinite(Date.parse(deleted.deletedAt)));

      const again = await artifacts.delete(userA, id);
      assert.equal(again.status, 'deleted');
      assert.equal(again.deletedAt, deleted.deletedAt);

      await rejectsWithCode(artifacts.get(userA, id), 'not_found');
      await rejectsWithCode(artifacts.get(userA, id, { version: 1 }), 'not_found');
      await rejectsWithCode(
        artifacts.update(userA, id, { content: 'zombie' }),
        'not_found',
      );
      await rejectsWithCode(artifacts.restoreVersion(userA, id, 1), 'not_found');
      await rejectsWithCode(artifacts.listVersions(userA, id), 'not_found');

      const page = await artifacts.list(userA, { conversationId: conversationA1 });
      assert.ok(page.artifacts.every((artifact) => artifact.id !== id));

      const row = await pool.query(
        'SELECT status, deleted_at FROM artifacts WHERE id = $1',
        [id],
      );
      assert.equal(row.rows[0].status, 'deleted');
      assert.notEqual(row.rows[0].deleted_at, null);

      const versions = await pool.query(
        'SELECT count(*)::int AS count FROM artifact_versions WHERE artifact_id = $1',
        [id],
      );
      assert.equal(versions.rows[0].count, 1);
    });

    test('title, content, kind, status, and version bounds are enforced', async () => {
      for (const title of ['', '   ', 'x'.repeat(201), 'line\nbreak']) {
        await rejectsWithCode(
          createArtifact(userA, { title }),
          'invalid_input',
        );
      }

      const longestTitle = await createArtifact(userA, {
        title: 'x'.repeat(200),
        content: 'title bound',
      });
      assert.equal(longestTitle.artifact.title.length, 200);

      await rejectsWithCode(
        createArtifact(userA, { content: 'a'.repeat(MAX_ARTIFACT_BYTES + 1) }),
        'invalid_input',
      );
      await rejectsWithCode(
        createArtifact(userA, { content: 'é'.repeat(600000) }),
        'invalid_input',
      );

      const exact = await createArtifact(userA, {
        content: 'a'.repeat(MAX_ARTIFACT_BYTES),
      });
      assert.equal(exact.version.byteSize, MAX_ARTIFACT_BYTES);
      assert.equal(
        exact.version.contentSha256,
        sha256Of('a'.repeat(MAX_ARTIFACT_BYTES)),
      );

      const unicodeContent = 'emoji 😀 café — 日本語';
      const unicode = await createArtifact(userA, { content: unicodeContent });
      assert.equal(unicode.version.content, unicodeContent);
      assert.equal(
        unicode.version.byteSize,
        Buffer.byteLength(unicodeContent, 'utf8'),
      );
      assert.equal(unicode.version.contentSha256, sha256Of(unicodeContent));

      await rejectsWithCode(
        createArtifact(userA, { kind: 'pdf' }),
        'invalid_input',
      );
      await rejectsWithCode(
        createArtifact(userA, { status: 'deleted' }),
        'invalid_input',
      );
      await rejectsWithCode(
        createArtifact(userA, { content: 'nul\u0000byte' }),
        'invalid_input',
      );
      // A lone surrogate is not valid UTF-8 text and is refused, not replaced.
      await rejectsWithCode(
        createArtifact(userA, { content: 'lone\ud800surrogate' }),
        'invalid_input',
      );

      const created = await createArtifact(userA, { content: 'guarded' });
      const id = created.artifact.id;

      await rejectsWithCode(
        artifacts.update(userA, id, { status: 'deleted' }),
        'invalid_input',
      );
      for (const version of [0, -1, 1.5, '1']) {
        await rejectsWithCode(
          artifacts.get(userA, id, { version }),
          'invalid_input',
        );
        await rejectsWithCode(
          artifacts.restoreVersion(userA, id, version),
          'invalid_input',
        );
      }

      await rejectsWithPgCode(
        pool.query(`UPDATE artifacts SET title = $2 WHERE id = $1`, [
          id,
          'x'.repeat(201),
        ]),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO artifact_versions (
             artifact_id, owner_user_id, version, content, content_sha256,
             byte_size, created_by
           )
           VALUES ($1, $2, 0, 'x', $3, 1, $2)`,
          [id, userA, sha256Of('x')],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO artifact_versions (
             artifact_id, owner_user_id, version, content, content_sha256,
             byte_size, created_by
           )
           VALUES ($1, $2, 1, 'duplicate', $3, 9, $2)`,
          [id, userA, sha256Of('duplicate')],
        ),
        '23505',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO artifact_versions (
             artifact_id, owner_user_id, version, content, content_sha256,
             byte_size, created_by
           )
           VALUES ($1, $2, 2, 'abc', $3, 2, $2)`,
          [id, userA, sha256Of('abc')],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO artifact_versions (
             artifact_id, owner_user_id, version, content, content_sha256,
             byte_size, created_by
           )
           VALUES ($1, $2, 2, 'abc', 'not-a-digest', 3, $2)`,
          [id, userA],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query('UPDATE artifacts SET current_version = 0 WHERE id = $1', [id]),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query('UPDATE artifacts SET current_version = 99 WHERE id = $1', [id]),
        '23503',
      );
    });

    test('injection-shaped content stays inert text', async () => {
      const payloads = [
        "'; DROP TABLE artifacts; --",
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert(1)>',
        '{{constructor.constructor("return process")()}}',
        '../../../../etc/passwd',
        '`; rm -rf / #',
        '{"__proto__":{"polluted":true}}',
      ];
      const content = payloads.join('\n');

      const created = await createArtifact(userA, {
        kind: 'markdown',
        title: 'Payloads',
        content,
        conversationId: conversationA1,
      });

      assert.equal(created.version.content, content);
      assert.equal((await artifacts.get(userA, created.artifact.id)).version.content, content);

      const persisted = await pool.query(
        `SELECT content FROM artifact_versions
          WHERE artifact_id = $1 AND version = 1`,
        [created.artifact.id],
      );
      assert.equal(persisted.rows[0].content, content);

      const json = await createArtifact(userA, {
        kind: 'json',
        title: 'JSON text',
        content: '{"value":"</script>","path":"../../etc/passwd"}',
      });
      const readBack = await artifacts.get(userA, json.artifact.id);
      assert.equal(typeof readBack.version.content, 'string');
      assert.equal(
        readBack.version.content,
        '{"value":"</script>","path":"../../etc/passwd"}',
      );

      // The table is still present and the payload did not become SQL.
      const table = await pool.query("SELECT to_regclass('public.artifacts') AS name");
      assert.equal(table.rows[0].name, 'artifacts');
    });

    test('a tampered digest fails closed on read', async () => {
      const body = 'stored body';
      const badId = randomUUID();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO artifacts (id, owner_user_id, kind, title, current_version)
           VALUES ($1, $2, 'text', 'Tampered', 1)`,
          [badId, userA],
        );
        await client.query(
          `INSERT INTO artifact_versions (
             artifact_id, owner_user_id, version, content, content_sha256,
             byte_size, created_by
           )
           VALUES ($1, $2, 1, $3, $4, $5, $2)`,
          [badId, userA, body, sha256Of('different body'), Buffer.byteLength(body)],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      await assert.rejects(artifacts.get(userA, badId), (error) => {
        assert.equal(error.name, 'ArtifactIntegrityError');
        assert.equal(error.code, 'artifact_integrity');
        return true;
      });

      const good = await createArtifact(userA, { content: 'trusted body' });
      assert.equal(
        (await artifacts.get(userA, good.artifact.id)).version.content,
        'trusted body',
      );
    });

    test('lists artifacts with keyset pagination', async () => {
      const created = [];

      for (let index = 0; index < 5; index += 1) {
        created.push(
          await createArtifact(userA, {
            title: `Paged ${index}`,
            content: `page ${index}`,
            conversationId: conversationA2,
          }),
        );
      }

      const first = await artifacts.list(userA, {
        conversationId: conversationA2,
        limit: 2,
      });
      assert.equal(first.artifacts.length, 2);
      assert.notEqual(first.nextCursor, null);

      const second = await artifacts.list(userA, {
        conversationId: conversationA2,
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.equal(second.artifacts.length, 2);
      assert.notEqual(second.nextCursor, null);

      const third = await artifacts.list(userA, {
        conversationId: conversationA2,
        limit: 2,
        cursor: second.nextCursor,
      });
      assert.equal(third.artifacts.length, 1);
      assert.equal(third.nextCursor, null);

      const all = [...first.artifacts, ...second.artifacts, ...third.artifacts];
      assert.equal(new Set(all.map((artifact) => artifact.id)).size, 5);

      for (let index = 1; index < all.length; index += 1) {
        assert.ok(
          all[index - 1].updatedAt >= all[index].updatedAt,
          'pages must stay newest first',
        );
      }

      await rejectsWithCode(
        artifacts.list(userA, {
          conversationId: conversationA1,
          cursor: first.nextCursor,
        }),
        'invalid_cursor',
      );
      await rejectsWithCode(artifacts.list(userA, { limit: 0 }), 'invalid_input');
      assert.equal(created.length, 5);
    });

    test('lists versions as bounded metadata without bodies', async () => {
      const created = await createArtifact(userA, {
        title: 'Version paging',
        content: 'body one',
        conversationId: conversationA1,
      });
      const id = created.artifact.id;

      await artifacts.update(userA, id, { content: 'body two' });
      await artifacts.update(userA, id, { content: 'body three' });

      const first = await artifacts.listVersions(userA, id, { limit: 2 });
      assert.deepEqual(
        first.versions.map((version) => version.version),
        [3, 2],
      );
      assert.equal('content' in first.versions[0], false);
      assert.equal(first.versions[0].contentSha256, sha256Of('body three'));
      assert.equal(first.versions[0].byteSize, Buffer.byteLength('body three'));
      assert.equal(first.versions[0].createdBy, userA);
      assert.notEqual(first.nextCursor, null);

      const second = await artifacts.listVersions(userA, id, {
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.versions.map((version) => version.version),
        [1],
      );
      assert.equal(second.nextCursor, null);
      assert.equal('content' in second.versions[0], false);

      await rejectsWithCode(artifacts.listVersions(userB, id), 'not_found');
      await rejectsWithCode(
        artifacts.listVersions(userA, id, { limit: 0 }),
        'invalid_input',
      );
      await rejectsWithCode(
        artifacts.listVersions(userA, id, { cursor: 'not-a-cursor' }),
        'invalid_cursor',
      );
    });

    test('conversation and run scopes are proven, not guessed', async () => {
      await rejectsWithCode(
        artifacts.create(userA, {
          kind: 'text',
          title: 'Wrong conversation',
          content: 'x',
          conversationId: conversationB1,
        }),
        'not_found',
      );
      await rejectsWithCode(
        artifacts.create(userA, {
          kind: 'text',
          title: 'Run without conversation',
          content: 'x',
          runId: runA1,
        }),
        'invalid_input',
      );

      const runOtherConversation = randomUUID();
      await pool.query(
        'INSERT INTO runs (id, owner_user_id, conversation_id) VALUES ($1, $2, $3)',
        [runOtherConversation, userA, conversationA2],
      );
      await rejectsWithCode(
        artifacts.create(userA, {
          kind: 'text',
          title: 'Run from another conversation',
          content: 'x',
          conversationId: conversationA1,
          runId: runOtherConversation,
        }),
        'not_found',
      );

      const valid = await artifacts.create(userA, {
        kind: 'text',
        title: 'Run output',
        content: 'ok',
        conversationId: conversationA1,
        runId: runA1,
      });
      assert.equal(valid.artifact.runId, runA1);

      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO artifacts (id, owner_user_id, conversation_id, kind, title)
           VALUES ($1, $2, $3, 'text', 'DB scope')`,
          [randomUUID(), userA, conversationB1],
        ),
        '23503',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO artifacts (id, owner_user_id, run_id, kind, title)
           VALUES ($1, $2, $3, 'text', 'Run without conversation')`,
          [randomUUID(), userA, runA1],
        ),
        '23514',
      );
    });

    test('schema guards keep the latest pointer and lifecycle consistent', async () => {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO artifacts (id, owner_user_id, kind, title)
           VALUES ($1, $2, 'text', 'Dangling pointer')`,
          [randomUUID(), userA],
        );
        await rejectsWithPgCode(client.query('COMMIT'), '23503');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }

      const created = await createArtifact(userA, { content: 'lifecycle' });
      const id = created.artifact.id;

      await rejectsWithPgCode(
        pool.query(`UPDATE artifacts SET status = 'deleted' WHERE id = $1`, [id]),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          'UPDATE artifacts SET current_version = current_version - 1 WHERE id = $1',
          [id],
        ),
        '23514',
      );
    });
  },
);
