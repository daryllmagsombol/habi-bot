/**
 * H-017 (#17) session contract slice. Spike-only, not product authentication.
 *
 * Exercises the in-process session service and routes behind
 * HABI_SESSION_SPIKE=1: fixation, CSRF, rotation and reuse detection, idle and
 * absolute expiry, logout/logout-all, cross-user isolation, cookie attributes,
 * and absence of the routes when the flag is unset.
 *
 * The service half runs against the built module directly with an injected
 * clock; the route half runs the built app in a child process, mirroring
 * spike-isolation.smoke.mjs. Expiry at HTTP level uses the test-only clock
 * header, which is honoured only when HABI_SESSION_SPIKE_TEST_CLOCK=1.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const FIXTURE_A = 'session-fixture-a';
const FIXTURE_B = 'session-fixture-b';
const IDLE_TTL_MS = 30 * 60 * 1000;
const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const CSRF_INVALID = { error: { code: 'csrf_invalid' } };
const SESSION_COOKIE_NAMES = new Set(['habi_session', '__Host-habi_session']);
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const {
  SessionService,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} = await import('../dist/session/session.service.js');

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
    // The process is already being torn down; nothing else to clean up.
  }
}

async function startApi(envOverrides = {}) {
  const port = await getFreePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'test',
  };

  // The parent environment must not decide which spike surfaces are enabled.
  for (const name of [
    'HABI_SPIKE_MODE',
    'HABI_SESSION_SPIKE',
    'HABI_SESSION_SPIKE_TEST_CLOCK',
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

function readSetCookie(state, setCookies) {
  for (const setCookie of setCookies) {
    const [pair = '', ...attributes] = setCookie.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');

    if (separator === -1) {
      continue;
    }

    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);

    if (!SESSION_COOKIE_NAMES.has(name)) {
      continue;
    }

    const maxAge = attributes
      .map((attribute) => attribute.toLowerCase())
      .find((attribute) => attribute.startsWith('max-age='));

    if (value === '' || maxAge === 'max-age=0') {
      state.cookie = undefined;
      state.csrfToken = undefined;
      continue;
    }

    state.cookie = `${name}=${value}`;
  }
}

/**
 * Minimal browser: holds the session cookie and CSRF token in memory only,
 * exactly as the web app must (never localStorage).
 */
function createBrowser(base) {
  const state = { cookie: undefined, csrfToken: undefined };

  async function request(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    const cookie =
      options.rawCookie ?? (options.useCookie === false ? undefined : state.cookie);

    if (cookie !== undefined) {
      headers.cookie = cookie;
    }

    if (options.csrf === 'valid' && state.csrfToken !== undefined) {
      headers['x-csrf-token'] = state.csrfToken;
    } else if (options.csrf === 'wrong') {
      headers['x-csrf-token'] = 'wrong-csrf-token';
    } else if (options.csrf === 'foreign') {
      headers['x-csrf-token'] = options.foreignToken ?? '';
    }

    if (options.fixtureToken !== undefined) {
      headers.authorization = `Bearer ${options.fixtureToken}`;
    }

    if (options.offsetMs !== undefined) {
      headers['x-session-spike-now-offset-ms'] = String(options.offsetMs);
    }

    if (options.userAgent !== undefined) {
      headers['user-agent'] = options.userAgent;
    }

    if (options.origin !== undefined) {
      headers.origin = options.origin;
    }

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5000),
    });
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const csrfHeader = response.headers.get('x-csrf-token');

    if (csrfHeader !== null) {
      state.csrfToken = csrfHeader;
    }

    readSetCookie(state, setCookies);

    return {
      status: response.status,
      headers: response.headers,
      setCookies,
      body: await readBody(response),
    };
  }

  return { state, request };
}

async function login(browser, fixtureToken = FIXTURE_A, options = {}) {
  const response = await browser.request('/session-spike/login', {
    method: 'POST',
    fixtureToken,
    ...options,
  });

  assert.equal(response.status, 200);
  const headerToken = response.headers.get('x-csrf-token');
  assert.equal(typeof headerToken, 'string');
  assert.equal(response.body.csrfToken, headerToken);
  browser.state.csrfToken = headerToken;

  return response;
}

function sessionCookieValue(browser) {
  const cookie = browser.state.cookie;
  assert.equal(typeof cookie, 'string');
  return cookie.slice(cookie.indexOf('=') + 1);
}

