/**
 * Spike-only. Not product code. Enabled only when HABI_SPIKE_MODE=1.
 *
 * Proves the two-user ownership boundary and no-tool policy denial of the
 * spike surface, and that the surface is absent when the flag is unset.
 * Runs the built app (dist) in a child process, mirroring health.smoke.mjs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const TOKEN_A = 'spike-token-a';
const TOKEN_B = 'spike-token-b';
const NOT_FOUND = { error: { code: 'not_found' } };

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

  // The parent environment must not decide whether the spike is enabled.
  delete env.HABI_SPIKE_MODE;

  if (envOverrides.HABI_SPIKE_MODE !== undefined) {
    env.HABI_SPIKE_MODE = envOverrides.HABI_SPIKE_MODE;
  }

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

function createClient(base, token) {
  return async function request(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };

    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }

    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(5000),
    });

    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  };
}

async function createRun(request, conversationId) {
  const response = await request('/spike/runs', {
    method: 'POST',
    body: conversationId === undefined ? {} : { conversationId },
  });

  assert.equal(response.status, 201);
  assert.match(response.body.runId, /^run_[0-9a-f-]{36}$/);
  assert.equal(response.body.status, 'created');
  assert.equal(typeof response.body.createdAt, 'string');

  const harnessRunId = response.headers.get('x-spike-harness-run-id');

  assert.match(harnessRunId ?? '', /^harness_[0-9a-f-]{36}$/);
  assert.notEqual(harnessRunId, response.body.runId);

  if (conversationId !== undefined) {
    assert.equal(response.body.conversationId, conversationId);
  } else {
    assert.match(response.body.conversationId, /^conv_[0-9a-f-]{36}$/);
  }

  return {
    runId: response.body.runId,
    conversationId: response.body.conversationId,
    harnessRunId,
  };
}

describe('spike surface with HABI_SPIKE_MODE=1', () => {
  let server;
  let requestA;
  let requestB;
  let runA;
  let runB;

  before(async () => {
    server = await startApi({ HABI_SPIKE_MODE: '1' });
    requestA = createClient(server.base, TOKEN_A);
    requestB = createClient(server.base, TOKEN_B);
    runA = await createRun(requestA, 'conv_spike_a');
    runB = await createRun(requestB, 'conv_spike_b');
  });

  after(async () => {
    if (server !== undefined) {
      await server.stop();
    }
  });

  test('unauthenticated requests are rejected with 401', async () => {
    const anonymous = createClient(server.base, undefined);
    const malformed = createClient(server.base, 'not-a-bearer-header');
    const unknown = createClient(server.base, 'spike-token-unknown');

    for (const [request, path, method] of [
      [anonymous, '/spike/runs', 'GET'],
      [anonymous, '/spike/runs', 'POST'],
      [anonymous, '/spike/runs/run_missing', 'GET'],
      [malformed, '/spike/runs', 'GET'],
      [unknown, '/spike/runs', 'GET'],
    ]) {
      const response = await request(path, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.deepEqual(response.body, { error: { code: 'unauthenticated' } });
    }
  });

  test('owner reads and lists only their own runs', async () => {
    const read = await requestA(`/spike/runs/${runA.runId}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, {
      runId: runA.runId,
      status: 'created',
      conversationId: 'conv_spike_a',
      createdAt: read.body.createdAt,
    });
    assert.equal('ownerUserId' in read.body, false);
    assert.equal('harnessRunId' in read.body, false);

    const listedA = await requestA('/spike/runs');
    assert.equal(listedA.status, 200);
    const runIdsA = listedA.body.runs.map((run) => run.runId);
    assert.ok(runIdsA.includes(runA.runId));
    assert.equal(runIdsA.includes(runB.runId), false);

    const listedB = await requestB('/spike/runs');
    assert.equal(listedB.status, 200);
    const runIdsB = listedB.body.runs.map((run) => run.runId);
    assert.ok(runIdsB.includes(runB.runId));
    assert.equal(runIdsB.includes(runA.runId), false);
  });

  test('owner reads events; only run.created exists before any tool attempt', async () => {
    const response = await requestA(`/spike/runs/${runA.runId}/events`);

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.events.map((event) => event.type),
      ['run.created'],
    );
  });

  test("another user's run, events, and audit all return the same 404", async () => {
    for (const path of [
      `/spike/runs/${runA.runId}`,
      `/spike/runs/${runA.runId}/events`,
      `/spike/runs/${runA.runId}/audit`,
    ]) {
      const response = await requestB(path);
      assert.equal(response.status, 404, path);
      assert.deepEqual(response.body, NOT_FOUND);
    }
  });

  test('an unknown run id returns the same 404', async () => {
    const response = await requestA('/spike/runs/run_00000000-0000-0000-0000-000000000000');

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, NOT_FOUND);
  });

  test('the harness run id is never accepted as a path identifier', async () => {
    for (const path of [
      `/spike/runs/${runA.harnessRunId}`,
      `/spike/runs/${runA.harnessRunId}/events`,
      `/spike/runs/${runA.harnessRunId}/audit`,
    ]) {
      const response = await requestA(path);
      assert.equal(response.status, 404, path);
      assert.deepEqual(response.body, NOT_FOUND);
    }

    const toolAttempt = await requestA(`/spike/runs/${runA.harnessRunId}/tools/shell.exec`, {
      method: 'POST',
    });

    assert.equal(toolAttempt.status, 404);
    assert.deepEqual(toolAttempt.body, NOT_FOUND);
  });

  test('client-supplied user identifiers are not trusted', async () => {
    const spoofedHeaders = { 'x-spike-user-id': 'user-a', 'x-user-id': 'user-a' };

    const read = await requestB(`/spike/runs/${runA.runId}`, { headers: spoofedHeaders });
    assert.equal(read.status, 404);
    assert.deepEqual(read.body, NOT_FOUND);

    const list = await requestB('/spike/runs', { headers: spoofedHeaders });
    assert.equal(list.status, 200);
    assert.equal(
      list.body.runs.some((run) => run.runId === runA.runId),
      false,
    );
  });

  test('an owner tool attempt is denied and audited', async () => {
    const denied = await requestA(`/spike/runs/${runA.runId}/tools/shell.exec`, {
      method: 'POST',
    });

    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: { code: 'policy_denied', tool: 'shell.exec' } });

    const audit = await requestA(`/spike/runs/${runA.runId}/audit`);
    assert.equal(audit.status, 200);
    const denial = audit.body.events.find((event) => event.type === 'policy.denied');
    assert.ok(denial);
    assert.equal(denial.tool, 'shell.exec');
    assert.equal(typeof denial.at, 'string');

    const events = await requestA(`/spike/runs/${runA.runId}/events`);
    assert.equal(events.status, 200);
    assert.ok(events.body.events.some((event) => event.type === 'policy.denied'));

    const crossUserAudit = await requestB(`/spike/runs/${runA.runId}/audit`);
    assert.equal(crossUserAudit.status, 404);
    assert.deepEqual(crossUserAudit.body, NOT_FOUND);
  });

  test('a cross-user tool attempt is 404 and writes no audit event', async () => {
    const before = await requestA(`/spike/runs/${runA.runId}/audit`);
    assert.equal(before.status, 200);

    const denied = await requestB(`/spike/runs/${runA.runId}/tools/shell.exec`, {
      method: 'POST',
    });

    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, NOT_FOUND);

    const afterAttempt = await requestA(`/spike/runs/${runA.runId}/audit`);
    assert.equal(afterAttempt.status, 200);
    assert.equal(afterAttempt.body.events.length, before.body.events.length);
  });
});

describe('spike surface without HABI_SPIKE_MODE', () => {
  let server;

  before(async () => {
    server = await startApi();
  });

  after(async () => {
    if (server !== undefined) {
      await server.stop();
    }
  });

  test('spike routes are not registered and health is unchanged', async () => {
    const request = createClient(server.base, TOKEN_A);

    for (const [path, method] of [
      ['/spike/runs', 'GET'],
      ['/spike/runs', 'POST'],
      ['/spike/runs/run_00000000-0000-0000-0000-000000000000', 'GET'],
      ['/spike/runs/run_00000000-0000-0000-0000-000000000000/tools/shell.exec', 'POST'],
    ]) {
      const response = await request(path, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
    }

    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok', service: 'api' });
  });
});
