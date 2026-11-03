/**
 * H-027 (#27) extraction and citation integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies the real migrations (0001-0012), and drives ExtractionService with
 * H-026's LocalAttachmentStorage in a throwaway temp directory. Two users with
 * separate Bots and conversations prove owner and conversation isolation.
 * Docker unavailability skips the suite; the container, pool, and storage
 * directory are removed afterwards.
 *
 * Coverage:
 *   normalization      strict UTF-8, NUL refusal, LF endings, NFKC
 *   chunking           determinism, overlap, sentence and hard boundaries,
 *                      surrogate-pair safety, exact offsets
 *   extraction         summary, markdown and plain text, empty/oversized text
 *   idempotency        repeat extraction replaces one canonical chunk set
 *   citations          exact substring, stable id, invalid range matrix
 *   unsupported types  PDF and images refused with zero derived rows
 *   integrity          tampered bytes fail closed, no partial chunks
 *   isolation          foreign, unknown, and malformed ids; cross-conversation
 *                      search; non-enumerating outcome
 *   lifecycle          tombstone removes chunks; re-extract is not found
 *   search             literal term, owner/conversation scope, bounds
 *   schema             composite scope FK, unique position, offset/text checks
 *   cleanup            temp storage and container removed
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
    assert.equal(error.message, code);
    return true;
  });
}

async function rejectsWithPgCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  assert.fail('expected the operation to fail');
}

/** One-shot async source for an attachment upload. */
function sourceFrom(content) {
  return (async function* stream() {
    yield Buffer.isBuffer(content) ? content : Buffer.from(content);
  })();
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

const dockerReady = dockerAvailable();

describe(
  'H-027 extraction and citations',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let storageRoot = '';
    let storage;
    let chat;
    let bots;
    let attachments;
    let extraction;
    let chunkText;
    let normalizeExtractedText;
    let CHUNK_CHARACTERS;
    let CHUNK_OVERLAP_CHARACTERS;
    let MAX_CITATION_CHARACTERS;
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

    async function upload(actor, conversationId, filename, contentType, content) {
      const pending = await attachments.createUpload(actor, conversationId, {
        filename,
        contentType,
        source: sourceFrom(content),
      });

      return attachments.finalize(actor, pending.id);
    }

    async function chunkRows(attachmentId) {
      const result = await pool.query(
        `SELECT chunk_index, text, start_offset, end_offset
           FROM document_chunks
          WHERE attachment_id = $1
          ORDER BY chunk_index ASC`,
        [attachmentId],
      );

      return result.rows;
    }

    async function chunkCount(attachmentId) {
      const result = await pool.query(
        'SELECT count(*)::int AS count FROM document_chunks WHERE attachment_id = $1',
        [attachmentId],
      );

      return result.rows[0].count;
    }

    before(async () => {
      containerName = `habi-h027-${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');

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
        max: 6,
      });

      await waitForDatabase(pool, containerName);
      const databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const pending = dryRun(databaseUrl);
      assert.equal(pending.status, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0012_extraction\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0007_attachments\.sql/);
      assert.match(applied.stdout, /applied\s+0012_extraction\.sql/);

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      const attachmentsModule = await import('../dist/attachments/index.js');
      const extractionModule = await import('../dist/extraction/index.js');
      const { ChatPersistenceService } = await import('../dist/persistence/index.js');
      const { BotService } = await import('../dist/bots/index.js');

      storageRoot = await mkdtemp(join(tmpdir(), 'habi-h027-storage-'));
      storage = new attachmentsModule.LocalAttachmentStorage(storageRoot);
      await storage.initialize();
      attachments = new attachmentsModule.AttachmentService(pool, storage);
      extraction = new extractionModule.ExtractionService(pool, storage);

      chunkText = extractionModule.chunkText;
      normalizeExtractedText = extractionModule.normalizeExtractedText;
      CHUNK_CHARACTERS = extractionModule.CHUNK_CHARACTERS;
      CHUNK_OVERLAP_CHARACTERS = extractionModule.CHUNK_OVERLAP_CHARACTERS;
      MAX_CITATION_CHARACTERS = extractionModule.MAX_CITATION_CHARACTERS;

      chat = new ChatPersistenceService(pool);
      bots = new BotService(pool);

      userA = randomUUID();
      userB = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [userA, userB]);

      botA = (await bots.create(userA, { name: 'Extraction Bot A' })).id;
      botB = (await bots.create(userB, { name: 'Extraction Bot B' })).id;

      conversationA1 = await newConversation(userA, botA, 'A extraction one');
      conversationA2 = await newConversation(userA, botA, 'A extraction two');
      conversationB1 = await newConversation(userB, botB, 'B extraction one');
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

    test('chunking is deterministic, overlapping, and sentence-aware', () => {
      const sentences = 'Sentence number one is here. '.repeat(200);
      const first = chunkText(sentences);
      const second = chunkText(sentences);

      assert.deepEqual(second, first);
      assert.ok(first.length > 1);
      assert.equal(first[0].startOffset, 0);
      assert.equal(first[first.length - 1].endOffset, sentences.length);

      for (let index = 0; index < first.length; index += 1) {
        const span = first[index];
        assert.ok(span.endOffset > span.startOffset);
        assert.ok(span.endOffset - span.startOffset <= CHUNK_CHARACTERS);

        if (index > 0) {
          const previous = first[index - 1];
          assert.equal(
            span.startOffset,
            previous.endOffset - CHUNK_OVERLAP_CHARACTERS,
          );
          assert.ok(span.startOffset < previous.endOffset, 'chunks must overlap');
          assert.ok(span.startOffset >= previous.startOffset + 1, 'must advance');
        }
      }

      // A sentence terminator followed by whitespace is preferred over a hard cut.
      assert.equal(sentences[first[0].endOffset - 1], '.');
      assert.equal(chunkText('').length, 0);

      const unbroken = 'x'.repeat(5000);
      const hardCuts = chunkText(unbroken);
      assert.equal(hardCuts[0].startOffset, 0);
      assert.equal(hardCuts[0].endOffset, CHUNK_CHARACTERS);
      assert.equal(hardCuts[hardCuts.length - 1].endOffset, unbroken.length);
      assert.equal(
        hardCuts[1].startOffset,
        CHUNK_CHARACTERS - CHUNK_OVERLAP_CHARACTERS,
      );

      // Astral characters are two UTF-16 units; a cut must not split one.
      const emoji = '😀'.repeat(2000);
      for (const span of chunkText(emoji)) {
        const text = emoji.slice(span.startOffset, span.endOffset);
        assert.doesNotMatch(text, /^[\uDC00-\uDFFF]/u);
        assert.doesNotMatch(text, /[\uD800-\uDBFF]$/u);
      }
    });

    test('normalizes NFKC and line endings before extracting', () => {
      assert.equal(normalizeExtractedText('ＡＢＣ\r\nD\rE'), 'ABC\nD\nE');
      assert.throws(
        () => normalizeExtractedText('bad\u0000text'),
        (error) => error.code === 'invalid_content',
      );
    });

    test('extracts markdown with exact chunk offsets', async () => {
      const markdown =
        '# Extraction notes\r\n\r\nＦｕｌｌ width heading\r\n\r\n' +
        'The quick brown fox jumps over the lazy dog. It keeps the sentence going. '.repeat(
          40,
        );
      const expected = normalizeExtractedText(markdown);
      const attachment = await upload(
        userA,
        conversationA1.id,
        'notes.md',
        'text/markdown',
        markdown,
      );

      const summary = await extraction.extract(userA, attachment.id);
      assert.equal(summary.attachmentId, attachment.id);
      assert.equal(summary.contentType, 'text/markdown');
      assert.equal(summary.characterCount, expected.length);
      assert.ok(summary.chunkCount > 1);

      const chunks = await extraction.listChunks(userA, attachment.id);
      assert.equal(chunks.length, summary.chunkCount);
      assert.equal(chunks[0].chunkIndex, 0);
      assert.equal(chunks[0].startOffset, 0);
      assert.equal(chunks[chunks.length - 1].endOffset, expected.length);

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        assert.equal(chunk.attachmentId, attachment.id);
        assert.equal(chunk.chunkIndex, index);
        assert.equal(chunk.text, expected.slice(chunk.startOffset, chunk.endOffset));
        assert.doesNotMatch(chunk.text, /\r/u);
        assert.ok(chunk.endOffset - chunk.startOffset <= CHUNK_CHARACTERS);

        if (index > 0) {
          const previous = chunks[index - 1];
          assert.equal(
            chunk.startOffset,
            previous.endOffset - CHUNK_OVERLAP_CHARACTERS,
          );
        }
      }

      const stored = await chunkRows(attachment.id);
      assert.equal(stored.length, summary.chunkCount);
      assert.match(chunks[0].text, /Full width heading/u);

      const firstPage = await extraction.listChunks(userA, attachment.id, {
        limit: 2,
      });
      assert.equal(firstPage.length, 2);
      const rest = await extraction.listChunks(userA, attachment.id, {
        afterChunkIndex: firstPage[firstPage.length - 1].chunkIndex,
      });
      assert.equal(rest[0].chunkIndex, 2);
      assert.equal(rest.length, summary.chunkCount - 2);
    });

    test('extracts plain text and replaces its chunk set idempotently', async () => {
      const plain = 'Plain text line one.\nPlain text line two.\n';
      const attachment = await upload(
        userA,
        conversationA1.id,
        'notes.txt',
        'text/plain',
        plain,
      );

      const first = await extraction.extract(userA, attachment.id);
      const firstRows = await chunkRows(attachment.id);
      assert.equal(firstRows.length, 1);
      assert.equal(firstRows[0].text, plain);
      assert.equal(firstRows[0].start_offset, 0);
      assert.equal(firstRows[0].end_offset, plain.length);

      const second = await extraction.extract(userA, attachment.id);
      assert.deepEqual(second, first);
      assert.deepEqual(await chunkRows(attachment.id), firstRows);

      // A stale or partial set is replaced, not merged.
      await pool.query(
        `DELETE FROM document_chunks
          WHERE attachment_id = $1 AND chunk_index = 0`,
        [attachment.id],
      );
      assert.equal(await chunkCount(attachment.id), 0);

      const third = await extraction.extract(userA, attachment.id);
      assert.deepEqual(third, first);
      assert.deepEqual(await chunkRows(attachment.id), firstRows);

      const duplicates = await pool.query(
        `SELECT chunk_index, count(*)::int AS count
           FROM document_chunks
          WHERE attachment_id = $1
          GROUP BY chunk_index
         HAVING count(*) > 1`,
        [attachment.id],
      );
      assert.equal(duplicates.rows.length, 0);
    });

    test('cites exact passages with stable ids and rejects invalid ranges', async () => {
      const text =
        'Citation fixture sentence one. Citation fixture sentence two. ' +
        'More text for a bounded citation. '.repeat(20);
      const attachment = await upload(
        userA,
        conversationA1.id,
        'citation.txt',
        'text/plain',
        text,
      );

      // A citation requires an extraction.
      await rejectsWithCode(
        extraction.cite(userA, attachment.id, { startOffset: 0, endOffset: 10 }),
        'not_extracted',
      );

      await extraction.extract(userA, attachment.id);
      const range = { startOffset: 9, endOffset: 42 };
      const citation = await extraction.cite(userA, attachment.id, range);

      assert.equal(citation.attachmentId, attachment.id);
      assert.equal(citation.startOffset, range.startOffset);
      assert.equal(citation.endOffset, range.endOffset);
      assert.equal(citation.text, text.slice(range.startOffset, range.endOffset));
      assert.match(citation.id, /^cite:[0-9a-f-]{36}:\d+:\d+:[0-9a-f]{16}$/u);

      const repeated = await extraction.cite(userA, attachment.id, range);
      assert.deepEqual(repeated, citation);

      const adjacent = await extraction.cite(userA, attachment.id, {
        startOffset: range.endOffset,
        endOffset: range.endOffset + 5,
      });
      assert.notEqual(adjacent.id, citation.id);

      const invalidRanges = [
        null,
        { startOffset: -1, endOffset: 5 },
        { startOffset: 5, endOffset: 5 },
        { startOffset: 6, endOffset: 5 },
        { startOffset: 0, endOffset: text.length + 1 },
        { startOffset: 0.5, endOffset: 2 },
        { startOffset: 0, endOffset: MAX_CITATION_CHARACTERS + 1 },
      ];

      for (const invalid of invalidRanges) {
        await rejectsWithCode(
          extraction.cite(userA, attachment.id, invalid),
          'invalid_range',
        );
      }
    });

    test('refuses PDF and image types without writing chunks', async () => {
      const pdf = await upload(
        userA,
        conversationA1.id,
        'document.pdf',
        'application/pdf',
        '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
      );
      const png = await upload(
        userA,
        conversationA1.id,
        'image.png',
        'image/png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      for (const attachment of [pdf, png]) {
        await rejectsWithCode(
          extraction.extract(userA, attachment.id),
          'unsupported_media_type',
        );
        await rejectsWithCode(
          extraction.cite(userA, attachment.id, { startOffset: 0, endOffset: 5 }),
          'unsupported_media_type',
        );
        assert.equal(await chunkCount(attachment.id), 0);
        assert.deepEqual(await extraction.listChunks(userA, attachment.id), []);
      }
    });

    test('refuses malformed, empty, oversized, and non-UTF-8 text', async () => {
      const nonUtf8 = await upload(
        userA,
        conversationA1.id,
        'binary.txt',
        'text/plain',
        Buffer.from([0xff, 0xfe, 0x00, 0x41]),
      );
      const nul = await upload(
        userA,
        conversationA1.id,
        'nul.txt',
        'text/plain',
        Buffer.from('bad\u0000text'),
      );
      const blank = await upload(
        userA,
        conversationA1.id,
        'blank.txt',
        'text/plain',
        ' \n\t\n ',
      );
      const oversized = await upload(
        userA,
        conversationA1.id,
        'large.txt',
        'text/plain',
        Buffer.alloc(1_000_001, 'a'),
      );

      const cases = [
        [nonUtf8, 'invalid_content'],
        [nul, 'invalid_content'],
        [blank, 'empty_content'],
        [oversized, 'content_too_large'],
      ];

      for (const [attachment, code] of cases) {
        await rejectsWithCode(extraction.extract(userA, attachment.id), code);
        assert.equal(await chunkCount(attachment.id), 0);
      }
    });

    test('fails closed on tampered bytes and writes no chunks', async () => {
      const attachment = await upload(
        userA,
        conversationA1.id,
        'tampered.txt',
        'text/plain',
        'Original trusted text. ',
      );
      const path = objectPath(
        userA,
        conversationA1.id,
        attachment.id,
      );
      await writeFile(path, Buffer.from('tampered bytes entirely'));

      const error = await errorOf(extraction.extract(userA, attachment.id));
      assert.equal(error.code, 'attachment_integrity');
      assert.equal(await chunkCount(attachment.id), 0);

      await rejectsWithCode(
        extraction.cite(userA, attachment.id, { startOffset: 0, endOffset: 4 }),
        'attachment_integrity',
      );
    });

    test('denies foreign, unknown, and malformed ids without enumeration', async () => {
      const attachment = await upload(
        userA,
        conversationA1.id,
        'private.txt',
        'text/plain',
        'Owned private text for isolation. ',
      );
      await extraction.extract(userA, attachment.id);

      const unknown = randomUUID();
      const attempts = [
        () => extraction.extract(userB, attachment.id),
        () => extraction.extract(userB, unknown),
        () => extraction.extract(userB, 'not-a-uuid'),
        () => extraction.listChunks(userB, attachment.id),
        () => extraction.listChunks(userB, unknown),
        () => extraction.cite(userB, attachment.id, { startOffset: 0, endOffset: 4 }),
        () => extraction.cite(userB, unknown, { startOffset: 0, endOffset: 4 }),
        () => extraction.extract(userA, unknown),
        () => extraction.listChunks(userA, unknown),
        () => extraction.cite(userA, unknown, { startOffset: 0, endOffset: 4 }),
      ];

      for (const attempt of attempts) {
        await rejectsWithCode(attempt(), 'not_found');
      }

      // The owner still sees the extraction, so the denial is not a shared lock.
      const chunks = await extraction.listChunks(userA, attachment.id);
      assert.ok(chunks.length > 0);
      assert.equal(await chunkCount(attachment.id), chunks.length);
    });

    test('search is literal and scoped to owner and conversation', async () => {
      const zebra = await upload(
        userA,
        conversationA1.id,
        'zebra.txt',
        'text/plain',
        'The zebra appears only in conversation one. ',
      );
      const other = await upload(
        userA,
        conversationA2.id,
        'other.txt',
        'text/plain',
        'The zebra appears in conversation two as well. ',
      );
      const foreign = await upload(
        userB,
        conversationB1.id,
        'foreign.txt',
        'text/plain',
        'The zebra belongs to user B. ',
      );

      await extraction.extract(userA, zebra.id);
      await extraction.extract(userA, other.id);
      await extraction.extract(userB, foreign.id);

      const hits = await extraction.searchChunks(userA, conversationA1.id, 'zebra');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].attachmentId, zebra.id);
      assert.match(hits[0].citationId, /^cite:/u);
      assert.match(hits[0].text, /zebra/u);
      assert.equal(
        hits[0].citationId,
        await extraction
          .cite(userA, zebra.id, {
            startOffset: hits[0].startOffset,
            endOffset: hits[0].endOffset,
          })
          .then((citation) => citation.id),
      );

      const secondConversation = await extraction.searchChunks(
        userA,
        conversationA2.id,
        'zebra',
      );
      assert.equal(secondConversation.length, 1);
      assert.equal(secondConversation[0].attachmentId, other.id);

      // Literal search: SQL wildcards are just characters, not patterns.
      assert.deepEqual(
        await extraction.searchChunks(userA, conversationA1.id, '%'),
        [],
      );
      assert.deepEqual(
        await extraction.searchChunks(userA, conversationA1.id, '_'),
        [],
      );

      await rejectsWithCode(
        extraction.searchChunks(userB, conversationA1.id, 'zebra'),
        'not_found',
      );
      await rejectsWithCode(
        extraction.searchChunks(userA, randomUUID(), 'zebra'),
        'not_found',
      );
      await rejectsWithCode(
        extraction.searchChunks(userA, conversationA1.id, '   '),
        'invalid_input',
      );
      await rejectsWithCode(
        extraction.searchChunks(userA, conversationA1.id, 'bad\nterm'),
        'invalid_input',
      );
      await rejectsWithCode(
        extraction.searchChunks(userA, conversationA1.id, 'z'.repeat(201)),
        'invalid_input',
      );

      const bounded = await extraction.searchChunks(userA, conversationA1.id, 'zebra', {
        limit: 1,
      });
      assert.equal(bounded.length, 1);
    });

    test('tombstoning the attachment removes its derived chunks', async () => {
      const attachment = await upload(
        userA,
        conversationA1.id,
        'delete-me.txt',
        'text/plain',
        'Text that must not outlive the attachment. ',
      );

      await extraction.extract(userA, attachment.id);
      assert.ok((await chunkCount(attachment.id)) > 0);

      await attachments.delete(userA, attachment.id);
      assert.equal(await chunkCount(attachment.id), 0);

      await rejectsWithCode(extraction.extract(userA, attachment.id), 'not_found');
      await rejectsWithCode(
        extraction.cite(userA, attachment.id, { startOffset: 0, endOffset: 4 }),
        'not_found',
      );
      await rejectsWithCode(extraction.listChunks(userA, attachment.id), 'not_found');
    });

    test('schema guards reject mixed scope and invalid chunk rows', async () => {
      const attachment = await upload(
        userA,
        conversationA1.id,
        'schema.txt',
        'text/plain',
        'Schema guard fixture text. ',
      );
      await extraction.extract(userA, attachment.id);

      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO document_chunks (
             attachment_id, owner_user_id, conversation_id,
             chunk_index, text, start_offset, end_offset
           ) VALUES ($1, $2, $3, 999, 'x', 0, 1)`,
          [attachment.id, userB, conversationA1.id],
        ),
        '23503',
      );

      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO document_chunks (
             attachment_id, owner_user_id, conversation_id,
             chunk_index, text, start_offset, end_offset
           ) VALUES ($1, $2, $3, 0, 'x', 0, 1)`,
          [attachment.id, userA, conversationA1.id],
        ),
        '23505',
      );

      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO document_chunks (
             attachment_id, owner_user_id, conversation_id,
             chunk_index, text, start_offset, end_offset
           ) VALUES ($1, $2, $3, 500, 'x', 5, 5)`,
          [attachment.id, userA, conversationA1.id],
        ),
        '23514',
      );

      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO document_chunks (
             attachment_id, owner_user_id, conversation_id,
             chunk_index, text, start_offset, end_offset
           ) VALUES ($1, $2, $3, 501, $4, 0, 1201)`,
          [attachment.id, userA, conversationA1.id, 'x'.repeat(1201)],
        ),
        '23514',
      );

      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO document_chunks (
             attachment_id, owner_user_id, conversation_id,
             chunk_index, text, start_offset, end_offset
           ) VALUES ($1, $2, $3, 502, '', 0, 1)`,
          [attachment.id, userA, conversationA1.id],
        ),
        '23514',
      );
    });
  },
);