function findSessionCookie(setCookies) {
  return setCookies.find((setCookie) =>
    [...SESSION_COOKIE_NAMES].some((name) => setCookie.startsWith(`${name}=`)),
  );
}

describe('session service contract with an injected clock', () => {
  test('mints distinct secrets and stores only a verifier plus coarse hashes', () => {
    const service = new SessionService({ now: () => 1_000 });
    const issued = service.create('user-a', {
      userAgent: 'Agent/1.0',
      ip: '203.0.113.7',
    });
    const serialized = JSON.stringify(issued.record);

    assert.match(issued.sessionId, SECRET_PATTERN);
    assert.match(issued.csrfToken, SECRET_PATTERN);
    assert.notEqual(issued.sessionId, issued.csrfToken);
    assert.equal(serialized.includes(issued.sessionId), false);
    assert.equal(serialized.includes('Agent/1.0'), false);
    assert.equal(serialized.includes('203.0.113.7'), false);
    assert.match(issued.record.userAgentHash, /^[0-9a-f]{64}$/);
    assert.match(issued.record.ipHash, /^[0-9a-f]{64}$/);
    assert.equal(issued.record.createdAt, 1_000);
    assert.equal(issued.record.lastSeenAt, 1_000);
    assert.equal(issued.record.idleExpiresAt, 1_000 + SESSION_IDLE_TTL_MS);
    assert.equal(issued.record.absoluteExpiresAt, 1_000 + SESSION_ABSOLUTE_TTL_MS);
    assert.equal(issued.record.rotatedFrom, null);
    assert.equal(issued.record.revokedAt, null);
  });

  test('unknown and malformed secrets fail uniformly', () => {
    const service = new SessionService({ now: () => 0 });
    const unknown = service.validate('A'.repeat(43), 1);
    const malformed = service.validate('not-a-session-secret', 1);

    assert.deepEqual(unknown, { ok: false, reason: 'unauthenticated' });
    assert.deepEqual(malformed, { ok: false, reason: 'unauthenticated' });
  });

  test('rotation keeps family lineage, inherits absolute expiry, and is single use', () => {
    let clock = 1_000;
    const service = new SessionService({ now: () => clock });
    const first = service.create('user-a');
    clock = 5_000;

    const rotated = service.rotate(first.sessionId);
    assert.ok(rotated);
    assert.notEqual(rotated.sessionId, first.sessionId);
    assert.notEqual(rotated.csrfToken, first.csrfToken);
    assert.equal(rotated.record.familyId, first.record.familyId);
    assert.equal(rotated.record.rotatedFrom, first.record.recordId);
    assert.equal(rotated.record.absoluteExpiresAt, first.record.absoluteExpiresAt);
    assert.equal(first.record.revokedReason, 'rotated');

    const replay = service.validate(first.sessionId);
    assert.deepEqual(replay, { ok: false, reason: 'unauthenticated' });
    assert.equal(rotated.record.revokedReason, 'reuse_detected');
    assert.equal(service.validate(rotated.sessionId).ok, false);
  });

  test('idle expiry slides while absolute expiry never extends', () => {
    let clock = 0;
    const service = new SessionService({ now: () => clock });
    const sliding = service.create('user-a');

    clock = SESSION_IDLE_TTL_MS - 1;
    assert.equal(service.validate(sliding.sessionId).ok, true);
    clock = SESSION_IDLE_TTL_MS + 19 * 60 * 1000;
    assert.equal(service.validate(sliding.sessionId).ok, true);
    clock = SESSION_IDLE_TTL_MS + 50 * 60 * 1000;
    assert.deepEqual(service.validate(sliding.sessionId), {
      ok: false,
      reason: 'unauthenticated',
    });

    clock = 0;
    const absolute = service.create('user-b');
    for (let at = 25 * 60 * 1000; at < SESSION_ABSOLUTE_TTL_MS; at += 25 * 60 * 1000) {
      clock = at;
      assert.equal(service.validate(absolute.sessionId).ok, true, `at ${at}`);
    }
    clock = SESSION_ABSOLUTE_TTL_MS;
    assert.deepEqual(service.validate(absolute.sessionId), {
      ok: false,
      reason: 'unauthenticated',
    });
    assert.equal(absolute.record.revokedReason, 'absolute_expired');
  });

  test('logout revokes one session; logout-all and family revocation are user/family scoped', () => {
    const service = new SessionService({ now: () => 0 });
    const a1 = service.create('user-a');
    const a2 = service.create('user-a');
    const b1 = service.create('user-b');

    assert.equal(service.revoke(a1.sessionId), true);
    assert.equal(service.validate(a1.sessionId).ok, false);
    assert.equal(service.validate(a2.sessionId).ok, true);
    assert.equal(service.listForUser('user-a').length, 1);

    assert.equal(service.revokeAllForUser('user-a'), 1);
    assert.equal(service.validate(a2.sessionId).ok, false);
    assert.equal(service.validate(b1.sessionId).ok, true);

    const b2 = service.create('user-b');
    assert.equal(service.revokeFamily(b2.record.familyId), 1);
    assert.equal(service.validate(b2.sessionId).ok, false);
    assert.equal(service.validate(b1.sessionId).ok, true);
  });
});

