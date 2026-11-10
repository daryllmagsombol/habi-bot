/**
 * H-029 (#29) owner-scoped search integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port with
 * a random password, applies the real migrations (including the generated
 * `messages.search_vector`), and exercises `SearchService` /
 * `ConversationSearchService` with two users. Skips cleanly when the Docker
 * daemon is unavailable; the container, temporary databases, and temporary
 * directories are removed afterwards.
 *
 * Coverage:
 *   schema          generated column + GIN index; pre-migration rows backfilled
 *   isolation       owner predicate, foreign conversation/Bot filter, guesses
 *   matching        term, phrase, stemming, `or` / `-term` websearch syntax
 *   ranking         relevance first, then created_at, then id
 *   pagination      keyset cursor, stable under insertion, query/scope bound
 *   input           empty, short, stop-word-only, over-long, injection-shaped
 *   snippet         HTML in message content stays inert; only <mark> is emitted
 *   filters         conversation and Bot narrowing, mismatched combination
 *   lifecycle       archived readable, deleted conversation/Bot excluded
 *   grouping        conversation counts, ordering, owner scope, pagination
 *   bounds          default 20, maximum 50
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client, Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SCRIPT = join(REPOSITORY_ROOT, 'scripts/db/migrate.mjs');
const MIGRATIONS_DIR = join(REPOSITORY_ROOT, 'migrations');
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const SEARCH_MIGRATION = '0010_search_index.sql';

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 5000,
  });

  return result.status === 0;
}

const dockerReady = dockerAvailable();
const createdDatabases = [];
const temporaryDirectories = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function migrate(databaseUrl, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl, ...extraArgs],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
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

const EMPTY_MESSAGE_PAGE = { hits: [], hasMore: false, nextCursor: null };

/** Only the two tags the snippet module emits may appear unescaped. */
function assertInertSnippet(snippet) {
  assert.ok(!/<(?!\/?mark>)/i.test(snippet), `snippet introduced markup: ${snippet}`);
}

