/**
 * Same-origin chat BFF and data-selection tests.
 *
 * A stub HTTP server stands in for the Nest API. The built Next app is started
 * twice: once with `HABI_API_URL` pointing at the stub (live records, proxy
 * forwarding, SSE, 401/5xx) and once without it (the unchanged sample preview).
 *
 * These are server-side assertions. They prove that the browser session cookie
 * and CSRF token reach the API, that the `Last-Event-ID` cursor survives the
 * hop, that a failed request renders an error instead of sample data, and that
 * the backend origin never appears in the HTML.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../', import.meta.url));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const MISSING_BYTES_ID = '55555555-5555-4555-8555-555555555555';
const ARTIFACT_ID = '66666666-6666-4666-8666-666666666666';
const MEMORY_ID = '77777777-7777-4777-8777-777777777777';
const SKILL_ID = '88888888-8888-4888-8888-888888888888';
const CSRF = 'csrf-test-token';
const SESSION = 'session-test-secret';
const NOW = '2026-11-04T06:00:00.000Z';

const BOT = {
  id: BOT_ID,
  name: 'Live Field Notes',
  description: 'Reads what you attach.',
  avatarRef: null,
  instructionsMarkdown: 'Cite the document.',
  status: 'active',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const THREAD = {
  id: THREAD_ID,
  botId: BOT_ID,
  title: 'Live thread about ordering',
  status: 'active',
  lastMessageSeq: 2,
  createdAt: NOW,
  updatedAt: NOW,
};

const ATTACHMENT = {
  id: ATTACHMENT_ID,
  conversationId: THREAD_ID,
  messageId: null,
  originalFilename: 'live-notes.md',
  contentType: 'text/markdown',
  byteSize: 64,
  sha256: 'a'.repeat(64),
  status: 'stored',
  createdAt: NOW,
  storedAt: NOW,
  deletedAt: null,
};

const MISSING_ATTACHMENT = {
  id: MISSING_BYTES_ID,
  conversationId: THREAD_ID,
  messageId: null,
  originalFilename: 'not-stored.txt',
  contentType: 'text/plain',
  byteSize: 12,
  sha256: 'b'.repeat(64),
  status: 'stored',
  createdAt: NOW,
  storedAt: NOW,
  deletedAt: null,
};

const MEMORY = {
  id: MEMORY_ID,
  botId: BOT_ID,
  conversationId: THREAD_ID,
  content: 'Prefers short sections over bullet dumps.',
  sourceMessageId: null,
  status: 'accepted',
  botApproved: true,
  conversationApproved: false,
  provenanceState: 'live',
  provenanceTombstonedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const ARTIFACT = {
  id: ARTIFACT_ID,
  conversationId: THREAD_ID,
  runId: null,
  kind: 'markdown',
  title: 'Ordering note',
  currentVersion: 1,
  status: 'draft',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const ARTIFACT_VERSION = {
  artifactId: ARTIFACT_ID,
  version: 1,
  content: '# Ordering note\n\nThe cursor is the sequence, not the clock.',
  contentSha256: 'c'.repeat(64),
  byteSize: 58,
  createdBy: 'user-1',
  createdAt: NOW,
};

const ARTIFACT_DETAIL = { artifact: ARTIFACT, version: ARTIFACT_VERSION };

const SKILL = {
  id: SKILL_ID,
  botId: null,
  name: 'Plain verbs',
  description: 'Prefer plain verbs over nominalisations.',
  bodyMarkdown: 'Use plain verbs.',
  version: 1,
  status: 'active',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const RUN = {
  id: RUN_ID,
  conversationId: THREAD_ID,
  status: 'queued',
  dispatchState: 'not_dispatched',
  errorCode: null,
  lastEventSeq: 0,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  finishedAt: null,
  usage: {
    status: 'unknown',
    grossPromptTokens: null,
    grossCompletionTokens: null,
    cachedPromptTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costStatus: 'unknown',
  },
};

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

async function bootNext(env) {
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  let spawnError;
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  const exited = new Promise((resolve) => child.once('close', resolve));

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Next exited before readiness:\n${output}`);

    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1500) });
      ready = response.status === 200;
      if (ready) break;
    } catch {
      // Keep waiting for the server to bind.
    }

    await delay(150);
  }

  if (!ready) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    assert.fail(`Next did not become ready:\n${output}`);
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');

    let timer;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
    clearTimeout(timer);

    if (!stopped) {
      child.kill('SIGKILL');
      await exited;
      assert.fail(`Next did not stop after SIGTERM:\n${output}`);
    }
  }

  return { origin, stop };
}

function createStub() {
  const requests = [];

  const server = createHttpServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
      });

      const cookie = request.headers.cookie ?? '';

      if (!cookie.includes('habi_session=')) {
        json(response, 401, { error: { code: 'unauthenticated' } });
        return;
      }

      if (cookie.includes('habi_session=boom')) {
        json(response, 500, { error: { code: 'internal' } });
        return;
      }

      const url = new URL(request.url, 'http://stub.test');
      const path = url.pathname;

      if (request.method === 'GET' && path === '/api/bots') {
        json(response, 200, {
          bots: [
            {
              id: BOT_ID,
              name: BOT.name,
              purpose: 'Reads what you attach and names the paragraph behind every claim.',
              status: 'active',
              avatarRef: null,
              conversationCount: 1,
              lastActivityAt: NOW,
              updatedAt: NOW,
            },
          ],
          nextCursor: null,
        });
        return;
      }

      if (request.method === 'GET' && path === `/api/bots/${BOT_ID}`) {
        json(response, 200, {
          bot: BOT,
          purpose: 'Reads what you attach.',
          conversationCount: 1,
          lastActivityAt: NOW,
        });
        return;
      }

      if (request.method === 'GET' && path === `/api/bots/${BOT_ID}/threads`) {
        json(response, 200, {
          threads: [
            {
              id: THREAD_ID,
              botId: BOT_ID,
              title: 'Live thread about ordering',
              status: 'active',
              lastMessageSeq: 2,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          nextCursor: null,
        });
        return;
      }

      if (request.method === 'GET' && path === `/api/threads/${THREAD_ID}/messages`) {
        json(response, 200, {
          messages: [
            {
              id: 'message-1',
              conversationId: THREAD_ID,
              role: 'user',
              content: 'First live question',
              seq: 1,
              status: 'final',
              clientMessageId: null,
              createdAt: NOW,
              finalizedAt: NOW,
            },
            {
              id: 'message-2',
              conversationId: THREAD_ID,
              role: 'assistant',
              content: 'First live reply.\n\nSecond paragraph.',
              seq: 2,
              status: 'final',
              clientMessageId: null,
              createdAt: NOW,
              finalizedAt: NOW,
            },
          ],
          beforeCursor: null,
          afterCursor: null,
          hasMoreBefore: false,
          hasMoreAfter: false,
        });
        return;
      }

      if (request.method === 'POST' && path === `/api/threads/${THREAD_ID}/messages`) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        const payload = JSON.parse(body);
        json(response, 201, {
          message: {
            id: 'message-3',
            conversationId: THREAD_ID,
            role: 'user',
            content: payload.content,
            seq: 3,
            status: 'final',
            clientMessageId: payload.clientMessageId ?? null,
            createdAt: NOW,
            finalizedAt: NOW,
          },
          runId: RUN_ID,
          run: RUN,
        });
        return;
      }

      if (request.method === 'GET' && path === `/api/runs/${RUN_ID}/events`) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        response.write(
          `id: e1.${RUN_ID}.4\nevent: message.delta\ndata: ${JSON.stringify({
            id: 'event-4',
            runId: RUN_ID,
            seq: 4,
            type: 'message.delta',
            payload: { text: 'Streamed ' },
            createdAt: NOW,
          })}\n\n`,
        );
        response.write(
          `id: e1.${RUN_ID}.5\nevent: message.delta\ndata: ${JSON.stringify({
            id: 'event-5',
            runId: RUN_ID,
            seq: 5,
            type: 'message.delta',
            payload: { text: 'reply.' },
            createdAt: NOW,
          })}\n\n`,
        );
        response.write(
          `id: e1.${RUN_ID}.6\nevent: run.completed\ndata: ${JSON.stringify({
            id: 'event-6',
            runId: RUN_ID,
            seq: 6,
            type: 'run.completed',
            payload: {},
            createdAt: NOW,
          })}\n\n`,
        );
        response.end();
        return;
      }

      if (request.method === 'POST' && path === `/api/runs/${RUN_ID}/cancel`) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { run: { ...RUN, status: 'cancelled' } });
        return;
      }

      if (request.method === 'POST' && path === '/api/bots') {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 201, { bot: BOT });
        return;
      }

      if (
        (request.method === 'PATCH' || request.method === 'DELETE') &&
        path === `/api/bots/${BOT_ID}`
      ) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { bot: BOT });
        return;
      }

      if (request.method === 'POST' && path === `/api/bots/${BOT_ID}/threads`) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 201, { thread: THREAD });
        return;
      }

      if (
        (request.method === 'PATCH' || request.method === 'DELETE') &&
        path === `/api/threads/${THREAD_ID}`
      ) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { thread: THREAD });
        return;
      }

      if (request.method === 'GET' && path === `/api/threads/${THREAD_ID}/attachments`) {
        json(response, 200, {
          attachments: [ATTACHMENT, MISSING_ATTACHMENT],
          nextCursor: null,
        });
        return;
      }

      if (request.method === 'GET' && path === `/api/attachments/${ATTACHMENT_ID}`) {
        json(response, 200, { attachment: ATTACHMENT });
        return;
      }

      if (request.method === 'GET' && path === `/api/attachments/${ATTACHMENT_ID}/content`) {
        const text = '# Live notes\n\nThe stored paragraph mentions ordering.\n\nSecond paragraph.';
        response.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
        });
        response.end(text);
        return;
      }

      if (request.method === 'GET' && path === `/api/attachments/${MISSING_BYTES_ID}/content`) {
        json(response, 503, { error: { code: 'api_unavailable' } });
        return;
      }

      if (request.method === 'GET' && path === `/api/bots/${BOT_ID}/memories`) {
        json(response, 200, { memories: [MEMORY], nextCursor: null });
        return;
      }

      if (request.method === 'POST' && path === `/api/bots/${BOT_ID}/memories`) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 201, { memory: MEMORY });
        return;
      }

      if (request.method === 'POST' && path === `/api/memories/${MEMORY_ID}/approvals`) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, {
          memory: { ...MEMORY, botApproved: true, conversationApproved: true },
        });
        return;
      }

      if (request.method === 'GET' && path === '/api/artifacts') {
        json(response, 200, { artifacts: [ARTIFACT], nextCursor: null });
        return;
      }

      if (request.method === 'POST' && path === '/api/artifacts') {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        const payload = JSON.parse(body);

        // The downstream transport owns this bound; the BFF must relay its 413.
        if (
          typeof payload.content === 'string' &&
          Buffer.byteLength(payload.content, 'utf8') > 100 * 1024
        ) {
          json(response, 413, { error: { code: 'invalid_input' } });
          return;
        }

        json(response, 201, { artifact: ARTIFACT_DETAIL });
        return;
      }

      if (request.method === 'GET' && path === `/api/artifacts/${ARTIFACT_ID}`) {
        json(response, 200, { artifact: ARTIFACT_DETAIL });
        return;
      }

      if (request.method === 'PATCH' && path === `/api/artifacts/${ARTIFACT_ID}`) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { artifact: ARTIFACT_DETAIL });
        return;
      }

      if (request.method === 'GET' && path === `/api/artifacts/${ARTIFACT_ID}/versions`) {
        json(response, 200, {
          versions: [
            {
              artifactId: ARTIFACT_ID,
              version: 1,
              contentSha256: ARTIFACT_VERSION.contentSha256,
              byteSize: ARTIFACT_VERSION.byteSize,
              createdBy: ARTIFACT_VERSION.createdBy,
              createdAt: NOW,
            },
          ],
          nextCursor: null,
        });
        return;
      }

      if (request.method === 'POST' && path === `/api/artifacts/${ARTIFACT_ID}/restore`) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { artifact: ARTIFACT_DETAIL });
        return;
      }

      if (request.method === 'GET' && path === '/api/skills') {
        json(response, 200, { skills: [SKILL], nextCursor: null });
        return;
      }

      if (request.method === 'POST' && path === '/api/skills') {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 201, { skill: SKILL });
        return;
      }

      if (request.method === 'GET' && path === `/api/skills/${SKILL_ID}`) {
        json(response, 200, { skill: SKILL });
        return;
      }

      if (
        request.method === 'POST' &&
        (path === `/api/skills/${SKILL_ID}/attach` ||
          path === `/api/skills/${SKILL_ID}/detach`)
      ) {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { skill: SKILL });
        return;
      }

      if (request.method === 'GET' && path === '/api/search') {
        json(response, 200, {
          results: [
            {
              messageId: 'message-1',
              conversationId: THREAD_ID,
              conversationTitle: THREAD.title,
              botId: BOT_ID,
              role: 'user',
              seq: 1,
              createdAt: NOW,
              score: 0.5,
              snippet: 'First <mark>live</mark> question',
            },
          ],
          nextCursor: null,
        });
        return;
      }

      json(response, 404, { error: { code: 'not_found' } });
    });
  });

  return { server, requests };
}

test('the built chat surface forwards to the API and never renders sample data on failure', { timeout: 90_000 }, async () => {
  const stub = createStub();
  const upstreamPort = await listen(stub.server);
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
  const app = await bootNext({
    HABI_API_URL: upstreamOrigin,
  });

  const cookie = `habi_session=${SESSION}; habi-theme=dark`;

  async function page(path, headers = {}) {
    const response = await fetch(`${app.origin}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    return { response, html: await response.text() };
  }

  try {
    const bots = await fetch(`${app.origin}/api/bots?limit=5`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(bots.status, 200);
    assert.equal((await bots.json()).bots[0].name, BOT.name);
    const botsForward = stub.requests.find(
      (entry) => entry.method === 'GET' && entry.url === '/api/bots?limit=5',
    );
    assert.ok(botsForward, 'the proxy did not forward the bots list');
    assert.equal(botsForward.headers.cookie, `habi_session=${SESSION}`);
    assert.equal(botsForward.headers.origin, upstreamOrigin);

    const send = await fetch(`${app.origin}/api/threads/${THREAD_ID}/messages`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': CSRF,
      },
      body: JSON.stringify({ content: 'Hello from the test', clientMessageId: 'client-1' }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(send.status, 201);
    const sendBody = await send.json();
    assert.equal(sendBody.runId, RUN_ID);
    const sendForward = stub.requests.find(
      (entry) =>
        entry.method === 'POST' && entry.url === `/api/threads/${THREAD_ID}/messages`,
    );
    assert.ok(sendForward, 'the proxy did not forward the message');
    assert.equal(sendForward.headers['x-csrf-token'], CSRF);
    assert.equal(sendForward.headers.origin, upstreamOrigin);
    assert.equal(sendForward.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(sendForward.body), {
      content: 'Hello from the test',
      clientMessageId: 'client-1',
    });

    const badCsrf = await fetch(`${app.origin}/api/threads/${THREAD_ID}/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'no token' }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(badCsrf.status, 403);
    assert.deepEqual(await badCsrf.json(), { error: { code: 'csrf_invalid' } });

    const olderPage = await fetch(
      `${app.origin}/api/threads/${THREAD_ID}/messages?before=cursor-1&limit=30`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(olderPage.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) =>
          entry.method === 'GET' &&
          entry.url === `/api/threads/${THREAD_ID}/messages?before=cursor-1&limit=30`,
      ),
      'the proxy did not forward the older-message cursor',
    );

    const stream = await fetch(`${app.origin}/api/runs/${RUN_ID}/events`, {
      headers: { cookie, 'last-event-id': `e1.${RUN_ID}.3` },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(stream.headers.get('cache-control'), 'no-store');
    const frames = await stream.text();
    assert.match(frames, /id: e1\.44444444-4444-4444-8444-444444444444\.4/);
    assert.match(frames, /event: message\.delta/);
    assert.match(frames, /event: run\.completed/);
    const streamForward = stub.requests.find(
      (entry) =>
        entry.method === 'GET' && entry.url === `/api/runs/${RUN_ID}/events`,
    );
    assert.ok(streamForward, 'the proxy did not open the event stream');
    assert.equal(streamForward.headers['last-event-id'], `e1.${RUN_ID}.3`);
    assert.equal(streamForward.headers.accept, 'text/event-stream');

    const cancel = await fetch(`${app.origin}/api/runs/${RUN_ID}/cancel`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': CSRF },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).run.status, 'cancelled');

    async function write(method, path, body) {
      const response = await fetch(`${app.origin}${path}`, {
        method,
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': CSRF,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });

      return { response, body: await response.json() };
    }

    const createdBot = await write('POST', '/api/bots', {
      name: 'New live bot',
      description: 'A purpose',
      instructionsMarkdown: 'Be brief.',
    });
    assert.equal(createdBot.response.status, 201);
    assert.equal(createdBot.body.bot.id, BOT_ID);
    const botCreateForward = stub.requests.find(
      (entry) => entry.method === 'POST' && entry.url === '/api/bots',
    );
    assert.ok(botCreateForward, 'the proxy did not forward Bot creation');
    assert.deepEqual(JSON.parse(botCreateForward.body), {
      name: 'New live bot',
      description: 'A purpose',
      instructionsMarkdown: 'Be brief.',
    });

    const patchedBot = await write('PATCH', `/api/bots/${BOT_ID}`, { name: 'Renamed' });
    assert.equal(patchedBot.response.status, 200);
    const botPatchForward = stub.requests.find(
      (entry) => entry.method === 'PATCH' && entry.url === `/api/bots/${BOT_ID}`,
    );
    assert.ok(botPatchForward, 'the proxy did not forward the Bot patch');
    assert.equal(botPatchForward.headers.origin, upstreamOrigin);

    const archivedBot = await write('DELETE', `/api/bots/${BOT_ID}`);
    assert.equal(archivedBot.response.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) => entry.method === 'DELETE' && entry.url === `/api/bots/${BOT_ID}`,
      ),
      'the proxy did not forward the Bot archive',
    );

    const createdThread = await write('POST', `/api/bots/${BOT_ID}/threads`, { title: 'New' });
    assert.equal(createdThread.response.status, 201);
    assert.equal(createdThread.body.thread.id, THREAD_ID);

    const createdArtifact = await write('POST', '/api/artifacts', {
      kind: 'markdown',
      title: 'Cursor note',
      content: '# Cursor note\n\nThe cursor is opaque.',
      conversationId: THREAD_ID,
    });
    assert.equal(createdArtifact.response.status, 201);
    const artifactCreateForward = stub.requests.find(
      (entry) => entry.method === 'POST' && entry.url === '/api/artifacts',
    );
    assert.ok(artifactCreateForward, 'the proxy did not forward artifact creation');
    assert.equal(artifactCreateForward.headers['x-csrf-token'], CSRF);
    assert.deepEqual(JSON.parse(artifactCreateForward.body), {
      kind: 'markdown',
      title: 'Cursor note',
      content: '# Cursor note\n\nThe cursor is opaque.',
      conversationId: THREAD_ID,
    });

    const oversizedArtifact = await write('POST', '/api/artifacts', {
      kind: 'text',
      title: 'Too big',
      content: 'a'.repeat(101 * 1024),
      conversationId: THREAD_ID,
    });
    assert.equal(oversizedArtifact.response.status, 413);
    assert.deepEqual(oversizedArtifact.body, { error: { code: 'invalid_input' } });

    const artifactPostsBeforeHuge = stub.requests.filter(
      (entry) => entry.method === 'POST' && entry.url === '/api/artifacts',
    ).length;
    const hugeArtifact = await write('POST', '/api/artifacts', {
      kind: 'text',
      title: 'Over the BFF ceiling',
      content: 'a'.repeat(300 * 1024),
      conversationId: THREAD_ID,
    });
    assert.equal(hugeArtifact.response.status, 413);
    assert.deepEqual(hugeArtifact.body, { error: { code: 'invalid_input' } });
    assert.equal(
      stub.requests.filter(
        (entry) => entry.method === 'POST' && entry.url === '/api/artifacts',
      ).length,
      artifactPostsBeforeHuge,
      'the BFF pre-empted an oversized body instead of forwarding it',
    );

    const createdSkill = await write('POST', '/api/skills', {
      name: 'Cursor discipline',
      description: 'Treat cursors as opaque.',
      bodyMarkdown: 'Never parse a cursor.',
      botId: BOT_ID,
    });
    assert.equal(createdSkill.response.status, 201);
    assert.equal(createdSkill.body.skill.id, SKILL_ID);
    const skillCreateForward = stub.requests.find(
      (entry) => entry.method === 'POST' && entry.url === '/api/skills',
    );
    assert.ok(skillCreateForward, 'the proxy did not forward skill creation');
    assert.equal(skillCreateForward.headers['x-csrf-token'], CSRF);
    assert.deepEqual(JSON.parse(skillCreateForward.body), {
      name: 'Cursor discipline',
      description: 'Treat cursors as opaque.',
      bodyMarkdown: 'Never parse a cursor.',
      botId: BOT_ID,
    });

    const renamedThread = await write('PATCH', `/api/threads/${THREAD_ID}`, { title: 'Renamed' });
    assert.equal(renamedThread.response.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) => entry.method === 'PATCH' && entry.url === `/api/threads/${THREAD_ID}`,
      ),
      'the proxy did not forward the thread rename',
    );

    const deletedThread = await write('DELETE', `/api/threads/${THREAD_ID}`);
    assert.equal(deletedThread.response.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) => entry.method === 'DELETE' && entry.url === `/api/threads/${THREAD_ID}`,
      ),
      'the proxy did not forward the thread delete',
    );

    const attachments = await fetch(
      `${app.origin}/api/threads/${THREAD_ID}/attachments`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(attachments.status, 200);
    const attachmentBody = await attachments.json();
    assert.equal(attachmentBody.attachments[0].originalFilename, 'live-notes.md');
    assert.equal(attachmentBody.nextCursor, null);

    const metadata = await fetch(`${app.origin}/api/attachments/${ATTACHMENT_ID}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).attachment.id, ATTACHMENT_ID);

    const content = await fetch(
      `${app.origin}/api/attachments/${ATTACHMENT_ID}/content`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(content.status, 200);
    assert.match(content.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(await content.text(), /stored paragraph mentions ordering/);

    const missingContent = await fetch(
      `${app.origin}/api/attachments/${MISSING_BYTES_ID}/content`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(missingContent.status, 503);
    assert.deepEqual(await missingContent.json(), { error: { code: 'api_unavailable' } });

    const artifacts = await fetch(
      `${app.origin}/api/artifacts?conversationId=${THREAD_ID}`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(artifacts.status, 200);
    assert.equal((await artifacts.json()).artifacts[0].title, 'Ordering note');

    const artifactPage = await fetch(
      `${app.origin}/api/artifacts?conversationId=${THREAD_ID}&limit=20&cursor=artifact-cursor`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(artifactPage.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) =>
          entry.method === 'GET' &&
          entry.url === `/api/artifacts?conversationId=${THREAD_ID}&limit=20&cursor=artifact-cursor`,
      ),
      'the proxy did not forward the artifact cursor',
    );

    const artifact = await fetch(`${app.origin}/api/artifacts/${ARTIFACT_ID}?version=1`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(artifact.status, 200);
    const artifactBody = await artifact.json();
    assert.equal(artifactBody.artifact.version.version, 1);
    assert.match(artifactBody.artifact.version.content, /sequence, not the clock/);

    const savedArtifact = await write('PATCH', `/api/artifacts/${ARTIFACT_ID}`, {
      content: 'A new body.',
    });
    assert.equal(savedArtifact.response.status, 200);
    assert.equal(savedArtifact.body.artifact.artifact.id, ARTIFACT_ID);

    const versions = await fetch(
      `${app.origin}/api/artifacts/${ARTIFACT_ID}/versions`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(versions.status, 200);
    assert.equal((await versions.json()).versions[0].version, 1);

    const versionPage = await fetch(
      `${app.origin}/api/artifacts/${ARTIFACT_ID}/versions?limit=20&cursor=version-cursor`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(versionPage.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) =>
          entry.method === 'GET' &&
          entry.url === `/api/artifacts/${ARTIFACT_ID}/versions?limit=20&cursor=version-cursor`,
      ),
      'the proxy did not forward the artifact version cursor',
    );

    const restored = await write('POST', `/api/artifacts/${ARTIFACT_ID}/restore`, { version: 1 });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.artifact.version.version, 1);

    const memories = await fetch(`${app.origin}/api/bots/${BOT_ID}/memories`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(memories.status, 200);
    assert.equal((await memories.json()).memories[0].content, MEMORY.content);

    const memoryPage = await fetch(
      `${app.origin}/api/bots/${BOT_ID}/memories?limit=20&cursor=memory-cursor`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(memoryPage.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) =>
          entry.method === 'GET' &&
          entry.url === `/api/bots/${BOT_ID}/memories?limit=20&cursor=memory-cursor`,
      ),
      'the proxy did not forward the memory cursor',
    );

    const proposed = await write('POST', `/api/bots/${BOT_ID}/memories`, {
      text: 'A new memory',
      threadId: THREAD_ID,
    });
    assert.equal(proposed.response.status, 201);
    const memoryForward = stub.requests.find(
      (entry) => entry.method === 'POST' && entry.url === `/api/bots/${BOT_ID}/memories`,
    );
    assert.ok(memoryForward, 'the proxy did not forward the memory proposal');
    assert.deepEqual(JSON.parse(memoryForward.body), {
      text: 'A new memory',
      threadId: THREAD_ID,
    });

    const approved = await write('POST', `/api/memories/${MEMORY_ID}/approvals`, {
      bot: true,
      thread: true,
      threadId: THREAD_ID,
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.memory.conversationApproved, true);

    const skills = await fetch(`${app.origin}/api/skills`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(skills.status, 200);
    assert.equal((await skills.json()).skills[0].name, 'Plain verbs');

    const skillPage = await fetch(
      `${app.origin}/api/skills?limit=20&cursor=skill-cursor`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(skillPage.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) =>
          entry.method === 'GET' && entry.url === '/api/skills?limit=20&cursor=skill-cursor',
      ),
      'the proxy did not forward the skill cursor',
    );

    const skill = await fetch(`${app.origin}/api/skills/${SKILL_ID}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(skill.status, 200);

    const attached = await write('POST', `/api/skills/${SKILL_ID}/attach`, { botId: BOT_ID });
    assert.equal(attached.response.status, 200);
    assert.equal(attached.body.skill.id, SKILL_ID);

    const detached = await write('POST', `/api/skills/${SKILL_ID}/detach`);
    assert.equal(detached.response.status, 200);

    const search = await fetch(`${app.origin}/api/search?q=live&botId=${BOT_ID}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(search.status, 200);
    assert.equal((await search.json()).results[0].messageId, 'message-1');

    const searchPage = await fetch(
      `${app.origin}/api/search?q=live&botId=${BOT_ID}&limit=20&cursor=search-cursor`,
      { headers: { cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(searchPage.status, 200);
    assert.ok(
      stub.requests.find(
        (entry) =>
          entry.method === 'GET' &&
          entry.url === `/api/search?q=live&botId=${BOT_ID}&limit=20&cursor=search-cursor`,
      ),
      'the proxy did not forward the search cursor',
    );

    const unauthenticatedArtifacts = await fetch(`${app.origin}/api/artifacts`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(unauthenticatedArtifacts.status, 401);
    assert.deepEqual(await unauthenticatedArtifacts.json(), {
      error: { code: 'unauthenticated' },
    });

    const failedSkills = await fetch(`${app.origin}/api/skills`, {
      headers: { cookie: 'habi_session=boom' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(failedSkills.status, 500);
    assert.deepEqual(await failedSkills.json(), { error: { code: 'internal' } });

    const unauthenticated = await fetch(`${app.origin}/api/bots`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), {
      error: { code: 'unauthenticated' },
    });

    const upstreamFailure = await fetch(`${app.origin}/api/bots`, {
      headers: { cookie: 'habi_session=boom' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(upstreamFailure.status, 500);
    assert.deepEqual(await upstreamFailure.json(), { error: { code: 'internal' } });

    const gallery = await page('/bots', { cookie });
    assert.equal(gallery.response.status, 200);
    const galleryText = visibleText(gallery.html);
    assert.ok(galleryText.includes('Live Field Notes'));
    assert.ok(galleryText.includes('come from the Habi API'));
    assert.ok(galleryText.includes('Live'));
    assert.ok(!galleryText.includes('Four working assistants'));
    assert.ok(!galleryText.includes('local sample data'));

    const signedOut = await page('/bots');
    const signedOutText = visibleText(signedOut.html);
    assert.ok(signedOutText.includes('Sign in to see your Bots'));
    assert.ok(signedOut.html.includes('href="/login"'));
    assert.ok(!signedOutText.includes('Live Field Notes'));

    const failed = await page('/bots', { cookie: 'habi_session=boom' });
    const failedText = visibleText(failed.html);
    assert.ok(failedText.includes('The chat API is not reachable'));
    assert.ok(!failedText.includes('Live Field Notes'));
    assert.ok(!failedText.includes('local sample data'));

    const threads = await page('/threads', { cookie });
    const threadsText = visibleText(threads.html);
    assert.ok(threadsText.includes('Live thread about ordering'));
    assert.ok(threadsText.includes('Live Field Notes'));
    assert.ok(!threadsText.includes('Should the allowance pause or stop?'));

    const workspace = await page(`/bots/${BOT_ID}?thread=${THREAD_ID}`, { cookie });
    assert.equal(workspace.response.status, 200);
    const workspaceText = visibleText(workspace.html);
    assert.ok(workspaceText.includes('Live thread about ordering'));
    assert.ok(workspaceText.includes('First live question'));
    assert.ok(workspaceText.includes('First live reply.'));
    assert.ok(workspaceText.includes('Prefers short sections over bullet dumps.'));
    assert.ok(workspaceText.includes('Held'));
    assert.ok(!workspaceText.includes('Memory records are not exposed'));
    assert.ok(!workspaceText.includes('Run 4821'));
    assert.ok(!workspaceText.includes('stream-notes.md'));

    const documentPanel = await page(
      `/bots/${BOT_ID}?thread=${THREAD_ID}&panel=document`,
      { cookie },
    );
    assert.equal(documentPanel.response.status, 200);
    const documentText = visibleText(documentPanel.html);
    assert.ok(documentText.includes('live-notes.md'));
    assert.ok(documentText.includes('The stored paragraph mentions ordering.'));
    assert.ok(documentText.includes('Not stored on this server'));
    assert.ok(documentText.includes('not-stored.txt'));
    assert.ok(!documentText.includes('local sample data'));

    const unknown = await page('/bots/99999999-9999-4999-8999-999999999999', { cookie });
    assert.equal(unknown.response.status, 404);

    const combined = [
      gallery.html,
      signedOut.html,
      failed.html,
      threads.html,
      workspace.html,
      documentPanel.html,
      unknown.html,
    ].join('\n');

    for (const forbidden of [
      upstreamOrigin,
      `127.0.0.1:${upstreamPort}`,
      'HABI_API_URL',
      `habi_session=${SESSION}`,
      'Local sample data',
      'stream-notes.md',
      'api.openai.com',
    ]) {
      assert.ok(!combined.includes(forbidden), `live HTML leaked or invented: ${forbidden}`);
    }
  } finally {
    await app.stop();
    await new Promise((resolve) => stub.server.close(resolve));
  }
});

test('with no HABI_API_URL the sample preview renders and the proxy refuses', { timeout: 60_000 }, async () => {
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  delete env.HABI_API_URL;

  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once('close', resolve));

  try {
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 25_000;
    let ready = false;

    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, `Next exited before readiness:\n${output}`);

      try {
        const response = await fetch(`${origin}/bots`, {
          signal: AbortSignal.timeout(1500),
        });
        ready = response.status === 200;
        if (ready) break;
      } catch {
        // Keep waiting for the server to bind.
      }

      await delay(150);
    }

    assert.ok(ready, `Next did not become ready:\n${output}`);

    const gallery = await fetch(`${origin}/bots`);
    assert.equal(gallery.status, 200);
    const text = visibleText(await gallery.text());
    assert.ok(text.includes('Four working assistants'));
    assert.ok(text.includes('local sample data'));
    assert.ok(text.includes('Field Notes'));
    assert.ok(!text.includes('Live Field Notes'));

    const proxy = await fetch(`${origin}/api/bots`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(proxy.status, 503);
    assert.deepEqual(await proxy.json(), { error: { code: 'api_unavailable' } });

    const artifactProxy = await fetch(`${origin}/api/artifacts`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(artifactProxy.status, 503);
    assert.deepEqual(await artifactProxy.json(), { error: { code: 'api_unavailable' } });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
    clearTimeout(timer);
    if (!stopped) {
      child.kill('SIGKILL');
      await exited;
      assert.fail(`Next did not stop after SIGTERM:\n${output}`);
    }
  }
});
