import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const MODULE = fileURLToPath(new URL('../dist/worker.module.js', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;

const FORBIDDEN_MODULES = new Set([
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'express',
  '@nestjs/platform-express',
  'pg',
  'redis',
  'ioredis',
  'bullmq',
  'kafkajs',
  'amqplib',
  'axios',
  'undici',
  'node-fetch',
  '@prisma/client',
  'drizzle-orm',
]);

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
      child.off('exit', onExit);
    }

    function check() {
      for (const line of output.stdout.split(/\r?\n/)) {
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
    await waitForExit(child, 5000, 'Worker process');
  } catch {
    // The process is already being torn down; nothing else to clean up.
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function importedModules(source) {
  const specifiers = [];
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

test('worker entry has no HTTP listener, timers, or integration imports', async () => {
  const [entrySource, moduleSource] = await Promise.all([
    readFile(ENTRY, 'utf8'),
    readFile(MODULE, 'utf8'),
  ]);
  const source = `${entrySource}\n${moduleSource}`;

  for (const specifier of importedModules(source)) {
    assert.ok(
      !FORBIDDEN_MODULES.has(specifier),
      `Worker entry/module must not import ${specifier}.`,
    );
  }

  assert.doesNotMatch(source, /\.listen\s*\(/);
  assert.doesNotMatch(source, /\bcreateServer\s*\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bsetInterval\s*\(/);
  assert.doesNotMatch(source, /\bsetTimeout\s*\(/);
});

async function verifyWorkerShutdown(signals, { checkInert = true } = {}) {
  const signalList = Array.isArray(signals) ? signals : [signals];
  const port = await getFreePort();
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);

  try {
    const ready = await waitForEvent(child, 'worker.ready', output, READY_TIMEOUT_MS);

    assert.equal(ready.service, 'worker');

    await delay(300);

    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);

    if (checkInert) {
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }),
        'Worker must not open an HTTP listener.',
      );
    }

    // Dispatch the burst synchronously so later signals cannot race process exit.
    for (const signal of signalList) {
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }

      assert.equal(child.kill(signal), true);
    }

    const result = await waitForExit(child, EXIT_TIMEOUT_MS, 'Worker');

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      { cause: error },
    );
  } finally {
    await forceStop(child);
  }
}

test('worker stays idle without HTTP and exits 0 on SIGTERM', { timeout: 30000 }, async () => {
  await verifyWorkerShutdown(['SIGTERM']);
});

test('worker exits 0 on SIGINT', { timeout: 30000 }, async () => {
  await verifyWorkerShutdown(['SIGINT']);
});

test(
  'worker exits 0 on repeated SIGTERM during shutdown',
  { timeout: 30000 },
  async () => {
    await verifyWorkerShutdown(['SIGTERM', 'SIGTERM'], { checkInert: false });
  },
);

test(
  'worker exits 0 on mixed SIGTERM/SIGINT during shutdown',
  { timeout: 30000 },
  async () => {
    await verifyWorkerShutdown(['SIGTERM', 'SIGINT'], { checkInert: false });
  },
);
