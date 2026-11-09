/**
 * H-032 (#32) account export and deletion integration smoke tests.
 *
 * Boots the real Nest application in-process with `HABI_AUTH_SPIKE=1` and
 * `HABI_P1_API=1` against an ephemeral PostgreSQL 18.6 container and the real
 * migrations, including 0017's account-purge guard for immutable version
 * history. Two accounts are created through the real signup route; their data
 * is seeded through the real services at every owner-scoped surface.
 *
 * Coverage:
 *   export        every owned section is present, counts match the database,
 *                 the body streams without a content length, and a second
 *                 account's ids/emails/content never appear
 *   confirmation  missing, wrong, and foreign-account confirmation are refused
 *                 before anything changes; CSRF stays required
 *   delete        every owned row is removed, attachment bytes are removed, the
 *                 identity is tombstoned and credentials cleared, all live
 *                 sessions are revoked, and the other account is untouched
 *   idempotency   the HTTP retry is 401 because the session is revoked; the
 *                 service repeat returns the first deletion instant and shape
 *   login         old credentials and an unknown address get the same
 *                 non-enumerating failure
 *   disclosure    the response states the 184-day encrypted-backup window and
 *                 never claims immediate purge from an archive
 *
 * Docker unavailability skips the suite; the container, pool, app, and temp
 * storage are removed afterwards. No provider or external service is used.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
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
const PASSWORD = 'correct horse battery staple';
const REQUEST_TIMEOUT_MS = 20000;
const SESSION_COOKIE_PATTERN = /^(?:__Host-)?habi_session=/;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const CSRF_INVALID = { error: { code: 'csrf_invalid' } };
const INVALID_INPUT = { error: { code: 'invalid_input' } };
const INVALID_CREDENTIALS = { error: { code: 'invalid_credentials' } };

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

function migrate(databaseUrl) {
  return spawnSync(process.execPath, [MIGRATE_SCRIPT, '--database-url', databaseUrl], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function dryRun(databaseUrl) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl, '--dry-run'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60000 },
  );
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

  throw new Error('PostgreSQL did not become ready for the account suite.');
}

function readSession(response) {
  const setCookie = response.headers
    .getSetCookie()
    .find((cookie) => SESSION_COOKIE_PATTERN.test(cookie));

  assert.ok(setCookie, 'response did not set a session cookie');

  return {
    cookie: setCookie.split(';')[0],
    csrfToken: response.headers.get('x-csrf-token'),
    sessionId: setCookie.split(';')[0].slice(setCookie.indexOf('=') + 1),
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

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Every owner-scoped table, with the identity column that scopes it. */
const OWNED_TABLES = [
  ['bots', 'owner_user_id'],
  ['conversations', 'owner_user_id'],
  ['messages', 'owner_user_id'],
  ['runs', 'owner_user_id'],
  ['run_events', 'owner_user_id'],
  ['artifacts', 'owner_user_id'],
  ['artifact_versions', 'owner_user_id'],
  ['attachments', 'owner_user_id'],
  ['document_chunks', 'owner_user_id'],
  ['memories', 'owner_user_id'],
  ['memory_audit', 'owner_user_id'],
  ['skills', 'owner_user_id'],
  ['skill_versions', 'owner_user_id'],
  ['usage_buckets', 'owner_user_id'],
  ['usage_reservations', 'owner_user_id'],
  ['usage_limit_audit', 'owner_user_id'],
  ['sso_identities', 'user_id'],
  ['sso_pending_authorizations', 'user_id'],
  ['password_reset_tokens', 'user_id'],
];

const dockerReady = await dockerAvailable();

