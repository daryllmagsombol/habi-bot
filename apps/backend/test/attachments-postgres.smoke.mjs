/**
 * H-026 (#26) scoped attachment integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies the real migrations (0001-0007), and exercises AttachmentService with
 * a LocalAttachmentStorage rooted at a throwaway temp directory. Two users with
 * separate Bots and conversations prove owner/conversation isolation. Skips
 * cleanly when the Docker daemon is unavailable; the container, pool, and temp
 * storage directory are removed afterwards.
 *
 * Coverage:
 *   lifecycle           create -> pending -> finalize -> stored -> read/list
 *   isolation           every operation for a foreign, guessed, or malformed id
 *   conversation scope  listing and the composite message/conversation FK
 *   input policy        traversal-shaped filenames and disallowed content types
 *   size ceiling        10 MiB inclusive, oversize rejected with no residue
 *   integrity           tampered, truncated, and missing stored bytes
 *   deletion            tombstone + object removal, idempotent, foreign safe
 *   schema guards       key shape, uniqueness, lifecycle, and size constraints
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
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
  return createHash('sha256').update(content).digest('hex');
}

/** One-shot async source; `consumed` records whether the service read it. */
function sourceFrom(content, state = { consumed: false }) {
  const chunks = Array.isArray(content) ? content : [content];

  return {
    state,
    source: (async function* stream() {
      state.consumed = true;
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    })(),
  };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function directoryEntries(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

const dockerReady = dockerAvailable();

describe(
  'H-026 scoped attachments',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let port = 0;
    let password = '';
    let pool;
    let storageRoot = '';
    let storage;
    let chat;
    let bots;
    let attachments;
    let databaseUrl = '';
    let userA;
    let userB;
    let botA;
    let botB;
    let conversationA1;
    let conversationA2;
    let conversationB1;

    const objectPath = (owner, conversation, attachmentId) =>
      join(storageRoot, 'owner', owner, 'conversation', conversation, attachmentId);

    async function newConversation(actor, botId, title) {
      return chat.conversations.create(actor, { botId, title });
    }

    async function upload(
      actor,
      conversationId,
      filename,
      contentType,
      content,
    ) {
      return attachments.createUpload(actor, conversationId, {
        filename,
        contentType,
        source: sourceFrom(content).source,
      });
    }

    before(async () => {
      containerName = `habi-h026-${randomBytes(6).toString('hex')}`;
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
      assert.match(pending.stdout, /pending\s+0007_attachments\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0002_runs\.sql/);
      assert.match(applied.stdout, /applied\s+0003_messages\.sql/);
      assert.match(applied.stdout, /applied\s+0004_bot_profiles\.sql/);
      assert.match(applied.stdout, /applied\s+0005_run_lifecycle\.sql/);
      assert.match(applied.stdout, /applied\s+0007_attachments\.sql/);

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      const { AttachmentService, LocalAttachmentStorage } = await import(
        '../dist/attachments/index.js'
      );
      const { ChatPersistenceService } = await import(
        '../dist/persistence/index.js'
      );
      const { BotService } = await import('../dist/bots/index.js');

      storageRoot = await mkdtemp(join(tmpdir(), 'habi-h026-storage-'));
      storage = new LocalAttachmentStorage(storageRoot);
      await storage.initialize();

      chat = new ChatPersistenceService(pool);
      bots = new BotService(pool);
      attachments = new AttachmentService(pool, storage);

      userA = randomUUID();
      userB = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [userA, userB]);

      botA = (await bots.create(userA, { name: 'Attachment Bot A' })).id;
      botB = (await bots.create(userB, { name: 'Attachment Bot B' })).id;

      conversationA1 = await newConversation(userA, botA, 'A files');
      conversationA2 = await newConversation(userA, botA, 'A other files');
      conversationB1 = await newConversation(userB, botB, 'B files');
    });

    after(async () => {
      if (pool !== undefined) {
        await pool.end().catch(() => {});
      }

      if (storageRoot !== '') {
        await rm(storageRoot, { recursive: true, force: true });
        assert.equal(await exists(storageRoot), false, 'temp storage root was not removed');
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

    test('creates, publishes, and reads an upload under a server-generated key', async () => {
      const content = Buffer.from('# Notes\n\nHello, attachment.\n');
      const created = await upload(
        userA,
        conversationA1.id,
        'notes.md',
        'text/markdown',
        [content.subarray(0, 5), content.subarray(5)],
      );

      assert.match(created.id, UUID_PATTERN);
      assert.equal(created.conversationId, conversationA1.id);
      assert.equal(created.messageId, null);
      assert.equal(created.originalFilename, 'notes.md');
      assert.equal(created.contentType, 'text/markdown');
      assert.equal(created.byteSize, content.byteLength);
      assert.equal(created.sha256, sha256Of(content));
      assert.equal(created.status, 'pending');
      assert.equal(created.storedAt, null);
      assert.equal(created.deletedAt, null);
      assert.ok(!Number.isNaN(Date.parse(created.createdAt)));
      assert.ok(!('storageKey' in created), 'storage key never crosses the service API');

      const row = await pool.query(
        'SELECT storage_key, status FROM attachments WHERE id = $1',
        [created.id],
      );
      const expectedKey = `owner/${userA}/conversation/${conversationA1.id}/${created.id}`;
      assert.equal(row.rows[0].storage_key, expectedKey);
      assert.match(
        row.rows[0].storage_key,
        /^owner\/[0-9a-f-]{36}\/conversation\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/,
      );
      assert.equal(row.rows[0].status, 'pending');

      const path = objectPath(userA, conversationA1.id, created.id);
      assert.equal(await exists(path), true);
      assert.deepEqual(await readdir(storageRoot), ['owner']);

      // Pending bytes are not downloadable.
      await rejectsWithCode(
        attachments.readContent(userA, created.id),
        'not_found',
      );
      assert.deepEqual(await attachments.getMetadata(userA, created.id), created);

      const stored = await attachments.finalize(userA, created.id);
      assert.equal(stored.status, 'stored');
      assert.equal(stored.storedAt === null, false);
      assert.equal(stored.byteSize, content.byteLength);

      const repeated = await attachments.finalize(userA, created.id);
      assert.equal(repeated.storedAt, stored.storedAt);
      assert.equal(repeated.status, 'stored');

      const read = await attachments.readContent(userA, created.id);
      assert.deepEqual(read.content, content);
      assert.deepEqual(read.metadata, stored);

      const listed = await attachments.listForConversation(
        userA,
        conversationA1.id,
      );
      assert.deepEqual(listed.map((item) => item.id), [created.id]);

      // The same filename in the same conversation gets a distinct server key.
      const other = await upload(
        userA,
        conversationA1.id,
        'notes.md',
        'text/plain',
        Buffer.from('second upload'),
      );
      const otherRow = await pool.query(
        'SELECT storage_key FROM attachments WHERE id = $1',
        [other.id],
      );
      assert.notEqual(otherRow.rows[0].storage_key, expectedKey);

      await attachments.delete(userA, other.id);
      await attachments.delete(userA, created.id);
    });

    test('denies foreign, guessed, and malformed access with one not-found', async () => {
      const content = Buffer.from('owner A private bytes');
      const created = await upload(
        userA,
        conversationA1.id,
        'private.txt',
        'text/plain',
        content,
      );
      await attachments.finalize(userA, created.id);
      const path = objectPath(userA, conversationA1.id, created.id);

      await rejectsWithCode(attachments.getMetadata(userB, created.id), 'not_found');
      await rejectsWithCode(attachments.finalize(userB, created.id), 'not_found');
      await rejectsWithCode(attachments.readContent(userB, created.id), 'not_found');
      await rejectsWithCode(attachments.delete(userB, created.id), 'not_found');
      await rejectsWithCode(
        attachments.listForConversation(userB, conversationA1.id),
        'not_found',
      );

      const foreignUpload = sourceFrom(Buffer.from('intrusion'));
      await rejectsWithCode(
        attachments.createUpload(userB, conversationA1.id, {
          filename: 'intrusion.txt',
          contentType: 'text/plain',
          source: foreignUpload.source,
        }),
        'not_found',
      );
      assert.equal(foreignUpload.state.consumed, false);

      const guessed = randomUUID();
      const foreignDenial = await attachments
        .getMetadata(userB, created.id)
        .catch((error) => error);
      const guessedDenial = await attachments
        .getMetadata(userA, guessed)
        .catch((error) => error);

      assert.equal(foreignDenial.code, 'not_found');
      assert.equal(guessedDenial.code, 'not_found');
      assert.equal(foreignDenial.message, guessedDenial.message);
      assert.ok(!foreignDenial.message.includes(created.id));

      await rejectsWithCode(
        attachments.getMetadata('not-a-uuid', created.id),
        'not_found',
      );
      await rejectsWithCode(
        attachments.readContent(userA, 'not-a-uuid'),
        'not_found',
      );
      await rejectsWithCode(
        attachments.finalize(userA, randomUUID()),
        'not_found',
      );
      await rejectsWithCode(
        attachments.delete(userA, randomUUID()),
        'not_found',
      );

      // The reverse direction holds too: A cannot see B's own attachment.
      const bAttachment = await upload(
        userB,
        conversationB1.id,
        'b-private.txt',
        'text/plain',
        Buffer.from('B private bytes'),
      );
      await attachments.finalize(userB, bAttachment.id);
      await rejectsWithCode(
        attachments.getMetadata(userA, bAttachment.id),
        'not_found',
      );
      await rejectsWithCode(
        attachments.readContent(userA, bAttachment.id),
        'not_found',
      );
      await rejectsWithCode(attachments.delete(userA, bAttachment.id), 'not_found');
      await attachments.delete(userB, bAttachment.id);

      // Every failed foreign attempt left the owner's bytes untouched.
      assert.equal(await exists(path), true);
      const read = await attachments.readContent(userA, created.id);
      assert.deepEqual(read.content, content);

      await attachments.delete(userA, created.id);
    });

    test('scopes listing to one conversation and enforces message scope in SQL', async () => {
      const first = await upload(
        userA,
        conversationA1.id,
        'one.txt',
        'text/plain',
        Buffer.from('one'),
      );
      const second = await upload(
        userA,
        conversationA1.id,
        'two.txt',
        'text/plain',
        Buffer.from('two'),
      );
      await attachments.finalize(userA, first.id);
      await attachments.finalize(userA, second.id);

      const inA1 = await attachments.listForConversation(userA, conversationA1.id);
      assert.deepEqual(
        new Set(inA1.map((item) => item.id)),
        new Set([first.id, second.id]),
      );

      const inA2 = await attachments.listForConversation(userA, conversationA2.id);
      assert.equal(inA2.length, 0);
      assert.ok(!inA2.some((item) => item.id === first.id));

      await rejectsWithCode(
        attachments.listForConversation(userB, conversationA2.id),
        'not_found',
      );

      // A message from another conversation cannot be attached to this one.
      const foreignMessage = await chat.messages.append(userA, {
        conversationId: conversationA2.id,
        role: 'user',
        content: 'Message in another conversation',
      });

      const mismatchedId = randomUUID();
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO attachments (
             id, owner_user_id, conversation_id, message_id, original_filename,
             content_type, byte_size, sha256, storage_key
           )
           VALUES ($1, $2, $3, $4, 'mismatch.txt', 'text/plain', 1, $5, $6)`,
          [
            mismatchedId,
            userA,
            conversationA1.id,
            foreignMessage.id,
            'b'.repeat(64),
            `owner/${userA}/conversation/${conversationA1.id}/${mismatchedId}`,
          ],
        ),
        '23503',
      );

      // Nor can an owner column disagree with the conversation's owner.
      const crossOwnerId = randomUUID();
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO attachments (
             id, owner_user_id, conversation_id, original_filename,
             content_type, byte_size, sha256, storage_key
           )
           VALUES ($1, $2, $3, 'cross.txt', 'text/plain', 1, $4, $5)`,
          [
            crossOwnerId,
            userB,
            conversationA1.id,
            'c'.repeat(64),
            `owner/${userB}/conversation/${conversationA1.id}/${crossOwnerId}`,
          ],
        ),
        '23503',
      );

      await attachments.delete(userA, first.id);
      await attachments.delete(userA, second.id);
    });

    test('rejects traversal-shaped names and disallowed content types before writing', async () => {
      const count = await pool.query(
        'SELECT count(*)::int AS total FROM attachments WHERE conversation_id = $1',
        [conversationA1.id],
      );

      const badFilenames = [
        '../escape.txt',
        '../../etc/passwd',
        '/etc/passwd',
        'C:\\Windows\\win.ini',
        'nested/file.txt',
        'nested\\file.txt',
        '..',
        '.',
        'nul\u0000byte.txt',
        'control\u0007.txt',
        'a'.repeat(257),
        '   ',
      ];

      for (const filename of badFilenames) {
        const attempt = sourceFrom(Buffer.from('x'));
        await rejectsWithCode(
          attachments.createUpload(userA, conversationA1.id, {
            filename,
            contentType: 'text/plain',
            source: attempt.source,
          }),
          'invalid_input',
        );
        assert.equal(
          attempt.state.consumed,
          false,
          `rejected filename was not streamed: ${JSON.stringify(filename)}`,
        );
      }

      const badTypes = [
        'text/html',
        'image/svg+xml',
        'application/x-msdownload',
        'application/octet-stream',
        'application/zip',
        '',
        'text/plain\nx-injected: 1',
      ];

      for (const contentType of badTypes) {
        const attempt = sourceFrom(Buffer.from('x'));
        await rejectsWithCode(
          attachments.createUpload(userA, conversationA1.id, {
            filename: 'payload.txt',
            contentType,
            source: attempt.source,
          }),
          'invalid_input',
        );
        assert.equal(attempt.state.consumed, false);
      }

      const afterRejections = await pool.query(
        'SELECT count(*)::int AS total FROM attachments WHERE conversation_id = $1',
        [conversationA1.id],
      );
      assert.equal(afterRejections.rows[0].total, count.rows[0].total);
      assert.deepEqual(
        await directoryEntries(
          join(storageRoot, 'owner', userA, 'conversation', conversationA1.id),
        ),
        [],
      );

      // Case and parameters are normalized, never trusted verbatim.
      const accepted = await upload(
        userA,
        conversationA1.id,
        'normalized.txt',
        'TEXT/PLAIN; charset=utf-8',
        Buffer.from('ok'),
      );
      assert.equal(accepted.contentType, 'text/plain');
      await attachments.delete(userA, accepted.id);

      // The key builder refuses any component that is not a server UUID.
      const { buildAttachmentStorageKey } = await import(
        '../dist/attachments/index.js'
      );
      assert.throws(
        () =>
          buildAttachmentStorageKey({
            ownerUserId: '../escape',
            conversationId: conversationA1.id,
            attachmentId: randomUUID(),
          }),
        TypeError,
      );
    });

    test('enforces the 10 MiB ceiling while streaming and leaves no residue', async () => {
      const count = await pool.query(
        'SELECT count(*)::int AS total FROM attachments WHERE conversation_id = $1',
        [conversationA1.id],
      );

      const mebibyte = Buffer.alloc(1024 * 1024, 0x61);
      const oversized = Array.from({ length: 10 }, () => mebibyte);
      oversized.push(Buffer.from([0x62]));

      await rejectsWithCode(
        upload(
          userA,
          conversationA1.id,
          'too-large.bin',
          'text/plain',
          oversized,
        ),
        'invalid_input',
      );

      const after = await pool.query(
        'SELECT count(*)::int AS total FROM attachments WHERE conversation_id = $1',
        [conversationA1.id],
      );
      assert.equal(after.rows[0].total, count.rows[0].total);
      assert.deepEqual(
        await directoryEntries(
          join(storageRoot, 'owner', userA, 'conversation', conversationA1.id),
        ),
        [],
        'no partial or temporary object survives an oversize rejection',
      );

      // Exactly 10 MiB is allowed and is recorded as such.
      const exact = await upload(
        userA,
        conversationA1.id,
        'exact-limit.txt',
        'text/plain',
        [Buffer.alloc(5 * 1024 * 1024, 0x63), Buffer.alloc(5 * 1024 * 1024, 0x64)],
      );
      assert.equal(exact.byteSize, MAX_ATTACHMENT_BYTES);
      await attachments.finalize(userA, exact.id);
      const read = await attachments.readContent(userA, exact.id);
      assert.equal(read.content.byteLength, MAX_ATTACHMENT_BYTES);

      await attachments.delete(userA, exact.id);
    });

    test('fails closed when stored bytes disagree with recorded metadata', async () => {
      const content = Buffer.from('original attachment bytes');
      const created = await upload(
        userA,
        conversationA1.id,
        'integrity.txt',
        'text/plain',
        content,
      );
      await attachments.finalize(userA, created.id);
      const path = objectPath(userA, conversationA1.id, created.id);

      // Same length, different digest.
      await writeFile(path, Buffer.alloc(content.byteLength, 0x7a));
      await rejectsWithCode(
        attachments.readContent(userA, created.id),
        'attachment_integrity',
      );

      // Truncated object.
      await writeFile(path, content.subarray(0, 3));
      await rejectsWithCode(
        attachments.readContent(userA, created.id),
        'attachment_integrity',
      );

      // Missing object entirely.
      const missing = await upload(
        userA,
        conversationA1.id,
        'missing.txt',
        'text/plain',
        Buffer.from('will vanish'),
      );
      await attachments.finalize(userA, missing.id);
      await unlink(objectPath(userA, conversationA1.id, missing.id));
      await rejectsWithCode(
        attachments.readContent(userA, missing.id),
        'attachment_integrity',
      );

      await attachments.delete(userA, created.id);
      await attachments.delete(userA, missing.id);
    });

    test('deletes idempotently, removes the object, and never removes a foreign object', async () => {
      const pending = await upload(
        userA,
        conversationA1.id,
        'pending-delete.txt',
        'text/plain',
        Buffer.from('pending bytes'),
      );
      const pendingPath = objectPath(userA, conversationA1.id, pending.id);
      assert.equal(await exists(pendingPath), true);

      await attachments.delete(userA, pending.id);
      assert.equal(await exists(pendingPath), false);
      const pendingRow = await pool.query(
        'SELECT status, deleted_at FROM attachments WHERE id = $1',
        [pending.id],
      );
      assert.equal(pendingRow.rows[0].status, 'deleted');
      assert.notEqual(pendingRow.rows[0].deleted_at, null);

      await rejectsWithCode(
        attachments.getMetadata(userA, pending.id),
        'not_found',
      );
      await rejectsWithCode(
        attachments.readContent(userA, pending.id),
        'not_found',
      );

      // Repeat delete succeeds without re-addressing the object.
      await attachments.delete(userA, pending.id);

      const stored = await upload(
        userA,
        conversationA1.id,
        'stored-delete.txt',
        'text/plain',
        Buffer.from('stored bytes'),
      );
      await attachments.finalize(userA, stored.id);
      const storedPath = objectPath(userA, conversationA1.id, stored.id);

      // A foreign delete denies before the object is addressed.
      await rejectsWithCode(attachments.delete(userB, stored.id), 'not_found');
      assert.equal(await exists(storedPath), true);
      assert.equal((await attachments.readContent(userA, stored.id)).content.length > 0, true);

      await attachments.delete(userA, stored.id);
      assert.equal(await exists(storedPath), false);
      await attachments.delete(userA, stored.id);

      const listed = await attachments.listForConversation(
        userA,
        conversationA1.id,
      );
      assert.ok(!listed.some((item) => item.id === stored.id));
      assert.ok(!listed.some((item) => item.id === pending.id));
    });

    test('keeps storage-key, uniqueness, lifecycle, and size invariants in SQL', async () => {
      const insert = async (overrides = {}) => {
        const id = overrides.id ?? randomUUID();
        const row = {
          id,
          owner: userA,
          conversation: conversationA1.id,
          filename: 'row.txt',
          contentType: 'text/plain',
          byteSize: 1,
          sha256: 'd'.repeat(64),
          storageKey: `owner/${userA}/conversation/${conversationA1.id}/${id}`,
          status: 'pending',
          storedAt: null,
          deletedAt: null,
          ...overrides,
        };

        await pool.query(
          `INSERT INTO attachments (
             id, owner_user_id, conversation_id, original_filename,
             content_type, byte_size, sha256, storage_key, status,
             stored_at, deleted_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            row.id,
            row.owner,
            row.conversation,
            row.filename,
            row.contentType,
            row.byteSize,
            row.sha256,
            row.storageKey,
            row.status,
            row.storedAt,
            row.deletedAt,
          ],
        );

        return row;
      };

      const first = await insert();

      // Storage keys are unique across every owner.
      await rejectsWithPgCode(
        insert({ storageKey: first.storageKey }),
        '23505',
      );

      // Traversal-shaped or unshaped keys are rejected by the shape check.
      for (const storageKey of [
        'owner/../../etc/passwd',
        `/owner/${userA}/conversation/${conversationA1.id}/${randomUUID()}`,
        `owner/${userA}/conversation/${conversationA1.id}`,
      ]) {
        await rejectsWithPgCode(insert({ storageKey }), '23514');
      }

      // Lifecycle timestamps must agree with status.
      await rejectsWithPgCode(insert({ status: 'stored' }), '23514');
      await rejectsWithPgCode(insert({ status: 'deleted' }), '23514');

      // Size and digest bounds are enforced in the schema as well.
      await rejectsWithPgCode(
        insert({ byteSize: MAX_ATTACHMENT_BYTES + 1 }),
        '23514',
      );
      await rejectsWithPgCode(insert({ byteSize: -1 }), '23514');
      await rejectsWithPgCode(insert({ sha256: 'not-a-digest' }), '23514');
      await rejectsWithPgCode(insert({ filename: '../row.txt' }), '23514');

      await pool.query('DELETE FROM attachments WHERE id = $1', [first.id]);
    });
  },
);
