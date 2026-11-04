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
    assert.ok(workspaceText.includes('Memory records are not exposed by this API yet'));
    assert.ok(!workspaceText.includes('Run 4821'));
    assert.ok(!workspaceText.includes('stream-notes.md'));

    const unknown = await page('/bots/99999999-9999-4999-8999-999999999999', { cookie });
    assert.equal(unknown.response.status, 404);

    const combined = [
      gallery.html,
      signedOut.html,
      failed.html,
      threads.html,
      workspace.html,
      unknown.html,
    ].join('\n');

    for (const forbidden of [
      upstreamOrigin,
      `127.0.0.1:${upstreamPort}`,
      'HABI_API_URL',
      `habi_session=${SESSION}`,
      'Local sample data',
      'stream-notes.md',
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