describe(
  'H-032 account export and deletion (PostgreSQL)',
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
    let accounts;
    let accountA;
    let accountB;
    let aSession;
    let bSession;
    let accountExport;
    let services;
    let backupDisclosure;

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

    async function requestRecovery(email) {
      const response = await request('/auth/recovery/request', {
        method: 'POST',
        cookie: false,
        body: { email },
      });

      assert.equal(response.status, 200, response.text);
    }

    async function ownedCounts(userId) {
      const counts = {};

      for (const [table, column] of OWNED_TABLES) {
        const result = await pool.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`,
          [userId],
        );
        counts[table] = result.rows[0].count;
      }

      const search = await pool.query(
        `SELECT count(*)::int AS count
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           JOIN bots b ON b.id = c.bot_id
          WHERE m.owner_user_id = $1
            AND c.owner_user_id = $1
            AND c.deleted_at IS NULL
            AND c.status <> 'deleted'
            AND b.owner_user_id = $1
            AND b.deleted_at IS NULL
            AND b.status <> 'deleted'
            AND m.deleted_at IS NULL
            AND m.status <> 'deleted'`,
        [userId],
      );
      counts.search = search.rows[0].count;

      return counts;
    }

    /**
     * Seeds one account through the real services: Bot with instructions,
     * conversation, messages, a queued Run and its events, artifact with two
     * versions, attachment with bytes and extracted text, accepted memory with
     * audit rows, skill with two versions, and an SSO identity. Unique markers
     * make cross-account leakage unambiguous.
     */
    async function seedAccount(label, userId, email, botName) {
      const bot = await services.bots.create(userId, {
        name: botName,
        description: `${label} account bot`,
        instructionsMarkdown: `# ${label} instructions\n\n${label}-instructions-marker`,
      });
      const conversation = await services.conversations.create(userId, {
        botId: bot.id,
        title: `${label} thread`,
      });
      const firstMessage = await services.messages.append(userId, {
        conversationId: conversation.id,
        role: 'user',
        content: `${label}-message-marker`,
        clientMessageId: `${label}-message-1`,
      });
      await services.messages.append(userId, {
        conversationId: conversation.id,
        role: 'assistant',
        content: `${label}-answer-marker`,
        clientMessageId: `${label}-message-2`,
      });

      const posted = await services.api.postMessage(userId, conversation.id, {
        content: `${label}-run-message-marker`,
        clientMessageId: `${label}-run-message`,
      });

      for (const [type, payload] of [
        ['run.created', { marker: `${label}-event-marker` }],
        ['message.delta', { marker: `${label}-delta-marker` }],
        ['run.completed', { marker: `${label}-done-marker` }],
      ]) {
        await services.events.append(userId, {
          runId: posted.runId,
          type,
          payload,
        });
      }

      await pool.query(
        `UPDATE runs
            SET status = 'completed',
                dispatch_state = 'dispatched',
                finished_at = now(),
                last_event_seq = 3
          WHERE id = $1
            AND owner_user_id = $2`,
        [posted.runId, userId],
      );

      const artifact = await services.artifacts.create(userId, {
        kind: 'markdown',
        title: `${label} artifact`,
        content: `# ${label} artifact\n\n${label}-artifact-v1-marker`,
        conversationId: conversation.id,
      });
      await services.artifacts.update(userId, artifact.artifact.id, {
        content: `# ${label} artifact\n\n${label}-artifact-v2-marker`,
      });

      const attachment = await services.attachments.createUpload(
        userId,
        conversation.id,
        {
          filename: `${label}-attachment.txt`,
          contentType: 'text/plain',
          source: (async function* () {
            yield Buffer.from(`${label}-attachment-bytes-marker`, 'utf8');
          })(),
        },
      );
      await services.attachments.finalize(userId, attachment.id);

      const chunkText = `${label}-extracted-text-marker`;
      await pool.query(
        `INSERT INTO document_chunks (
           attachment_id, owner_user_id, conversation_id, chunk_index, text,
           start_offset, end_offset
         )
         VALUES ($1, $2, $3, 0, $4, 0, $5)`,
        [attachment.id, userId, conversation.id, chunkText, chunkText.length],
      );

      const memory = await services.memory.propose(userId, {
        botId: bot.id,
        conversationId: conversation.id,
        sourceMessageId: firstMessage.id,
        content: `${label}-memory-marker`,
      });
      await services.memory.approveBot(userId, memory.id);
      await services.memory.approveConversation(userId, memory.id);
      await services.memory.accept(userId, memory.id);

      const skill = await services.skills.create(userId, {
        name: `${label} skill`,
        description: `${label}-skill-description-marker`,
        bodyMarkdown: `# ${label} skill\n\n${label}-skill-v1-marker`,
        botId: bot.id,
        status: 'active',
      });
      await services.skills.update(userId, skill.id, {
        bodyMarkdown: `# ${label} skill\n\n${label}-skill-v2-marker`,
      });

      const subject = `${label}-${randomUUID()}`;
      await pool.query(
        `INSERT INTO sso_identities (
           user_id, provider, subject, email, email_trusted, last_login_at
         )
         VALUES ($1, 'google', $2, $3, true, now())`,
        [userId, subject, email],
      );

      // A pending link flow carries server-side verification material. It is
      // never exported, but deletion must remove it.
      const stateHash = randomBytes(32).toString('hex');
      const browserHash = randomBytes(32).toString('hex');
      const sessionHash = randomBytes(32).toString('hex');
      const verifier = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO sso_pending_authorizations (
           state_hash, browser_hash, provider, purpose, code_verifier, nonce,
           redirect_uri, user_id, session_hash, expires_at
         )
         VALUES ($1, $2, 'google', 'link', $3, $4,
                 'http://localhost/auth/callback', $5, $6, now() + interval '10 minutes')`,
        [stateHash, browserHash, verifier, nonce, userId, sessionHash],
      );

      await pool.query(
        `INSERT INTO usage_limit_audit (
           owner_user_id, day_bucket, actor_user_id, action, tokens_delta, note
         )
         VALUES ($1, current_date, $1, 'reconcile', 0, $2)`,
        [userId, `${label}-usage-audit-marker`],
      );

      return {
        label,
        email,
        botId: bot.id,
        conversationId: conversation.id,
        firstMessageId: firstMessage.id,
        runId: posted.runId,
        artifactId: artifact.artifact.id,
        attachmentId: attachment.id,
        attachmentFilename: `${label}-attachment.txt`,
        memoryId: memory.id,
        skillId: skill.id,
        ssoSubject: subject,
        chunkText,
      };
    }

    before(async () => {
      containerName = `habi-h032-${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');
      const container = await run('docker', [
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

      const pending = dryRun(databaseUrl);
      assert.equal(pending.status, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0017_account_deletion\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0016_run_cancel_intent\.sql/);
      assert.match(applied.stdout, /applied\s+0017_account_deletion\.sql/);

      storageRoot = await mkdtemp(join(tmpdir(), 'habi-h032-storage-'));

      process.env.NODE_ENV = 'test';
      process.env.HABI_AUTH_SPIKE = '1';
      process.env.HABI_P1_API = '1';
      process.env.DATABASE_URL = databaseUrl;
      process.env.HABI_ATTACHMENT_STORAGE_ROOT = storageRoot;

      const { AppModule } = await import('../dist/app.module.js');
      const { NestFactory } = await import('@nestjs/core');
      const { BotService } = await import('../dist/bots/index.js');
      const { ConversationRepository, MessageRepository } = await import(
        '../dist/persistence/index.js'
      );
      const { RunEventStore } = await import('../dist/events/index.js');
      const { ApiService } = await import('../dist/api/api-service.js');
      const { ArtifactService } = await import('../dist/artifacts/index.js');
      const { AttachmentService, LocalAttachmentStorage, buildAttachmentStorageKey } =
        await import('../dist/attachments/index.js');
      const { MemoryService } = await import('../dist/memory/index.js');
      const { SkillService } = await import('../dist/skills/index.js');
      const {
        AccountService,
        BACKUP_RETENTION_DISCLOSURE,
        BACKUP_RETENTION_MAX_DAYS,
        BACKUP_RETENTION_POLICY,
      } = await import('../dist/account/index.js');

      backupDisclosure = {
        AccountService,
        disclosure: BACKUP_RETENTION_DISCLOSURE,
        maximumDays: BACKUP_RETENTION_MAX_DAYS,
        policy: BACKUP_RETENTION_POLICY,
        buildAttachmentStorageKey,
      };

      storage = new LocalAttachmentStorage(storageRoot);
      await storage.initialize();

      services = {
        bots: new BotService(pool),
        conversations: new ConversationRepository(pool),
        messages: new MessageRepository(pool),
        events: new RunEventStore(pool),
        api: new ApiService(pool),
        artifacts: new ArtifactService(pool),
        attachments: new AttachmentService(pool, storage),
        memory: new MemoryService(pool),
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

      const signedUpA = await signup('account-a@example.test');
      const signedUpB = await signup('account-b@example.test');
      const emailA = signedUpA.user.email;
      const emailB = signedUpB.user.email;

      accountA = await seedAccount(
        'alpha',
        signedUpA.user.userId,
        emailA,
        'Alpha Bot',
      );
      accountB = await seedAccount(
        'beta',
        signedUpB.user.userId,
        emailB,
        'Beta Bot',
      );

      // A hashed recovery token exists for A. It is credential material and
      // must be removed by deletion but never exported.
      await requestRecovery(emailA);

      aSession = await login(emailA);
      bSession = await login(emailB);

      accounts = {
        A: { ...signedUpA.user, ...accountA },
        B: { ...signedUpB.user, ...accountB },
      };
      accountExport = {
        aSession,
        bSession,
        signupSessionA: signedUpA.session,
      };
    });

    after(async () => {
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

    test('exports every owned section with counts that match the database', async () => {
      const client = createClient(base, accountExport.aSession);
      const response = await client('/api/account/export');

      assert.equal(response.status, 200, response.text);
      assert.match(
        response.headers.get('content-type') ?? '',
        /^application\/json; charset=utf-8$/,
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(
        response.headers.get('content-disposition') ?? '',
        /^attachment; filename="habi-account-export-.*\.json"$/,
      );
      // The document is streamed: no precomputed content length.
      assert.equal(response.headers.get('content-length'), null);

      const document = JSON.parse(response.text);
      assert.equal(document.manifest.schemaVersion, 1);
      assert.equal(document.manifest.accountId, accounts.A.userId);
      assert.ok(
        !Number.isNaN(Date.parse(document.manifest.exportedAt)),
        'manifest.exportedAt is not a timestamp',
      );
      assert.ok(Array.isArray(document.manifest.excluded));
      assert.ok(document.manifest.excluded.length > 0);

      assert.equal(document.profile.userId, accounts.A.userId);
      assert.equal(document.profile.email, accounts.A.email);

      const expected = await ownedCounts(accounts.A.userId);
      const expectedBySection = {
        ssoIdentities: expected.sso_identities,
        bots: expected.bots,
        conversations: expected.conversations,
        messages: expected.messages,
        runs: expected.runs,
        runEvents: expected.run_events,
        artifacts: expected.artifacts,
        artifactVersions: expected.artifact_versions,
        attachments: expected.attachments,
        attachmentText: expected.document_chunks,
        memories: expected.memories,
        memoryAudit: expected.memory_audit,
        skills: expected.skills,
        skillVersions: expected.skill_versions,
        usageBuckets: expected.usage_buckets,
        usageReservations: expected.usage_reservations,
        usageAudit: expected.usage_limit_audit,
        search: expected.search,
      };

      for (const [section, count] of Object.entries(expectedBySection)) {
        assert.equal(
          document.manifest.counts[section],
          count,
          `manifest count for ${section} differs from the database`,
        );
        assert.equal(
          document[section].length,
          count,
          `streamed ${section} length differs from its count`,
        );
      }

      // Every owned record type is actually present, not merely counted.
      for (const section of [
        'ssoIdentities',
        'bots',
        'conversations',
        'messages',
        'runs',
        'runEvents',
        'artifacts',
        'artifactVersions',
        'attachments',
        'attachmentText',
        'memories',
        'memoryAudit',
        'skills',
        'skillVersions',
        'usageBuckets',
        'usageReservations',
        'usageAudit',
        'search',
      ]) {
        assert.ok(document[section].length > 0, `${section} is empty`);
      }

      assert.equal(document.artifactVersions.length, 2);
      assert.equal(
        document.artifactVersions.some((version) =>
          version.content.includes('alpha-artifact-v2-marker'),
        ),
        true,
      );
      assert.equal(document.skillVersions.length, 2);
      assert.equal(
        document.memories[0].botApproved && document.memories[0].conversationApproved,
        true,
      );
      assert.equal(
        document.attachments[0].originalFilename,
        accounts.A.attachmentFilename,
      );
      assert.equal(document.attachmentText[0].text, accounts.A.chunkText);
      assert.equal(
        document.search.some((entry) => entry.text.includes('alpha-message-marker')),
        true,
      );
      assert.equal(document.bots[0].name, 'Alpha Bot');
      assert.match(document.bots[0].instructionsMarkdown, /alpha-instructions-marker/);

      // Credential material, session material, and storage keys never appear.
      const serialized = response.text;
      assert.equal(serialized.includes(PASSWORD), false);
      assert.equal(serialized.includes('password_hash'), false);
      assert.equal(serialized.includes('passwordHash'), false);
      assert.equal(serialized.includes('storageKey'), false);
      assert.equal(serialized.includes('storage_key'), false);
      assert.equal(serialized.includes(accountExport.aSession.sessionId), false);
      assert.equal(serialized.includes(accountExport.aSession.csrfToken), false);
      assert.equal(serialized.includes('csrfToken'), false);
    });

    test("never includes the other account's data, even with foreign ids in the query", async () => {
      const client = createClient(base, accountExport.bSession);
      const response = await client(
        `/api/account/export?userId=${accounts.A.userId}&accountId=${accounts.A.userId}`,
      );

      assert.equal(response.status, 200, response.text);

      const document = JSON.parse(response.text);
      assert.equal(document.profile.userId, accounts.B.userId);
      assert.equal(document.profile.email, accounts.B.email);
      assert.equal(document.manifest.accountId, accounts.B.userId);

      for (const foreign of [
        accounts.A.userId,
        accounts.A.email,
        accounts.A.botId,
        accounts.A.conversationId,
        accounts.A.firstMessageId,
        accounts.A.runId,
        accounts.A.artifactId,
        accounts.A.attachmentId,
        accounts.A.memoryId,
        accounts.A.skillId,
        accounts.A.ssoSubject,
        'alpha-message-marker',
        'alpha-artifact-v2-marker',
        'alpha-memory-marker',
        'alpha-skill-v2-marker',
        'alpha-attachment-bytes-marker',
        'alpha-extracted-text-marker',
        'alpha-delta-marker',
      ]) {
        assert.equal(
          response.text.includes(foreign),
          false,
          `export leaked another account's value`,
        );
      }

      const own = await ownedCounts(accounts.B.userId);
      assert.equal(document.manifest.counts.bots, own.bots);
      assert.equal(document.bots[0].name, 'Beta Bot');
    });

    test('streams a section across multiple bounded pages', async () => {
      const signedUpC = await signup('pagination@example.test');
      const bot = await services.bots.create(signedUpC.user.userId, {
        name: 'Pagination Bot',
      });
      const conversation = await services.conversations.create(
        signedUpC.user.userId,
        { botId: bot.id, title: 'Pagination thread' },
      );

      // 205 rows crosses EXPORT_BATCH_SIZE (200) twice: messages and search.
      await pool.query(
        `INSERT INTO messages (
           conversation_id, owner_user_id, role, content, seq, status, finalized_at
         )
         SELECT $1, $2, 'user', 'pagination-marker-' || g, g, 'final', now()
           FROM generate_series(1, 205) AS g`,
        [conversation.id, signedUpC.user.userId],
      );

      const response = await createClient(base, signedUpC.session)(
        '/api/account/export',
      );
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers.get('content-length'), null);

      const document = JSON.parse(response.text);
      assert.equal(document.manifest.counts.messages, 205);
      assert.equal(document.messages.length, 205);
      assert.equal(document.manifest.counts.search, 205);
      assert.equal(document.search.length, 205);
      assert.equal(
        new Set(document.messages.map((message) => message.seq)).size,
        205,
      );
      assert.equal(
        new Set(document.search.map((entry) => entry.messageId)).size,
        205,
      );
      assert.equal(
        document.messages.every((message) =>
          message.content.startsWith('pagination-marker-'),
        ),
        true,
      );
    });

    test('requires a session on both routes', async () => {
      const anonymous = createClient(base);
      const exported = await anonymous('/api/account/export');
      assert.equal(exported.status, 401, exported.text);
      assert.deepEqual(exported.body, UNAUTHENTICATED);

      const deleted = await anonymous('/api/account', { method: 'DELETE' });
      assert.equal(deleted.status, 401, deleted.text);
      assert.deepEqual(deleted.body, UNAUTHENTICATED);
    });

    test('refuses missing, wrong, and foreign confirmation without changing anything', async () => {
      const client = createClient(base, accountExport.bSession);
      const before = await ownedCounts(accounts.B.userId);

      const missing = await client('/api/account', { method: 'DELETE', csrf: true });
      assert.equal(missing.status, 400, missing.text);
      assert.deepEqual(missing.body, INVALID_INPUT);

      const blank = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        body: { confirm: '   ' },
      });
      assert.equal(blank.status, 400, blank.text);
      assert.deepEqual(blank.body, INVALID_INPUT);

      const wrong = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        body: { confirm: 'someone-else@example.test' },
      });
      assert.equal(wrong.status, 400, wrong.text);
      assert.deepEqual(wrong.body, INVALID_INPUT);

      // Naming the other account's email is a foreign attempt. It is a refused
      // confirmation, not a way to target that account.
      const foreign = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        body: { confirm: accounts.A.email, userId: accounts.A.userId },
      });
      assert.equal(foreign.status, 400, foreign.text);
      assert.deepEqual(foreign.body, INVALID_INPUT);

      const noCsrf = await client('/api/account', {
        method: 'DELETE',
        body: { confirm: accounts.B.email },
      });
      assert.equal(noCsrf.status, 403, noCsrf.text);
      assert.deepEqual(noCsrf.body, CSRF_INVALID);

      const wrongCsrf = await client('/api/account', {
        method: 'DELETE',
        csrf: 'wrong',
        body: { confirm: accounts.B.email },
      });
      assert.equal(wrongCsrf.status, 403, wrongCsrf.text);
      assert.deepEqual(wrongCsrf.body, CSRF_INVALID);

      const after = await ownedCounts(accounts.B.userId);
      assert.deepEqual(after, before, 'a refused delete changed B data');

      const b = await pool.query(
        'SELECT status, deleted_at FROM users WHERE id = $1',
        [accounts.B.userId],
      );
      assert.equal(b.rows[0].status, 'active');
      assert.equal(b.rows[0].deleted_at, null);
    });

    test('deletes every owned surface, revokes sessions, and states the backup window', async () => {
      const aCountsBefore = await ownedCounts(accounts.A.userId);
      const bCountsBefore = await ownedCounts(accounts.B.userId);
      const client = createClient(base, accountExport.aSession);

      const response = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        // Extra ids are ignored; the account comes from the session only.
        body: {
          confirm: accounts.A.email,
          userId: accounts.B.userId,
          accountId: accounts.B.userId,
        },
      });

      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.deleted, true);
      assert.equal(response.body.accountId, accounts.A.userId);
      assert.equal(response.body.alreadyDeleted, false);
      assert.ok(!Number.isNaN(Date.parse(response.body.deletedAt)));
      assert.ok(
        response.body.sessionsRevoked >= 2,
        `expected both A sessions revoked, saw ${response.body.sessionsRevoked}`,
      );

      assert.equal(response.body.backupRetention.maximumDays, 184);
      assert.equal(
        response.body.backupRetention.policy,
        backupDisclosure.policy,
      );
      assert.equal(
        response.body.backupRetention.disclosure,
        backupDisclosure.disclosure,
      );
      assert.equal(
        response.body.backupRetention.disclosure.includes('184 days'),
        true,
      );
      assert.match(
        response.body.backupRetention.disclosure,
        /age-encrypted backups/,
      );
      assert.match(
        response.body.backupRetention.disclosure,
        /Nothing is purged from an existing archive/,
      );
      // Never promise an immediate backup purge.
      assert.equal(
        /immediately (?:deleted|purged) from (?:the )?backups/i.test(
          response.body.backupRetention.disclosure,
        ),
        false,
      );

      const aAfter = await ownedCounts(accounts.A.userId);
      for (const [table] of OWNED_TABLES) {
        assert.equal(aAfter[table], 0, `${table} still has account A rows`);
        assert.ok(aCountsBefore[table] >= 0);
      }
      assert.equal(aAfter.search, 0);
      assert.ok(aCountsBefore.bots > 0);
      assert.ok(aCountsBefore.run_events > 0);
      assert.ok(aCountsBefore.artifact_versions > 0);
      assert.ok(aCountsBefore.skill_versions > 0);
      assert.ok(aCountsBefore.usage_buckets > 0);
      assert.ok(aCountsBefore.usage_reservations > 0);
      assert.ok(aCountsBefore.sso_identities > 0);
      assert.ok(aCountsBefore.sso_pending_authorizations > 0);
      assert.ok(aCountsBefore.usage_limit_audit > 0);
      assert.ok(aCountsBefore.password_reset_tokens > 0);

      // Owned by another account: byte-for-byte untouched.
      const bAfter = await ownedCounts(accounts.B.userId);
      assert.deepEqual(bAfter, bCountsBefore, 'B data changed during A deletion');

      const identity = await pool.query(
        `SELECT status, deleted_at, email, password_hash, recovery_email
           FROM users
          WHERE id = $1`,
        [accounts.A.userId],
      );
      assert.equal(identity.rows[0].status, 'deleted');
      assert.notEqual(identity.rows[0].deleted_at, null);
      assert.equal(identity.rows[0].email, null);
      assert.equal(identity.rows[0].password_hash, null);
      assert.equal(identity.rows[0].recovery_email, null);

      // Attachment bytes are gone, not only the metadata row.
      const storageKey = backupDisclosure.buildAttachmentStorageKey({
        ownerUserId: accounts.A.userId,
        conversationId: accounts.A.conversationId,
        attachmentId: accounts.A.attachmentId,
      });
      assert.equal(await fileExists(join(storageRoot, storageKey)), false);
      assert.equal(await fileExists(storageRoot), true);

      // Every live A session is rejected, including the caller's.
      for (const session of [
        accountExport.aSession,
        accountExport.signupSessionA,
      ]) {
        const rejected = await createClient(base, session)('/api/bots');
        assert.equal(rejected.status, 401, rejected.text);
        assert.deepEqual(rejected.body, UNAUTHENTICATED);
      }

      const retry = await client('/api/account', {
        method: 'DELETE',
        csrf: true,
        body: { confirm: accounts.A.email },
      });
      assert.equal(retry.status, 401, retry.text);
      assert.deepEqual(retry.body, UNAUTHENTICATED);

      // B is still usable.
      const bBots = await createClient(base, accountExport.bSession)('/api/bots');
      assert.equal(bBots.status, 200, bBots.text);
      assert.deepEqual(
        bBots.body.bots.map((bot) => bot.id),
        [accounts.B.botId],
      );
    });

    test('repeats at the storage boundary with the same deletion shape', async () => {
      const service = new backupDisclosure.AccountService(pool, storage);
      const first = await service.deleteAccount(accounts.A.userId, accounts.A.email);
      const second = await service.deleteAccount(accounts.A.userId, accounts.A.email);

      assert.equal(first.deleted, true);
      assert.equal(second.deleted, true);
      assert.equal(second.alreadyDeleted, true);
      assert.equal(second.deletedAt, first.deletedAt);
      assert.deepEqual(Object.keys(second.removed), Object.keys(first.removed));
      for (const count of Object.values(second.removed)) {
        assert.equal(count, 0);
      }
      assert.equal(second.backupRetention.disclosure, first.backupRetention.disclosure);

      const aAfter = await ownedCounts(accounts.A.userId);
      for (const [table] of OWNED_TABLES) {
        assert.equal(aAfter[table], 0);
      }
    });

    test('login after deletion is the same non-enumerating failure as an unknown account', async () => {
      const deleted = await request('/auth/login', {
        method: 'POST',
        cookie: false,
        body: { email: accounts.A.email, password: PASSWORD },
      });
      const unknown = await request('/auth/login', {
        method: 'POST',
        cookie: false,
        body: {
          email: `unknown-${randomUUID()}@example.test`,
          password: PASSWORD,
        },
      });

      assert.equal(deleted.status, 401, deleted.text);
      assert.equal(unknown.status, 401, unknown.text);
      assert.deepEqual(deleted.body, INVALID_CREDENTIALS);
      assert.deepEqual(unknown.body, INVALID_CREDENTIALS);
      assert.deepEqual(deleted.body, unknown.body);
    });
  },
);