describe('session spike surface with HABI_SESSION_SPIKE=1', () => {
  let server;

  before(async () => {
    server = await startApi({
      HABI_SESSION_SPIKE: '1',
      HABI_SESSION_SPIKE_TEST_CLOCK: '1',
    });
  });

  after(async () => {
    if (server !== undefined) {
      await server.stop();
    }
  });

  test('login sets a hardened cookie and never returns the session id', async () => {
    const browser = createBrowser(server.base);
    const response = await login(browser);

    const setCookie = findSessionCookie(response.setCookies);
    assert.equal(typeof setCookie, 'string');
    assert.match(setCookie, /^habi_session=/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; SameSite=Lax/);
    assert.match(setCookie, /; Path=\//);
    assert.match(setCookie, /; Max-Age=43200/);
    assert.equal(setCookie.includes('Domain='), false);
    assert.equal(setCookie.includes('Secure'), false);

    assert.deepEqual(response.body.user, { userId: 'user-a' });
    assert.equal(typeof response.body.csrfToken, 'string');
    assert.match(response.body.csrfToken, SECRET_PATTERN);
    assert.match(response.body.session.sessionRef, /^sess_[0-9a-f-]{36}$/);
    assert.equal(response.body.session.current, true);
    assert.equal('sessionId' in response.body, false);
    assert.equal('csrfToken' in response.body.session, false);

    const sessionSecret = sessionCookieValue(browser);
    assert.equal(JSON.stringify(response.body).includes(sessionSecret), false);
  });

  test('login always mints a new id, so a supplied session cannot be fixed', async () => {
    const browser = createBrowser(server.base);
    await login(browser);
    const firstCookie = browser.state.cookie;
    const firstCsrf = browser.state.csrfToken;
    const firstRef = (await browser.request('/session-spike/me')).body.session.sessionRef;

    await login(browser);
    const secondCookie = browser.state.cookie;
    const secondRef = (await browser.request('/session-spike/me')).body.session.sessionRef;

    assert.notEqual(secondCookie, firstCookie);
    assert.notEqual(browser.state.csrfToken, firstCsrf);
    assert.notEqual(secondRef, firstRef);

    // The browser's existing record is not adopted, but it is also not
    // destroyed by an unrelated login: both belong to user-a independently.
    const firstStillValid = await browser.request('/session-spike/me', {
      rawCookie: firstCookie,
    });
    assert.equal(firstStillValid.status, 200);
  });

  test('missing, unknown, and malformed cookies share one 401 shape', async () => {
    const browser = createBrowser(server.base);

    for (const [path, method] of [
      ['/session-spike/me', 'GET'],
      ['/session-spike/csrf', 'GET'],
      ['/session-spike/sessions', 'GET'],
      ['/session-spike/rotate', 'POST'],
      ['/session-spike/logout', 'POST'],
      ['/session-spike/logout-all', 'POST'],
    ]) {
      const anonymous = await browser.request(path, { method, csrf: 'valid' });
      assert.equal(anonymous.status, 401, `${method} ${path}`);
      assert.deepEqual(anonymous.body, UNAUTHENTICATED, `${method} ${path}`);
    }

    for (const rawCookie of [
      `habi_session=${'A'.repeat(43)}`,
      'habi_session=short',
      'habi_session=',
      'other=value',
    ]) {
      const response = await browser.request('/session-spike/me', { rawCookie });
      assert.equal(response.status, 401, rawCookie);
      assert.deepEqual(response.body, UNAUTHENTICATED, rawCookie);
    }

    const noCookie = await browser.request('/session-spike/me', { useCookie: false });
    assert.deepEqual(noCookie.body, UNAUTHENTICATED);
  });

  test('csrf endpoint requires a session and returns the bound token', async () => {
    const browser = createBrowser(server.base);
    await login(browser);

    const response = await browser.request('/session-spike/csrf');
    assert.equal(response.status, 200);
    assert.equal(response.body.csrfToken, browser.state.csrfToken);
    assert.equal(response.headers.get('x-csrf-token'), browser.state.csrfToken);
  });

  test('state-changing routes reject missing, wrong, and foreign CSRF tokens', async () => {
    const browserA = createBrowser(server.base);
    const browserB = createBrowser(server.base);
    await login(browserA, FIXTURE_A);
    await login(browserB, FIXTURE_B);

    for (const csrf of ['none', 'wrong']) {
      for (const path of [
        '/session-spike/rotate',
        '/session-spike/logout',
        '/session-spike/logout-all',
      ]) {
        const response = await browserA.request(path, {
          method: 'POST',
          csrf: csrf === 'none' ? undefined : csrf,
        });

        assert.equal(response.status, 403, `${path} (${csrf})`);
        assert.deepEqual(response.body, CSRF_INVALID, `${path} (${csrf})`);
      }
    }

    // A token minted for another session is not accepted.
    const foreign = await browserA.request('/session-spike/rotate', {
      method: 'POST',
      csrf: 'foreign',
      foreignToken: browserB.state.csrfToken,
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(foreign.body, CSRF_INVALID);

    // A mismatched Origin/Referer is a second-control failure.
    const badOrigin = await browserA.request('/session-spike/rotate', {
      method: 'POST',
      csrf: 'valid',
      origin: 'https://evil.example',
    });
    assert.equal(badOrigin.status, 403);
    assert.deepEqual(badOrigin.body, CSRF_INVALID);

    // The matching token and origin are accepted.
    const accepted = await browserA.request('/session-spike/rotate', {
      method: 'POST',
      csrf: 'valid',
      origin: server.base,
    });
    assert.equal(accepted.status, 200);
    assert.notEqual(accepted.headers.get('x-csrf-token'), browserB.state.csrfToken);
  });

  test('rotation invalidates the old cookie and reuse revokes the whole family', async () => {
    const browser = createBrowser(server.base);
    await login(browser);
    const oldCookie = browser.state.cookie;
    const oldCsrf = browser.state.csrfToken;

    const rotated = await browser.request('/session-spike/rotate', {
      method: 'POST',
      csrf: 'valid',
    });
    assert.equal(rotated.status, 200);
    assert.notEqual(browser.state.cookie, oldCookie);
    assert.notEqual(browser.state.csrfToken, oldCsrf);

    const newCookie = browser.state.cookie;

    // The old CSRF token is no longer bound to the new session row.
    const staleCsrf = await browser.request('/session-spike/logout', {
      method: 'POST',
      csrf: 'foreign',
      foreignToken: oldCsrf,
    });
    assert.equal(staleCsrf.status, 403);
    assert.deepEqual(staleCsrf.body, CSRF_INVALID);

    const newSessionWorks = await browser.request('/session-spike/me');
    assert.equal(newSessionWorks.status, 200);

    // Replaying the retired secret is reuse: 401 and the family is revoked.
    const replay = await browser.request('/session-spike/me', { rawCookie: oldCookie });
    assert.equal(replay.status, 401);
    assert.deepEqual(replay.body, UNAUTHENTICATED);

    const afterReuse = await browser.request('/session-spike/me', { rawCookie: newCookie });
    assert.equal(afterReuse.status, 401);
    assert.deepEqual(afterReuse.body, UNAUTHENTICATED);
  });

  test('idle expiry is sliding and revokes the session', async () => {
    const browser = createBrowser(server.base);
    await login(browser);

    const withinIdle = await browser.request('/session-spike/me', {
      offsetMs: IDLE_TTL_MS - 2 * 60 * 1000,
    });
    assert.equal(withinIdle.status, 200);

    const stillAlive = await browser.request('/session-spike/me', {
      offsetMs: IDLE_TTL_MS + 10 * 60 * 1000,
    });
    assert.equal(stillAlive.status, 200);

    const idleExpired = await browser.request('/session-spike/me', {
      offsetMs: IDLE_TTL_MS + 41 * 60 * 1000,
    });
    assert.equal(idleExpired.status, 401);
    assert.deepEqual(idleExpired.body, UNAUTHENTICATED);

    const revoked = await browser.request('/session-spike/me');
    assert.equal(revoked.status, 401);
    assert.deepEqual(revoked.body, UNAUTHENTICATED);
  });

  test('absolute expiry is fixed even with continuous activity', async () => {
    const browser = createBrowser(server.base);
    await login(browser);

    // Keep the idle window sliding in sub-30-minute steps up to the absolute
    // boundary; every request stays valid.
    for (let minutes = 25; minutes <= 700; minutes += 25) {
      const response = await browser.request('/session-spike/sessions', {
        offsetMs: minutes * 60 * 1000,
      });

      assert.equal(response.status, 200, `offset ${minutes}m`);
    }

    const nearBoundary = await browser.request('/session-spike/me', {
      offsetMs: 705 * 60 * 1000,
    });
    assert.equal(nearBoundary.status, 200);

    // 721 minutes is past the fixed 12-hour absolute expiry, while the idle
    // window (last seen 705 + 30 minutes) would still allow the session.
    const expired = await browser.request('/session-spike/me', {
      offsetMs: ABSOLUTE_TTL_MS + 60 * 1000,
    });
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.body, UNAUTHENTICATED);
  });

  test('logout revokes only the presented session and clears the cookie', async () => {
    const browser = createBrowser(server.base);
    await login(browser);
    const revokedCookie = browser.state.cookie;

    const loggedOut = await browser.request('/session-spike/logout', {
      method: 'POST',
      csrf: 'valid',
    });
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(loggedOut.body, { ok: true });
    assert.equal(browser.state.cookie, undefined);
    assert.match(findSessionCookie(loggedOut.setCookies) ?? '', /Max-Age=0/);
    assert.match(findSessionCookie(loggedOut.setCookies) ?? '', /HttpOnly/);

    const after = await browser.request('/session-spike/me', { rawCookie: revokedCookie });
    assert.equal(after.status, 401);
    assert.deepEqual(after.body, UNAUTHENTICATED);
  });

  test('logout-all revokes every device for that user only', async () => {
    const firstDevice = createBrowser(server.base);
    const secondDevice = createBrowser(server.base);
    const otherUser = createBrowser(server.base);
    await login(firstDevice, FIXTURE_A);
    await login(secondDevice, FIXTURE_A);
    await login(otherUser, FIXTURE_B);

    const otherCookie = otherUser.state.cookie;
    const loggedOut = await firstDevice.request('/session-spike/logout-all', {
      method: 'POST',
      csrf: 'valid',
    });

    assert.equal(loggedOut.status, 200);
    assert.equal(loggedOut.body.ok, true);
    assert.ok(loggedOut.body.revoked >= 2);

    for (const browser of [firstDevice, secondDevice]) {
      const response = await browser.request('/session-spike/me');
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, UNAUTHENTICATED);
    }

    const otherStillValid = await otherUser.request('/session-spike/me', {
      rawCookie: otherCookie,
    });
    assert.equal(otherStillValid.status, 200);
    assert.equal(otherStillValid.body.user.userId, 'user-b');
  });

  test('session lists are self-scoped and cross-user actions do not leak', async () => {
    const browserA = createBrowser(server.base);
    const browserB = createBrowser(server.base);
    await login(browserA, FIXTURE_A);
    await login(browserB, FIXTURE_B);

    const listA = await browserA.request('/session-spike/sessions');
    const listB = await browserB.request('/session-spike/sessions');
    assert.equal(listA.status, 200);
    assert.equal(listB.status, 200);

    assert.ok(listA.body.sessions.some((session) => session.current === true));
    assert.ok(listB.body.sessions.some((session) => session.current === true));
    for (const session of listA.body.sessions) {
      assert.equal(session.userId, 'user-a');
    }
    for (const session of listB.body.sessions) {
      assert.equal(session.userId, 'user-b');
    }

    const refsA = new Set(listA.body.sessions.map((session) => session.sessionRef));
    assert.equal(
      listB.body.sessions.some((session) => refsA.has(session.sessionRef)),
      false,
    );

    // B's rotation and logout-all act only on B, never on A.
    const rotateB = await browserB.request('/session-spike/rotate', {
      method: 'POST',
      csrf: 'valid',
    });
    assert.equal(rotateB.status, 200);
    const logoutAllB = await browserB.request('/session-spike/logout-all', {
      method: 'POST',
      csrf: 'valid',
    });
    assert.equal(logoutAllB.status, 200);

    const aStillValid = await browserA.request('/session-spike/me');
    assert.equal(aStillValid.status, 200);
    assert.equal(aStillValid.body.user.userId, 'user-a');

    // B cannot mint an A identity by sending A's fixture or A's cookie: the
    // cookie decides, and authentication never reads a client user id header.
    const spoofed = await browserB.request('/session-spike/me', {
      useCookie: false,
      headers: { 'x-user-id': 'user-a', 'x-spike-user-id': 'user-a' },
    });
    assert.equal(spoofed.status, 401);
    assert.deepEqual(spoofed.body, UNAUTHENTICATED);
  });

  test('raw user agent and IP never appear in bodies or process output', async () => {
    const browser = createBrowser(server.base);
    const userAgent = 'SessionSmokeAgent/1.0 (contract-test)';
    const response = await login(browser, FIXTURE_A, { userAgent });

    const list = await browser.request('/session-spike/sessions');
    const serialized = `${JSON.stringify(response.body)}\n${JSON.stringify(list.body)}`;

    assert.equal(serialized.includes(userAgent), false);
    assert.equal(serialized.includes('127.0.0.1'), false);
    assert.equal(serialized.includes('::1'), false);
    assert.equal(serialized.includes(sessionCookieValue(browser)), false);

    const output = `${server.output.stdout}\n${server.output.stderr}`;
    assert.equal(output.includes(userAgent), false);
    assert.equal(output.includes(sessionCookieValue(browser)), false);
    assert.equal(output.includes(browser.state.csrfToken), false);
  });
});

describe('session spike clock affordance', () => {
  let server;

  before(async () => {
    server = await startApi({ HABI_SESSION_SPIKE: '1' });
  });

  after(async () => {
    if (server !== undefined) {
      await server.stop();
    }
  });

  test('the offset header is ignored unless HABI_SESSION_SPIKE_TEST_CLOCK=1', async () => {
    const browser = createBrowser(server.base);
    await login(browser);

    const shifted = await browser.request('/session-spike/me', {
      offsetMs: ABSOLUTE_TTL_MS + 60 * 1000,
    });

    assert.equal(shifted.status, 200);
  });
});

describe('production cookie attributes', () => {
  let server;

  before(async () => {
    server = await startApi({
      HABI_SESSION_SPIKE: '1',
      NODE_ENV: 'production',
    });
  });

  after(async () => {
    if (server !== undefined) {
      await server.stop();
    }
  });

  test('production uses the __Host- prefix and marks the cookie Secure', async () => {
    const browser = createBrowser(server.base);
    const response = await login(browser);

    const setCookie = findSessionCookie(response.setCookies);
    assert.equal(typeof setCookie, 'string');
    assert.match(setCookie, /^__Host-habi_session=/);
    assert.match(setCookie, /; Secure/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; SameSite=Lax/);
    assert.match(setCookie, /; Path=\//);
    assert.equal(setCookie.includes('Domain='), false);

    const me = await browser.request('/session-spike/me');
    assert.equal(me.status, 200);
  });
});

describe('session spike surface without HABI_SESSION_SPIKE', () => {
  let server;

  before(async () => {
    server = await startApi({ HABI_SPIKE_MODE: '1' });
  });

  after(async () => {
    if (server !== undefined) {
      await server.stop();
    }
  });

  test('session routes are absent; health and the ownership spike are unchanged', async () => {
    const browser = createBrowser(server.base);

    for (const [path, method] of [
      ['/session-spike/login', 'POST'],
      ['/session-spike/me', 'GET'],
      ['/session-spike/csrf', 'GET'],
      ['/session-spike/rotate', 'POST'],
      ['/session-spike/logout', 'POST'],
      ['/session-spike/logout-all', 'POST'],
      ['/session-spike/sessions', 'GET'],
    ]) {
      const response = await browser.request(path, { method, fixtureToken: FIXTURE_A });
      assert.equal(response.status, 404, `${method} ${path}`);
    }

    for (const [path, method] of [
      ['/session-spike/login/', 'POST'],
    ]) {
      const response = await browser.request(path, { method, fixtureToken: FIXTURE_A });
      assert.equal(response.status, 404, `${method} ${path}`);
    }

    const health = await browser.request('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok', service: 'api' });

    const spike = await browser.request('/spike/runs', {
      headers: { authorization: 'Bearer spike-token-a' },
    });
    assert.equal(spike.status, 200);
  });
});
