/**
 * H-014 web smoke: the built identity pages render accessible forms and the
 * same-origin BFF rejects unknown actions.
 *
 * This is a server-rendered assertion, not a browser test. It deliberately
 * checks labels, input types, autocomplete hints, the live region, and the
 * absence of SSO controls or secret configuration in the page source.
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

function stripScriptsAndStyles(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

function visibleText(html) {
  return stripScriptsAndStyles(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

function assertField(html, id, type) {
  const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
  assert.ok(tag, `missing input #${id}`);
  assert.match(tag, new RegExp(`type="${type}"`), `input #${id} should be ${type}`);
  assert.match(html, new RegExp(`<label[^>]*for="${id}"`), `missing label for #${id}`);
  return tag;
}

test('built identity pages are accessible, mobile-first forms without SSO', { timeout: 60_000 }, async () => {
  const port = await availablePort();
  const upstreamRequests = [];
  const upstream = createHttpServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      upstreamRequests.push({
        url: request.url,
        method: request.method,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        csrf: request.headers['x-csrf-token'],
        contentType: request.headers['content-type'],
        body,
      });

      if (request.url === '/auth/login' && request.method === 'POST') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-csrf-token': 'csrf-proxy',
          'set-cookie': [
            'habi_session=proxy-session-secret; Path=/; HttpOnly; SameSite=Lax; Max-Age=600',
          ],
        });
        response.end(
          JSON.stringify({
            user: { userId: 'user-proxy', email: 'proxy@example.com' },
            csrfToken: 'csrf-proxy',
          }),
        );
        return;
      }

      if (request.url === '/auth/me' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ user: { userId: 'user-proxy', email: 'proxy@example.com' } }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'not_found' } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

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
        HABI_AUTH_API_URL: upstreamOrigin,
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

  async function page(path) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, `${path} returned ${response.status}`);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    return response.text();
  }

  try {
    const deadline = Date.now() + 25_000;
    let ready = false;

    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Next exited before readiness:\n${output}`);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/start`, {
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

    const start = await page('/start');
    const startText = visibleText(start);
    assert.match(start, /<html\b[^>]*lang="en"/i);
    assert.equal((start.match(/<h1\b/gi) ?? []).length, 1);
    assert.ok(startText.includes('Sign in to Habi.'));
    assert.ok(startText.includes('invite-only'));
    assert.match(start, /href="\/login"/);
    assert.match(start, /href="\/signup"/);
    assert.match(start, /href="\/recovery"/);
    assert.doesNotMatch(start, /<(?:input|textarea)\b/i);
    const startButtons = start.match(/<button\b[^>]*>/gi) ?? [];
    assert.ok(
      startButtons.every((tag) => /aria-label="Switch to (light|dark) theme"/.test(tag)),
      'only the theme toggle may be a button on the identity entry page',
    );

    const login = await page('/login');
    assert.equal((login.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(login, /<form\b[^>]*>/i);
    const loginEmail = assertField(login, 'login-email', 'email');
    assert.match(loginEmail, /autocomplete="username"/i);
    assert.match(loginEmail, /\brequired\b/);
    const loginPassword = assertField(login, 'login-password', 'password');
    assert.match(loginPassword, /autocomplete="current-password"/i);
    assert.match(login, /aria-live="polite"/);
    assert.match(login, /<button[^>]*type="submit"/i);
    assert.match(login, /href="\/signup"/);
    assert.match(login, /href="\/recovery"/);

    const signup = await page('/signup');
    assert.equal((signup.match(/<h1\b/gi) ?? []).length, 1);
    const signupEmail = assertField(signup, 'signup-email', 'email');
    assert.match(signupEmail, /autocomplete="username"/i);
    const signupPassword = assertField(signup, 'signup-password', 'password');
    assert.match(signupPassword, /autocomplete="new-password"/i);
    assert.match(signupPassword, /minlength="12"/i);
    assert.match(signupPassword, /aria-describedby="signup-password-hint"/);
    assert.match(signup, /id="signup-password-hint"/);
    const invite = assertField(signup, 'signup-invite', 'text');
    assert.match(invite, /autocomplete="off"/i);
    assert.match(signup, /aria-live="polite"/);
    assert.match(signup, /href="\/login"/);

    const recovery = await page('/recovery');
    assert.equal((recovery.match(/<h1\b/gi) ?? []).length, 1);
    assertField(recovery, 'recovery-email', 'email');
    assert.doesNotMatch(recovery, /type="password"/i);
    assert.match(recovery, /aria-live="polite"/);
    assert.match(recovery, /href="\/login"/);

    const joined = `${start}\n${login}\n${signup}\n${recovery}`;
    for (const forbidden of [
      'Continue with Google',
      'Continue with Microsoft',
      'Continue with Facebook',
      'HABI_AUTH_API_URL',
      'DATABASE_URL',
      'password_hash',
      'sessionStorage',
    ]) {
      assert.ok(!joined.includes(forbidden), `identity pages leaked or added: ${forbidden}`);
    }

    // Browser storage on these pages may only hold the theme preference. No
    // credential, session, or form value is ever written to localStorage.
    const storageCalls = joined.match(/localStorage\.[a-zA-Z]+\([^)]*\)/g) ?? [];
    assert.ok(storageCalls.length > 0, 'the pre-paint theme script should be present');
    assert.ok(
      storageCalls.every((call) => call === "localStorage.getItem('habi-theme')"),
      `identity pages may only read the theme preference: ${storageCalls.join(', ')}`,
    );

    const forwardedBeforeUnknown = upstreamRequests.length;

    const unknownAction = await fetch(
      `http://127.0.0.1:${port}/api/auth/not-a-real-action`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(unknownAction.status, 404);
    assert.deepEqual(await unknownAction.json(), { error: { code: 'not_found' } });
    assert.equal(
      upstreamRequests.length,
      forwardedBeforeUnknown,
      'unknown actions must not reach the auth API',
    );

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(wrongMethod.status, 405);
    assert.deepEqual(await wrongMethod.json(), { error: { code: 'method_not_allowed' } });

    const loginProxy = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'proxy@example.com', password: 'x'.repeat(12) }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(loginProxy.status, 200);
    assert.deepEqual(await loginProxy.json(), {
      user: { userId: 'user-proxy', email: 'proxy@example.com' },
      csrfToken: 'csrf-proxy',
    });
    assert.equal(loginProxy.headers.get('x-csrf-token'), 'csrf-proxy');
    const relayedCookie = loginProxy.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('habi_session='));
    assert.ok(relayedCookie, 'the BFF did not relay Set-Cookie');
    assert.match(relayedCookie, /HttpOnly/);

    // The chat surface has to echo the token on same-origin writes, so the BFF
    // publishes it in a readable cookie. The session cookie above stays
    // HttpOnly; only this one is script-readable, and it is SameSite-scoped.
    const csrfCookie = loginProxy.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('habi_csrf='));
    assert.ok(csrfCookie, 'the BFF did not publish the CSRF cookie');
    assert.match(csrfCookie, /^habi_csrf=csrf-proxy/);
    assert.match(csrfCookie, /SameSite=Lax/);
    assert.match(csrfCookie, /Path=\//);
    assert.ok(!/HttpOnly/i.test(csrfCookie), 'the CSRF cookie must be script-readable');

    const loginForward = upstreamRequests.find(
      (entry) => entry.url === '/auth/login' && entry.method === 'POST',
    );
    assert.ok(loginForward, 'the BFF did not forward login');
    assert.equal(loginForward.origin, upstreamOrigin);
    assert.equal(loginForward.contentType, 'application/json');
    assert.deepEqual(JSON.parse(loginForward.body), {
      email: 'proxy@example.com',
      password: 'x'.repeat(12),
    });

    const meProxy = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { cookie: 'habi_session=proxy-session-secret' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(meProxy.status, 200);
    assert.deepEqual(await meProxy.json(), {
      user: { userId: 'user-proxy', email: 'proxy@example.com' },
    });

    const meForward = upstreamRequests.find(
      (entry) => entry.url === '/auth/me' && entry.method === 'GET',
    );
    assert.ok(meForward, 'the BFF did not forward the session cookie');
    assert.equal(meForward.cookie, 'habi_session=proxy-session-secret');
    assert.equal(meForward.origin, upstreamOrigin);
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

    await new Promise((resolve) => upstream.close(resolve));
  }
});