describe(
  'H-029 owner-scoped conversation search',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let chat;
    let searchService;
    let conversationSearch;
    let searchModule;
    let userA;
    let userB;
    let botA;
    let botAOther;
    let botB;
    let archivedBot;
    let deletedBot;

    async function createConversation(ownerUserId, botId, title) {
      return chat.conversations.create(ownerUserId, { botId, title });
    }

    async function addMessage(conversationId, ownerUserId, content, createdAt) {
      const message = await chat.messages.append(ownerUserId, {
        conversationId,
        role: 'user',
        content,
      });

      if (createdAt !== undefined) {
        await pool.query('UPDATE messages SET created_at = $2 WHERE id = $1', [
          message.id,
          createdAt,
        ]);
      }

      return message;
    }

    function search(actorUserId, query, extras = {}) {
      return searchService.searchMessages({ actorUserId, query, ...extras });
    }

    function searchConversations(actorUserId, query, extras = {}) {
      return conversationSearch.searchConversations({ actorUserId, query, ...extras });
    }

    async function collectMessageIds(actorUserId, query, extras = {}) {
      const ids = [];
      let cursor;
      let pages = 0;

      for (;;) {
        const page = await search(actorUserId, query, {
          ...extras,
          ...(cursor === undefined ? {} : { cursor }),
        });

        assert.ok(page.hits.length <= 50);
        ids.push(...page.hits.map((hit) => hit.messageId));
        pages += 1;
        assert.ok(pages < 100, 'pagination did not terminate');

        if (page.nextCursor === null) {
          assert.equal(page.hasMore, false);
          return ids;
        }

        assert.equal(page.hasMore, true);
        cursor = page.nextCursor;
      }
    }

    before(async () => {
      containerName = `habi-h029-${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');

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
        max: 8,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const dryRun = migrate(databaseUrl, ['--dry-run']);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.match(dryRun.stdout, new RegExp(`pending\\s+${SEARCH_MIGRATION.replace('.', '\\.')}`));

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, new RegExp(`applied\\s+${SEARCH_MIGRATION.replace('.', '\\.')}`));

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      searchModule = await import('../dist/search/index.js');
      const persistence = await import('../dist/persistence/index.js');
      chat = new persistence.ChatPersistenceService(pool);
      searchService = new searchModule.SearchService(pool);
      conversationSearch = new searchModule.ConversationSearchService(pool);

      userA = randomUUID();
      userB = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [userA, userB]);

      botA = randomUUID();
      botAOther = randomUUID();
      botB = randomUUID();
      archivedBot = randomUUID();
      deletedBot = randomUUID();
      await pool.query(
        `INSERT INTO bots (id, owner_user_id, name, status, archived_at)
         VALUES ($1, $2, 'Search A', 'active', NULL),
                ($3, $2, 'Search A other', 'active', NULL),
                ($4, $5, 'Search B', 'active', NULL),
                ($6, $2, 'Archived search', 'active', NULL),
                ($7, $2, 'Deleted search', 'active', NULL)`,
        [botA, userA, botAOther, botB, userB, archivedBot, deletedBot],
      );
    });

    after(async () => {
      if (pool !== undefined) {
        await pool.end().catch(() => {});
      }

      if (containerName !== '') {
        const portResult = spawnSync('docker', ['port', containerName, '5432/tcp'], {
          encoding: 'utf8',
          timeout: 10000,
        });
        const published = portResult.stdout?.trim().split(':').pop() ?? '';
        const port = Number.parseInt(published, 10);

        if (Number.isInteger(port) && port > 0 && createdDatabases.length > 0) {
          const admin = new Client({
            host: '127.0.0.1',
            port,
            user: DOCKER_USER,
            password: new URL(databaseUrl).password,
            database: 'postgres',
          });

          try {
            await admin.connect();
            for (const name of createdDatabases) {
              await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
            }
          } catch {
            // Container removal below is the authoritative cleanup.
          } finally {
            await admin.end().catch(() => {});
          }
        }

        spawnSync('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          timeout: 30000,
        });
      }

      for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test('adds a generated search vector and backfills rows that predate it', async () => {
      const column = await pool.query(
        `SELECT is_generated
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'messages'
            AND column_name = 'search_vector'`,
      );
      assert.equal(column.rows.length, 1);
      assert.equal(column.rows[0].is_generated, 'ALWAYS');

      const index = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'messages_search_vector_idx'`,
      );
      assert.equal(index.rows.length, 1);
      assert.match(index.rows[0].indexdef, /USING gin \(search_vector\)/);

      // A row written before 0010 must be searchable immediately afterwards.
      const admin = new Client({
        host: '127.0.0.1',
        port: Number.parseInt(new URL(databaseUrl).port, 10),
        user: DOCKER_USER,
        password: new URL(databaseUrl).password,
        database: 'postgres',
      });
      await admin.connect();

      const legacyDatabase = `habi_h029_backfill_${randomBytes(5).toString('hex')}`;
      await admin.query(`CREATE DATABASE "${legacyDatabase}"`);
      createdDatabases.push(legacyDatabase);
      const legacyUrl = `postgres://${DOCKER_USER}:${new URL(databaseUrl).password}@127.0.0.1:${new URL(databaseUrl).port}/${legacyDatabase}`;

      const legacyDirectory = mkdtempSync(join(tmpdir(), 'habi-h029-legacy-'));
      temporaryDirectories.push(legacyDirectory);
      for (const file of readdirSync(MIGRATIONS_DIR)) {
        if (file < SEARCH_MIGRATION && file.endsWith('.sql')) {
          copyFileSync(join(MIGRATIONS_DIR, file), join(legacyDirectory, file));
        }
      }

      const legacy = new Client({ connectionString: legacyUrl });
      await legacy.connect();

      try {
        const partial = migrate(legacyUrl, ['--migrations-dir', legacyDirectory]);
        assert.equal(partial.status, 0, partial.stderr);
        assert.doesNotMatch(partial.stdout, /0010_search_index/);

        const legacyUser = randomUUID();
        const legacyBot = randomUUID();
        const legacyConversation = randomUUID();
        await legacy.query('INSERT INTO users (id) VALUES ($1)', [legacyUser]);
        await legacy.query('INSERT INTO bots (id, owner_user_id) VALUES ($1, $2)', [
          legacyBot,
          legacyUser,
        ]);
        await legacy.query(
          `INSERT INTO conversations (id, owner_user_id, bot_id, title, last_message_seq)
           VALUES ($1, $2, $3, 'Legacy thread', 1)`,
          [legacyConversation, legacyUser, legacyBot],
        );
        await legacy.query(
          `INSERT INTO messages
             (conversation_id, owner_user_id, role, content, seq, status, finalized_at)
           VALUES ($1, $2, 'user', 'legacy backfill marker', 1, 'final', now())`,
          [legacyConversation, legacyUser],
        );

        const applied = migrate(legacyUrl);
        assert.equal(applied.status, 0, applied.stderr);
        assert.match(applied.stdout, /applied\s+0010_search_index\.sql/);

        const backfilled = await legacy.query(
          `SELECT search_vector::text AS vector,
                  search_vector @@ websearch_to_tsquery('english', 'backfill') AS matches
             FROM messages
            WHERE conversation_id = $1`,
          [legacyConversation],
        );
        assert.equal(backfilled.rows.length, 1);
        // The vector holds stemmed lexemes ('backfil'), so assert on the stem.
        assert.match(backfilled.rows[0].vector, /'backfil':/);
        assert.match(backfilled.rows[0].vector, /'legaci':/);
        assert.equal(backfilled.rows[0].matches, true);
      } finally {
        await legacy.end().catch(() => {});
        await admin.end().catch(() => {});
      }
    });

    test('rejects empty, short, stop-word-only, and injection-shaped queries safely', async () => {
      for (const query of ['', '   ', 'a', 'x', '!!!', 'the', '  ,  ', null, 42, ['x']]) {
        await rejectsWithCode(search(userA, query), 'invalid_input');
      }

      await rejectsWithCode(search(userA, 'a'.repeat(201)), 'invalid_input');
      await rejectsWithCode(search(undefined, 'orbital'), 'not_found');
      await rejectsWithCode(search('not-a-uuid', 'orbital'), 'not_found');

      for (const limit of [0, -1, 1.5, '10', null]) {
        await rejectsWithCode(search(userA, 'orbital', { limit }), 'invalid_input');
      }

      await rejectsWithCode(
        search(userA, 'orbital', { conversationId: 'not-a-uuid' }),
        'invalid_input',
      );
      await rejectsWithCode(search(userA, 'orbital', { botId: 'not-a-uuid' }), 'invalid_input');
      await rejectsWithCode(search(userA, 'orbital', { cursor: 'not-a-cursor' }), 'invalid_cursor');
      await rejectsWithCode(
        search(userA, 'orbital', {
          cursor: `s1.${Buffer.from('{"s":1}').toString('base64url')}`,
        }),
        'invalid_cursor',
      );

      // websearch_to_tsquery accepts arbitrary text without raising a syntax
      // error, and the statement is bound rather than interpolated.
      const conversation = await createConversation(userA, botA, 'Injection shapes');
      await addMessage(
        conversation.id,
        userA,
        "'); DROP TABLE messages; -- $$ alert(1)",
        '2026-11-01T00:00:00.000Z',
      );

      const shaped = await search(
        userA,
        '\'); DROP TABLE messages; --',
        { conversationId: conversation.id },
      );
      assert.equal(shaped.hits.length, 1);

      const operators = await search(
        userA,
        'orbital & | ! ( ) :* <-> "unterminated',
        { conversationId: conversation.id },
      );
      assert.deepEqual(operators.hits, []);

      const table = await pool.query("SELECT to_regclass('public.messages') AS name");
      assert.ok(table.rows[0].name, 'search text must never execute as SQL');
    });

    test('returns only the actor messages and hides foreign conversation and Bot scopes', async () => {
      const conversationA = await createConversation(userA, botA, 'A orbital');
      const messageA = await addMessage(
        conversationA.id,
        userA,
        'orbital mango protocol for A',
        '2026-11-01T01:00:00.000Z',
      );

      const conversationB = await createConversation(userB, botB, 'B orbital');
      const messageB = await addMessage(
        conversationB.id,
        userB,
        'orbital banana protocol for B',
        '2026-11-01T01:00:00.000Z',
      );

      const forA = await search(userA, 'orbital');
      assert.equal(forA.hits.length, 1);
      assert.equal(forA.hits[0].messageId, messageA.id);
      assert.equal(forA.hits[0].conversationId, conversationA.id);

      const forB = await search(userB, 'orbital');
      assert.equal(forB.hits.length, 1);
      assert.equal(forB.hits[0].messageId, messageB.id);
      assert.ok(!forB.hits.some((hit) => hit.conversationId === conversationA.id));

      assert.deepEqual((await search(userA, 'banana')).hits, []);
      assert.deepEqual((await search(userB, 'mango')).hits, []);

      // A foreign scope and an unknown scope produce byte-identical empty pages.
      const foreignConversation = await search(userB, 'orbital', {
        conversationId: conversationA.id,
      });
      const missingConversation = await search(userB, 'orbital', {
        conversationId: randomUUID(),
      });
      assert.deepEqual(foreignConversation, EMPTY_MESSAGE_PAGE);
      assert.deepEqual(missingConversation, EMPTY_MESSAGE_PAGE);

      const foreignBot = await search(userB, 'orbital', { botId: botA });
      const missingBot = await search(userB, 'orbital', { botId: randomUUID() });
      assert.deepEqual(foreignBot, EMPTY_MESSAGE_PAGE);
      assert.deepEqual(missingBot, EMPTY_MESSAGE_PAGE);

      // The same filters work for the owner.
      assert.equal((await search(userA, 'orbital', { conversationId: conversationA.id })).hits.length, 1);
      assert.equal((await search(userA, 'orbital', { botId: botA })).hits.length, 1);

      // Guessed-id access through search never raises a distinguishing error.
      assert.deepEqual((await search(userA, 'orbital', { botId: botB })).hits, []);
      assert.deepEqual(
        (await search(userA, 'orbital', { conversationId: conversationB.id })).hits,
        [],
      );
    });

    test('matches terms, phrases, stems, and websearch operators', async () => {
      const conversation = await createConversation(userA, botAOther, 'Matching');
      const fox = await addMessage(
        conversation.id,
        userA,
        'The quick brown fox jumps over the lazy dog',
        '2026-11-01T02:00:00.000Z',
      );
      const silver = await addMessage(
        conversation.id,
        userA,
        'quick silver lining note',
        '2026-11-01T02:01:00.000Z',
      );
      await addMessage(
        conversation.id,
        userA,
        'brownian motion study',
        '2026-11-01T02:02:00.000Z',
      );

      const term = await search(userA, 'quick', { conversationId: conversation.id });
      assert.deepEqual(
        term.hits.map((hit) => hit.messageId).sort(),
        [fox.id, silver.id].sort(),
      );

      const phrase = await search(userA, '"quick brown"', {
        conversationId: conversation.id,
      });
      assert.deepEqual(phrase.hits.map((hit) => hit.messageId), [fox.id]);

      const stemmed = await search(userA, 'jumping', { conversationId: conversation.id });
      assert.deepEqual(stemmed.hits.map((hit) => hit.messageId), [fox.id]);

      const either = await search(userA, 'quick or silver', {
        conversationId: conversation.id,
      });
      assert.equal(either.hits.length, 2);

      const excluded = await search(userA, 'quick -silver', {
        conversationId: conversation.id,
      });
      assert.deepEqual(excluded.hits.map((hit) => hit.messageId), [fox.id]);

      const brownian = await search(userA, 'brownian', {
        conversationId: conversation.id,
      });
      assert.equal(brownian.hits.length, 1);
      assert.match(brownian.hits[0].snippet, /<mark>brownian<\/mark>/i);
      assertInertSnippet(brownian.hits[0].snippet);
    });

    test('ranks by relevance then recency then id', async () => {
      const conversation = await createConversation(userA, botA, 'Ranking');
      const dense = await addMessage(
        conversation.id,
        userA,
        'needle needle needle needle needle needle',
        '2026-11-01T03:00:00.000Z',
      );
      await addMessage(
        conversation.id,
        userA,
        'needle appears once here',
        '2026-11-01T03:01:00.000Z',
      );
      await addMessage(
        conversation.id,
        userA,
        'a single needle among many other filler words changes density',
        '2026-11-01T03:02:00.000Z',
      );

      const ranked = await search(userA, 'needle', { conversationId: conversation.id });
      assert.equal(ranked.hits.length, 3);
      assert.equal(ranked.hits[0].messageId, dense.id);
      for (let index = 1; index < ranked.hits.length; index += 1) {
        assert.ok(
          ranked.hits[index - 1].score >= ranked.hits[index].score,
          'scores must be non-increasing',
        );
      }

      // Identical content produces the identical score; recency breaks the tie.
      const older = await addMessage(
        conversation.id,
        userA,
        'zephyr watch',
        '2026-11-01T03:03:00.000Z',
      );
      const newer = await addMessage(
        conversation.id,
        userA,
        'zephyr watch',
        '2026-11-01T03:04:00.123456Z',
      );
      const tied = await search(userA, 'zephyr', { conversationId: conversation.id });
      assert.deepEqual(tied.hits.map((hit) => hit.messageId), [newer.id, older.id]);
      assert.equal(tied.hits[0].score, tied.hits[1].score);
    });

    test('paginates stably and rejects cursors from another query or scope', async () => {
      const conversation = await createConversation(userA, botA, 'Pagination');
      const created = [];

      for (let index = 0; index < 6; index += 1) {
        created.push(
          await addMessage(
            conversation.id,
            userA,
            'paginationwise sample',
            `2026-11-01T04:0${index}:00.000000Z`,
          ),
        );
      }

      // Newest first, because scores are identical and content is identical.
      const expected = created
        .slice()
        .reverse()
        .map((message) => message.id);

      const ids = await collectMessageIds(userA, 'paginationwise', {
        conversationId: conversation.id,
        limit: 2,
      });
      assert.deepEqual(ids, expected);
      assert.equal(new Set(ids).size, 6);

      const firstPage = await search(userA, 'paginationwise', {
        conversationId: conversation.id,
        limit: 2,
      });
      assert.equal(firstPage.hasMore, true);
      assert.ok(firstPage.nextCursor);

      // A cursor is bound to one query and one scope.
      await rejectsWithCode(
        search(userA, 'needle', {
          conversationId: conversation.id,
          limit: 2,
          cursor: firstPage.nextCursor,
        }),
        'invalid_cursor',
      );
      await rejectsWithCode(
        search(userA, 'paginationwise', {
          conversationId: conversation.id,
          botId: botA,
          limit: 2,
          cursor: firstPage.nextCursor,
        }),
        'invalid_cursor',
      );
      await rejectsWithCode(
        search(userA, 'paginationwise', { limit: 2, cursor: firstPage.nextCursor }),
        'invalid_cursor',
      );

      // A write between pages does not duplicate or skip older matches.
      const newest = await addMessage(
        conversation.id,
        userA,
        'paginationwise sample',
        '2026-11-02T00:00:00.000Z',
      );
      const afterInsert = await collectMessageIds(userA, 'paginationwise', {
        conversationId: conversation.id,
        limit: 2,
      });
      assert.deepEqual(afterInsert, [newest.id, ...expected]);
      assert.equal(new Set(afterInsert).size, 7);
    });

    test('escapes HTML in snippets and never emits tags other than mark', async () => {
      const { toSnippet, SNIPPET_HIT_START, SNIPPET_HIT_END } = searchModule;

      assert.equal(
        toSnippet(`<img src=x onerror=alert(1)>${SNIPPET_HIT_START}needle${SNIPPET_HIT_END}`),
        '&lt;img src=x onerror=alert(1)&gt;<mark>needle</mark>',
      );
      assert.equal(toSnippet('plain & text'), 'plain &amp; text');
      assert.equal(
        toSnippet(`@@HABI_HIT@@<script>x</script>@@/HABI_HIT@@ tail`),
        '<mark>&lt;script&gt;x&lt;/script&gt;</mark> tail',
      );

      const conversation = await createConversation(userA, botA, 'Snippet');
      await addMessage(
        conversation.id,
        userA,
        `<script>alert('snippet')</script> konami math 3 < 5 beam <b>beam</b>`,
        '2026-11-01T05:00:00.000Z',
      );

      // PostgreSQL's headline parser drops complete HTML tags but keeps bare
      // angle-bracket text; that text must still be escaped by `toSnippet`.
      const konami = await search(userA, 'konami', { conversationId: conversation.id });
      assert.equal(konami.hits.length, 1);
      const { snippet } = konami.hits[0];
      assert.ok(snippet.includes('&lt; 5'), `expected escaped angle bracket: ${snippet}`);
      assert.ok(!snippet.includes('<script'));
      assert.ok(!snippet.includes('</script>'));
      assert.ok(!snippet.includes('<b>'));
      assertInertSnippet(snippet);

      const beam = await search(userA, 'beam', { conversationId: conversation.id });
      assert.equal(beam.hits.length, 1);
      assert.match(beam.hits[0].snippet, /<mark>beam<\/mark>/);
      assert.ok(!beam.hits[0].snippet.includes('<b>'));
      assertInertSnippet(beam.hits[0].snippet);
    });

    test('narrows by conversation and Bot without widening ownership', async () => {
      const conversationOne = await createConversation(userA, botA, 'Filter one');
      const conversationTwo = await createConversation(userA, botA, 'Filter two');
      const conversationThree = await createConversation(userA, botAOther, 'Filter three');
      const conversationB = await createConversation(userB, botB, 'Filter B');

      await addMessage(conversationOne.id, userA, 'filterable alpha', '2026-11-01T06:00:00Z');
      await addMessage(conversationTwo.id, userA, 'filterable beta', '2026-11-01T06:01:00Z');
      await addMessage(conversationThree.id, userA, 'filterable gamma', '2026-11-01T06:02:00Z');
      await addMessage(conversationB.id, userB, 'filterable delta', '2026-11-01T06:03:00Z');

      const all = await search(userA, 'filterable');
      assert.equal(all.hits.length, 3);
      assert.ok(!all.hits.some((hit) => hit.conversationId === conversationB.id));

      const byConversation = await search(userA, 'filterable', {
        conversationId: conversationOne.id,
      });
      assert.deepEqual(
        byConversation.hits.map((hit) => hit.conversationId),
        [conversationOne.id],
      );

      const byBot = await search(userA, 'filterable', { botId: botA });
      assert.equal(byBot.hits.length, 2);
      assert.ok(byBot.hits.every((hit) => hit.botId === botA));

      const byOtherBot = await search(userA, 'filterable', { botId: botAOther });
      assert.deepEqual(
        byOtherBot.hits.map((hit) => hit.conversationId),
        [conversationThree.id],
      );

      // A conversation cannot be paired with a Bot it does not belong to.
      assert.deepEqual(
        (await search(userA, 'filterable', {
          conversationId: conversationOne.id,
          botId: botAOther,
        })).hits,
        [],
      );

      // Foreign scopes stay empty even when combined with a valid owned one.
      assert.deepEqual(
        (await search(userA, 'filterable', {
          conversationId: conversationOne.id,
          botId: botB,
        })).hits,
        [],
      );
    });

    test('searches archived history but excludes deleted conversations and Bots', async () => {
      const archivedConversation = await createConversation(userA, botA, 'Archived thread');
      await addMessage(
        archivedConversation.id,
        userA,
        'archsearch archived record',
        '2026-11-01T07:00:00Z',
      );
      await chat.conversations.archive(userA, archivedConversation.id);

      const deletedConversation = await createConversation(userA, botA, 'Deleted thread');
      await addMessage(
        deletedConversation.id,
        userA,
        'delsearch deleted record',
        '2026-11-01T07:01:00Z',
      );
      await chat.conversations.delete(userA, deletedConversation.id);

      const archivedBotConversation = await createConversation(
        userA,
        archivedBot,
        'Archived bot thread',
      );
      await addMessage(
        archivedBotConversation.id,
        userA,
        'botarchsearch archived bot record',
        '2026-11-01T07:02:00Z',
      );

      const deletedBotConversation = await createConversation(
        userA,
        deletedBot,
        'Deleted bot thread',
      );
      await addMessage(
        deletedBotConversation.id,
        userA,
        'botdelsearch deleted bot record',
        '2026-11-01T07:03:00Z',
      );

      // Lifecycle changes happen after the fixtures exist, so archived Bots
      // remain readable history while a tombstoned Bot denies access.
      await pool.query(
        `UPDATE bots SET status = 'archived', archived_at = now() WHERE id = $1`,
        [archivedBot],
      );
      await pool.query(
        `UPDATE bots SET status = 'deleted', deleted_at = now() WHERE id = $1`,
        [deletedBot],
      );

      const archivedHit = await search(userA, 'archsearch');
      assert.deepEqual(
        archivedHit.hits.map((hit) => hit.conversationId),
        [archivedConversation.id],
      );
      assert.equal(archivedHit.hits[0].snippet.includes('<mark>'), true);

      assert.deepEqual((await search(userA, 'delsearch')).hits, []);
      assert.deepEqual((await search(userA, 'botdelsearch')).hits, []);

      const archivedBotHit = await search(userA, 'botarchsearch');
      assert.deepEqual(
        archivedBotHit.hits.map((hit) => hit.conversationId),
        [archivedBotConversation.id],
      );

      // Filtering by the deleted conversation is the same empty page as a
      // foreign id: tombstones are not an existence oracle.
      assert.deepEqual(
        await search(userA, 'delsearch', { conversationId: deletedConversation.id }),
        EMPTY_MESSAGE_PAGE,
      );

      const tombstone = await pool.query(
        `SELECT status FROM messages WHERE conversation_id = $1`,
        [deletedConversation.id],
      );
      assert.deepEqual(
        tombstone.rows.map((row) => row.status),
        ['deleted'],
      );

      const deletedConversationStillStored = await pool.query(
        `SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1`,
        [deletedBotConversation.id],
      );
      assert.equal(deletedConversationStillStored.rows[0].count, 1);
    });

    test('groups matches into owned conversations with counts and stable pages', async () => {
      const first = await createConversation(userA, botA, 'Group first');
      const second = await createConversation(userA, botA, 'Group second');
      const third = await createConversation(userA, botAOther, 'Group third');
      const foreign = await createConversation(userB, botB, 'Group foreign');

      await addMessage(first.id, userA, 'groupable one', '2026-11-01T08:00:00Z');
      await addMessage(first.id, userA, 'groupable two', '2026-11-01T08:01:00Z');
      await addMessage(first.id, userA, 'groupable three', '2026-11-01T08:02:00Z');
      await addMessage(second.id, userA, 'groupable four', '2026-11-01T08:03:00Z');
      await addMessage(third.id, userA, 'groupable five', '2026-11-01T08:04:00Z');
      await addMessage(foreign.id, userB, 'groupable six', '2026-11-01T08:05:00Z');
      await addMessage(foreign.id, userB, 'groupable seven', '2026-11-01T08:06:00Z');

      const grouped = await searchConversations(userA, 'groupable', { limit: 50 });
      assert.deepEqual(
        grouped.conversations.map((row) => row.conversationId),
        [third.id, second.id, first.id],
      );
      assert.deepEqual(
        grouped.conversations.map((row) => row.matchCount),
        [1, 1, 3],
      );
      assert.ok(!grouped.conversations.some((row) => row.conversationId === foreign.id));

      const firstGroup = grouped.conversations.find((row) => row.conversationId === first.id);
      assert.equal(firstGroup.matchCount, 3);
      assert.equal(firstGroup.title, 'Group first');
      assert.equal(firstGroup.botId, botA);
      assert.equal(firstGroup.status, 'active');

      const forB = await searchConversations(userB, 'groupable');
      assert.equal(forB.conversations.length, 1);
      assert.equal(forB.conversations[0].conversationId, foreign.id);
      assert.equal(forB.conversations[0].matchCount, 2);

      assert.deepEqual(
        await searchConversations(userA, 'groupable', { conversationId: foreign.id }),
        { conversations: [], hasMore: false, nextCursor: null },
      );

      const byBot = await searchConversations(userA, 'groupable', { botId: botAOther });
      assert.deepEqual(
        byBot.conversations.map((row) => row.conversationId),
        [third.id],
      );

      // Counts stay owner-scoped in the grouped query itself.
      assert.equal(
        (await searchConversations(userA, 'groupable', { conversationId: first.id }))
          .conversations[0].matchCount,
        3,
      );

      const paged = [];
      let cursor;
      let pages = 0;
      for (;;) {
        const page = await searchConversations(userA, 'groupable', {
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        paged.push(...page.conversations.map((row) => row.conversationId));
        pages += 1;
        assert.ok(pages < 20, 'conversation pagination did not terminate');
        if (page.nextCursor === null) {
          assert.equal(page.hasMore, false);
          break;
        }
        assert.equal(page.hasMore, true);
        cursor = page.nextCursor;
      }

      assert.deepEqual(paged, [third.id, second.id, first.id]);
      assert.equal(pages, 3);

      const scoped = await searchConversations(userA, 'groupable', { limit: 1 });
      await rejectsWithCode(
        searchConversations(userA, 'needle', { limit: 1, cursor: scoped.nextCursor }),
        'invalid_cursor',
      );
      await rejectsWithCode(
        searchConversations(userA, 'groupable', {
          limit: 1,
          conversationId: first.id,
          cursor: scoped.nextCursor,
        }),
        'invalid_cursor',
      );

      const archivedGroup = await createConversation(userA, botA, 'Group archived');
      await addMessage(archivedGroup.id, userA, 'groupable archived', '2026-11-01T08:07:00Z');
      await chat.conversations.archive(userA, archivedGroup.id);
      const withArchived = await searchConversations(userA, 'groupable', { limit: 50 });
      assert.equal(
        withArchived.conversations.find((row) => row.conversationId === archivedGroup.id)
          ?.status,
        'archived',
      );
    });

    test('defaults to twenty results and caps a page at fifty', async () => {
      const { normalizeSearchLimit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } = searchModule;
      assert.equal(DEFAULT_SEARCH_LIMIT, 20);
      assert.equal(MAX_SEARCH_LIMIT, 50);
      assert.equal(normalizeSearchLimit(undefined), 20);
      assert.equal(normalizeSearchLimit(1000), 50);
      assert.throws(() => normalizeSearchLimit(0), (error) => error.code === 'invalid_input');

      const conversation = await createConversation(userA, botA, 'Large result set');
      const created = [];
      for (let index = 0; index < 55; index += 1) {
        created.push(
          await addMessage(
            conversation.id,
            userA,
            `capbound item ${String(index).padStart(2, '0')}`,
            `2026-11-01T09:${String(index).padStart(2, '0')}:00.000000Z`,
          ),
        );
      }

      const defaultPage = await search(userA, 'capbound', {
        conversationId: conversation.id,
      });
      assert.equal(defaultPage.hits.length, 20);
      assert.equal(defaultPage.hasMore, true);

      const bounded = await search(userA, 'capbound', {
        conversationId: conversation.id,
        limit: 1000,
      });
      assert.equal(bounded.hits.length, 50);
      assert.equal(bounded.hasMore, true);

      const ids = await collectMessageIds(userA, 'capbound', {
        conversationId: conversation.id,
        limit: 50,
      });
      assert.equal(ids.length, 55);
      assert.equal(new Set(ids).size, 55);

      // Every message was returned exactly once, newest first.
      assert.deepEqual(
        ids,
        created
          .slice()
          .reverse()
          .map((message) => message.id),
      );
    });
  },
);
