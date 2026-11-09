/**
 * Account surface smoke: the export and deletion page plus their BFF routes.
 *
 * A stub HTTP server stands in for the Nest API. The built Next app is started
 * twice: without `HABI_API_URL` (honest preview, both actions disabled) and with
 * it (live account page, export download, delete forwarding).
 *
 * These are server-rendered assertions. The typed-confirmation match is
 * client-side, so the live document only proves the initial disabled state and
 * the expected email; the two-step interaction itself needs a browser.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { createRequire, registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../', import.meta.url));

// The client module is TypeScript with bundler-style extensionless imports.
// Node can strip the types, so the only missing piece is that resolution.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }

      throw error;
    }
  },
});

const SESSION = 'session-test-secret';
const CSRF = 'csrf-test-token';
const EMAIL = 'owner@example.test';
const NOW = '2026-11-09T06:00:00.000Z';
const DISCLOSURE =
  "A copy of this account's data survives in age-encrypted backups created before this deletion until those archives age out under the 7 daily / 4 weekly / 6 monthly retention policy — up to 184 days. Nothing is purged from an existing archive.";

function json(response, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
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

/** Distinguishes the `disabled` attribute from Tailwind's `disabled:` classes. */
function hasDisabledAttribute(tag) {
  return /(?:^|\s)disabled(?:="")?(?=\s|\/?>)/.test(tag);
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
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env },
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

      if (request.method === 'GET' && request.url === '/api/account') {
        json(response, 200, {
          account: {
            userId: 'user-1',
            email: EMAIL,
            status: 'active',
            createdAt: NOW,
            updatedAt: NOW,
            emailVerifiedAt: NOW,
          },
        });
        return;
      }

      if (request.method === 'GET' && request.url === '/api/account/export') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="habi-account-export-2026-11-09.json"',
        });
        response.end(
          JSON.stringify({
            manifest: {
              schemaVersion: 1,
              exportedAt: NOW,
              accountId: 'user-1',
              counts: { bots: 1, messages: 2 },
              excluded: ['password hashes and credential material'],
            },
            profile: { userId: 'user-1', email: EMAIL },
          }),
        );
        return;
      }

      if (request.method === 'DELETE' && request.url === '/api/account') {
        if (request.headers['x-csrf-token'] !== CSRF) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        let parsed;

        try {
          parsed = JSON.parse(body);
        } catch {
          json(response, 400, { error: { code: 'invalid_input' } });
          return;
        }

        if (typeof parsed.confirm !== 'string' || parsed.confirm !== EMAIL) {
          json(response, 400, { error: { code: 'invalid_input' } });
          return;
        }

        json(response, 200, {
          deleted: true,
          accountId: 'user-1',
          deletedAt: NOW,
          alreadyDeleted: false,
          sessionsRevoked: 2,
          removed: {
            attachments: 1,
            attachmentText: 1,
            memories: 2,
            memoryAudit: 2,
            artifacts: 1,
            artifactVersions: 1,
            messages: 4,
            skills: 1,
            skillVersions: 1,
            runs: 2,
            runEvents: 6,
            conversations: 1,
            bots: 2,
            usageBuckets: 1,
            usageReservations: 1,
            usageAudit: 0,
            ssoIdentities: 0,
            ssoPending: 0,
            passwordResetTokens: 0,
          },
          backupRetention: {
            encrypted: true,
            encryption: 'age',
            policy: '7 daily / 4 weekly / 6 monthly',
            maximumDays: 184,
            disclosure:
              'This removes the account and its data from the live database. ' + DISCLOSURE,
          },
        });
        return;
      }

      json(response, 404, { error: { code: 'not_found' } });
    });
  });

  return { server, requests };
}

