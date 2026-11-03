/**
 * H-016 (#16) foundational ownership slice.
 *
 * Unit coverage for the default-deny helper and its audit sink, plus the spike
 * integration that proves the helper is wired into the existing run service and
 * that the HTTP contract (owner 200, everyone else the same 404) is unchanged.
 * The fuller two-user matrix lives in spike-isolation.smoke.mjs and is run by
 * the package test glob; this file does not duplicate it.
 *
 * The app is exercised through dist, mirroring the other smoke suites.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OwnershipDeniedError,
  assertOwned,
  assertOwnedById,
  createInMemoryAuditSink,
  hashResourceId,
} from '../dist/ownership/ownership.js';
import { SpikeRunsService } from '../dist/spike/spike-runs.service.js';

const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const TOKEN_A = 'spike-token-a';
const TOKEN_B = 'spike-token-b';
const NOT_FOUND = { error: { code: 'not_found' } };
const SALT = 'test-salt-not-a-secret';
const RUN_TYPE = 'run';
const OWNER = 'user-a';
const OTHER = 'user-b';

function liveRun(overrides = {}) {
  return {
    runId: 'run_11111111-1111-1111-1111-111111111111',
    ownerUserId: OWNER,
    status: 'created',
    // Decoy fields: the helper must never copy them into an audit event.
    content: 'do-not-log-me',
    prompt: 'do-not-log-me-either',
    ...overrides,
  };
}

function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }

  assert.fail('Expected the call to throw.');
}

async function captureAsync(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }

  assert.fail('Expected the call to reject.');
}

function policyOf(records) {
  return {
    resourceType: RUN_TYPE,
    findById(id) {
      return records.get(id);
    },
  };
}

function assertDenied(error) {
  assert.ok(error instanceof OwnershipDeniedError, 'expected OwnershipDeniedError');
  assert.equal(error.name, 'OwnershipDeniedError');
  assert.equal(error.code, 'ownership_denied');
  assert.equal(error.message, 'ownership_denied');
}

describe('ownership helper', () => {
  test('returns the resource to its owner', () => {
    const run = liveRun();
    const result = assertOwned({ actorUserId: OWNER, resource: run, resourceType: RUN_TYPE });

    assert.equal(result, run);
  });

  test('denies a foreign actor, an unknown id, and a deleted resource identically', async () => {
    const run = liveRun();
    const sink = createInMemoryAuditSink();
    const check = {
      actorUserId: OTHER,
      resource: run,
      resourceType: RUN_TYPE,
      resourceId: run.runId,
    };

    const foreign = capture(() => assertOwned({ ...check, auditSink: sink, hashSalt: SALT }));
    const unknown = await captureAsync(() =>
      assertOwnedById({
        actorUserId: OWNER,
        id: 'run_99999999-9999-9999-9999-999999999999',
        policy: policyOf(new Map()),
        auditSink: sink,
        hashSalt: SALT,
      }),
    );
    const deleted = capture(() =>
      assertOwned({
        actorUserId: OWNER,
        resource: liveRun({ deletedAt: '2026-11-03T00:00:00.000Z' }),
        resourceType: RUN_TYPE,
        auditSink: sink,
        hashSalt: SALT,
      }),
    );

    for (const error of [foreign, unknown, deleted]) {
      assertDenied(error);
    }

    // Same shape and message; nothing encodes which case failed.
    const shapes = [foreign, unknown, deleted].map((error) => ({
      name: error.name,
      code: error.code,
      message: error.message,
    }));
    assert.deepEqual(shapes[1], shapes[0]);
    assert.deepEqual(shapes[2], shapes[0]);
    assert.equal(sink.events.length, 3);
  });

  test('denies a missing actor, a blank actor, and a blank owner', () => {
    const cases = [
      { actorUserId: undefined, resource: liveRun() },
      { actorUserId: null, resource: liveRun() },
      { actorUserId: '', resource: liveRun() },
      { actorUserId: '   ', resource: liveRun() },
      { actorUserId: OWNER, resource: liveRun({ ownerUserId: '' }) },
      { actorUserId: OWNER, resource: null },
      { actorUserId: OWNER, resource: undefined },
    ];

    for (const check of cases) {
      assertDenied(capture(() => assertOwned(check)));
      assertDenied(capture(() => assertOwned({ ...check, resourceType: RUN_TYPE })));
    }
  });

  test('has no admin, service-account, or caller-supplied owner bypass', () => {
    const run = liveRun();

    for (const actorUserId of [OTHER, '', undefined]) {
      const error = capture(() =>
        assertOwned({
          actorUserId,
          resource: run,
          resourceType: RUN_TYPE,
          // Client-shaped extras the helper does not read.
          isAdmin: true,
          role: 'admin',
          serviceAccount: true,
          scopes: ['*'],
          request: { ownerUserId: OTHER, userId: OTHER },
          ownerUserId: actorUserId,
        }),
      );

      assertDenied(error);
    }

    // An owner field on a request-shaped object cannot substitute for the
    // server-recorded owner; the decision uses `resource.ownerUserId` only.
    assertDenied(
      capture(() =>
        assertOwned({
          actorUserId: OTHER,
          resource: run,
          resourceType: RUN_TYPE,
          request: { ownerUserId: OTHER },
        }),
      ),
    );
  });

  test('an empty-string deletedAt marker does not deny', () => {
    const result = assertOwned({
      actorUserId: OWNER,
      resource: liveRun({ deletedAt: '' }),
      resourceType: RUN_TYPE,
    });

    assert.equal(result.ownerUserId, OWNER);
  });

  test('records exactly one audit event per denial, without content or raw ids', () => {
    const sink = createInMemoryAuditSink();
    const run = liveRun();

    assertDenied(
      capture(() =>
        assertOwned({
          actorUserId: OTHER,
          resource: run,
          resourceType: RUN_TYPE,
          resourceId: run.runId,
          auditSink: sink,
          hashSalt: SALT,
        }),
      ),
    );

    assert.equal(sink.events.length, 1);
    const [event] = sink.events;

    assert.deepEqual(Object.keys(event).sort(), [
      'actorUserId',
      'at',
      'event',
      'resourceIdHash',
      'resourceType',
    ]);
    assert.equal(event.event, 'ownership.denied');
    assert.equal(event.actorUserId, OTHER);
    assert.equal(event.resourceType, RUN_TYPE);
    assert.equal(event.resourceIdHash, hashResourceId(run.runId, SALT));
    assert.match(event.resourceIdHash, /^[0-9a-f]{64}$/);
    assert.equal(Number.isNaN(Date.parse(event.at)), false);

    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(run.runId), false);
    assert.equal(serialized.includes('do-not-log-me'), false);
    assert.equal(serialized.includes('ownerUserId'), false);

    // Same id and salt are comparable; a different salt is not.
    assert.equal(hashResourceId(run.runId, SALT), event.resourceIdHash);
    assert.notEqual(hashResourceId(run.runId, 'other-salt'), event.resourceIdHash);
  });

  test('records one event per denial and none for an allowed read', () => {
    const sink = createInMemoryAuditSink();

    assertOwned({ actorUserId: OWNER, resource: liveRun(), resourceType: RUN_TYPE });
    assert.equal(sink.events.length, 0);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assertDenied(
        capture(() =>
          assertOwned({
            actorUserId: OTHER,
            resource: liveRun(),
            resourceType: RUN_TYPE,
            resourceId: `run_${attempt}`,
            auditSink: sink,
            hashSalt: SALT,
          }),
        ),
      );
    }

    assert.equal(sink.events.length, 3);
    assert.equal(new Set(sink.events.map((event) => event.resourceIdHash)).size, 3);
  });

  test('a configured sink without a salt is a programming error, not a grant', () => {
    const sink = createInMemoryAuditSink();

    assert.throws(
      () =>
        assertOwned({
          actorUserId: OTHER,
          resource: liveRun(),
          resourceType: RUN_TYPE,
          resourceId: 'run_x',
          auditSink: sink,
        }),
      TypeError,
    );
    assert.equal(sink.events.length, 0);
  });

  test('a throwing audit sink cannot turn a denial into a grant', () => {
    const sink = {
      record() {
        throw new Error('sink unavailable');
      },
    };

    assertDenied(
      capture(() =>
        assertOwned({
          actorUserId: OTHER,
          resource: liveRun(),
          resourceType: RUN_TYPE,
          resourceId: 'run_x',
          auditSink: sink,
          hashSalt: SALT,
        }),
      ),
    );
  });
});

describe('spike run service ownership wiring', () => {
  test('allows the owner and denies everyone else through the shared helper', () => {
    const sink = createInMemoryAuditSink();
    const service = new SpikeRunsService(sink);
    const runA = service.createRun(OWNER, 'conv_a');

    assert.equal(service.findOwnedRun(runA.runId, OWNER)?.runId, runA.runId);
    assert.equal(sink.events.length, 0);

    assert.equal(service.findOwnedRun(runA.runId, OTHER), undefined);
    assert.equal(sink.events.length, 1);
    const [event] = sink.events;
    assert.equal(event.actorUserId, OTHER);
    assert.equal(event.resourceType, 'spike.run');
    assert.equal(JSON.stringify(event).includes(runA.runId), false);

    assert.equal(service.findOwnedRun('run_does_not_exist', OWNER), undefined);
    assert.equal(service.findOwnedRun(runA.runId, ''), undefined);
    assert.equal(sink.events.length, 3);
  });

  test('a soft-deleted run is denied through the service', () => {
    const sink = createInMemoryAuditSink();
    const service = new SpikeRunsService(sink);
    const run = service.createRun(OWNER, 'conv_deleted');

    run.deletedAt = '2026-11-03T12:00:00.000Z';

    assert.equal(service.findOwnedRun(run.runId, OWNER), undefined);
    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0].resourceType, 'spike.run');
  });
});

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

async function startApi() {
  const port = await getFreePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'test',
    HABI_SPIKE_MODE: '1',
  };

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

describe('spike HTTP ownership boundary after helper adoption', () => {
  let server;
  let requestA;
  let requestB;
  let runA;

  before(async () => {
    server = await startApi();
    requestA = createClient(server.base, TOKEN_A);
    requestB = createClient(server.base, TOKEN_B);

    const created = await requestA('/spike/runs', {
      method: 'POST',
      body: { conversationId: 'conv_owner_matrix' },
    });

    assert.equal(created.status, 201);
    runA = {
      runId: created.body.runId,
      harnessRunId: created.headers.get('x-spike-harness-run-id'),
    };
  });

  after(async () => {
    if (server !== undefined) {
      await server.stop();
    }
  });

  test('owner read stays 200 and the cross-user read is the same 404 as an unknown id', async () => {
    const own = await requestA(`/spike/runs/${runA.runId}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.runId, runA.runId);

    const foreign = await requestB(`/spike/runs/${runA.runId}`);
    const unknown = await requestA('/spike/runs/run_00000000-0000-0000-0000-000000000000');

    assert.equal(foreign.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(foreign.body, NOT_FOUND);
    assert.deepEqual(unknown.body, NOT_FOUND);
    assert.deepEqual(foreign.body, unknown.body);
  });

  test('spoofed identity headers and a harness id remain ineffective', async () => {
    const spoofed = await requestB(`/spike/runs/${runA.runId}`, {
      headers: { 'x-user-id': OWNER, 'x-spike-user-id': OWNER },
    });
    assert.equal(spoofed.status, 404);
    assert.deepEqual(spoofed.body, NOT_FOUND);

    const byHarnessId = await requestA(`/spike/runs/${runA.harnessRunId}`);
    assert.equal(byHarnessId.status, 404);
    assert.deepEqual(byHarnessId.body, NOT_FOUND);
  });

  test('a client-supplied owner field in the create body is ignored', async () => {
    const created = await requestB('/spike/runs', {
      method: 'POST',
      body: {
        conversationId: 'conv_spoofed_owner',
        ownerUserId: OWNER,
        userId: OWNER,
        isAdmin: true,
        serviceAccount: true,
      },
    });

    assert.equal(created.status, 201);
    const spoofedRunId = created.body.runId;

    const ownerRead = await requestB(`/spike/runs/${spoofedRunId}`);
    assert.equal(ownerRead.status, 200);

    const otherRead = await requestA(`/spike/runs/${spoofedRunId}`);
    assert.equal(otherRead.status, 404);
    assert.deepEqual(otherRead.body, NOT_FOUND);

    const listA = await requestA('/spike/runs');
    assert.equal(
      listA.body.runs.some((run) => run.runId === spoofedRunId),
      false,
    );

    const listB = await requestB('/spike/runs');
    assert.equal(
      listB.body.runs.some((run) => run.runId === spoofedRunId),
      true,
    );
  });
});