test('account preview and live surfaces stay honest and forward correctly', { timeout: 120_000 }, async () => {
  const preview = await bootNext({ HABI_API_URL: '' });

  try {
    const page = await fetch(`${preview.origin}/account`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    const text = visibleText(html);

    assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(html, /<h1[^>]*>Account<\/h1>/);
    assert.match(html, /aria-label="Workspace"/);
    assert.match(html, /href="\/account"/);

    for (const copy of [
      '7 daily / 4 weekly / 6 monthly retention policy',
      'up to 184 days',
      'Nothing is purged from an existing archive',
      'No API is configured on this server',
    ]) {
      assert.ok(text.includes(copy), `preview account page is missing: ${copy}`);
    }

    for (const copy of ['profile', 'ssoIdentities', 'runEvents', 'artifactVersions', 'search']) {
      assert.ok(text.includes(copy), `export contents are missing: ${copy}`);
    }

    for (const copy of ['CSRF tokens', 'SSO PKCE verifiers', 'storage keys', 'token hashes']) {
      assert.ok(text.includes(copy), `exclusions are missing: ${copy}`);
    }

    const previewExport = /<button[^>]*>\s*Download export/.exec(html);
    assert.ok(previewExport, 'the preview has no export button');
    assert.ok(hasDisabledAttribute(previewExport[0]), 'preview export is not disabled');

    const previewDelete = /<button[^>]*>\s*Delete account permanently/.exec(html);
    assert.ok(previewDelete, 'the preview has no delete button');
    assert.ok(hasDisabledAttribute(previewDelete[0]), 'preview delete is not disabled');
    assert.ok(!html.includes('HABI_API_URL'), 'the preview leaked a server configuration name');
  } finally {
    await preview.stop();
  }

  const stub = createStub();
  const upstreamPort = await listen(stub.server);
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
  const app = await bootNext({ HABI_API_URL: upstreamOrigin, HABI_AUTH_API_URL: '' });
  const cookie = `habi_session=${SESSION}; habi-theme=dark`;

  try {
    const page = await fetch(`${app.origin}/account`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    const text = visibleText(html);

    assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(html, /<h1[^>]*>Account<\/h1>/);
    assert.ok(text.includes(EMAIL), 'the account page did not show the account email');
    assert.ok(text.includes('up to 184 days'), 'the deletion disclosure is missing');
    assert.match(html, /aria-label="Workspace"/);
    assert.ok(!html.includes(upstreamOrigin), 'the backend origin leaked into the page HTML');

    assert.equal(
      stub.requests.find((entry) => entry.url === '/auth/me'),
      undefined,
      'the account page still reached the auth service instead of GET /api/account',
    );
    const accountRead = stub.requests.find(
      (entry) => entry.method === 'GET' && entry.url === '/api/account',
    );
    assert.ok(accountRead, 'the account page did not read GET /api/account');
    assert.equal(accountRead.headers.cookie, `habi_session=${SESSION}`);
    assert.equal(accountRead.headers.accept, 'application/json');

    const exportButton = /<button[^>]*>\s*Download export/.exec(html);
    assert.ok(exportButton, 'the live page has no export button');
    assert.ok(!hasDisabledAttribute(exportButton[0]), 'the live export button is disabled');

    const deleteButton = /<button[^>]*>\s*Delete account permanently/.exec(html);
    assert.ok(deleteButton, 'the live page has no delete button');
    assert.ok(hasDisabledAttribute(deleteButton[0]), 'delete is enabled before confirmation');
    assert.ok(
      /Type your account email to confirm/.test(text),
      'the typed-confirmation label is missing',
    );

    const exported = await fetch(`${app.origin}/api/account/export`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(
      exported.headers.get('content-disposition'),
      'attachment; filename="habi-account-export-2026-11-09.json"',
    );
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    assert.equal((await exported.json()).manifest.accountId, 'user-1');

    const exportForward = stub.requests.find(
      (entry) => entry.method === 'GET' && entry.url === '/api/account/export',
    );
    assert.ok(exportForward, 'the export route did not forward');
    assert.equal(exportForward.headers.cookie, `habi_session=${SESSION}`);
    assert.equal(exportForward.headers.origin, upstreamOrigin);

    const unauthenticatedExport = await fetch(`${app.origin}/api/account/export`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(unauthenticatedExport.status, 401);
    assert.deepEqual(await unauthenticatedExport.json(), {
      error: { code: 'unauthenticated' },
    });

    const deleted = await fetch(`${app.origin}/api/account`, {
      method: 'DELETE',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': CSRF,
      },
      body: JSON.stringify({ confirm: EMAIL }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deleted.status, 200);
    const deletedBody = await deleted.json();
    assert.equal(deletedBody.deleted, true);
    assert.equal(deletedBody.sessionsRevoked, 2);
    assert.equal(deletedBody.backupRetention.maximumDays, 184);

    const deleteForward = stub.requests.find(
      (entry) => entry.method === 'DELETE' && entry.url === '/api/account',
    );
    assert.ok(deleteForward, 'the delete route did not forward');
    assert.equal(deleteForward.headers['x-csrf-token'], CSRF);
    assert.equal(deleteForward.headers.origin, upstreamOrigin);
    assert.deepEqual(JSON.parse(deleteForward.body), { confirm: EMAIL });

    const wrongConfirmation = await fetch(`${app.origin}/api/account`, {
      method: 'DELETE',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': CSRF,
      },
      body: JSON.stringify({ confirm: 'someone@else.test' }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.deepEqual(await wrongConfirmation.json(), {
      error: { code: 'invalid_input' },
    });

    const noCsrf = await fetch(`${app.origin}/api/account`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: EMAIL }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(noCsrf.status, 403);
    assert.deepEqual(await noCsrf.json(), { error: { code: 'csrf_invalid' } });

    const before = stub.requests.length;
    const oversized = await fetch(`${app.origin}/api/account`, {
      method: 'DELETE',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': CSRF,
      },
      body: JSON.stringify({ confirm: 'a'.repeat(5000) }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: { code: 'invalid_input' } });
    assert.equal(stub.requests.length, before, 'an oversized body was forwarded upstream');
  } finally {
    await app.stop();
    await new Promise((resolve, reject) =>
      stub.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a failed account preflight blocks the export download', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const navigations = [];
  const calls = [];

  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method });
    return Response.json({ error: { code: 'unauthenticated' } }, { status: 401 });
  };
  globalThis.window = {
    location: {
      replace(url) {
        navigations.push(url);
      },
    },
  };

  try {
    const { downloadExport } = await import('../lib/api/account.ts');

    await assert.rejects(downloadExport, (error) => {
      assert.equal(error.name, 'ChatRequestError');
      assert.equal(error.code, 'unauthenticated');
      assert.equal(error.status, 401);
      return true;
    });

    assert.deepEqual(
      calls.map((call) => call.path),
      ['/api/account'],
      'only the cheap preflight should be requested',
    );
    assert.deepEqual(navigations, [], 'a failed preflight must never navigate to the export');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

test('account page without a session renders the sign-in state', { timeout: 120_000 }, async () => {
  const stub = createStub();
  const upstreamPort = await listen(stub.server);
  const app = await bootNext({ HABI_API_URL: `http://127.0.0.1:${upstreamPort}` });

  try {
    const page = await fetch(`${app.origin}/account`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(page.status, 200);
    const html = await page.text();

    assert.match(html, /<h1[^>]*>Sign in to manage your account<\/h1>/);
    assert.match(html, /href="\/login"/);
    assert.ok(visibleText(html).includes('No account is loaded without a session'));
    assert.ok(!html.includes(`http://127.0.0.1:${upstreamPort}`), 'the origin leaked');
  } finally {
    await app.stop();
    await new Promise((resolve, reject) =>
      stub.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
