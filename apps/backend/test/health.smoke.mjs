import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;

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

test(
  'API health endpoint responds and shuts down cleanly on SIGTERM',
  { timeout: 30000 },
  async () => {
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
      const ready = await waitForEvent(child, 'api.ready', output, READY_TIMEOUT_MS);

      assert.equal(ready.service, 'api');
      assert.equal(ready.host, '127.0.0.1');
      assert.equal(ready.port, port);

      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
      assert.deepEqual(await response.json(), { status: 'ok', service: 'api' });

      assert.equal(child.kill('SIGTERM'), true);

      const result = await waitForExit(child, EXIT_TIMEOUT_MS, 'API');

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
  },
);

test(
  'API rejects an invalid PORT with a machine-readable error and exit 1',
  { timeout: 30000 },
  async () => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '65536',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = captureOutput(child);

    try {
      const errorEvent = await waitForEvent(child, 'api.error', output, READY_TIMEOUT_MS);

      assert.equal(typeof errorEvent.message, 'string');
      assert.match(errorEvent.message, /PORT/);

      const result = await waitForExit(child, EXIT_TIMEOUT_MS, 'API');

      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.doesNotMatch(output.stdout, /"event":"api\.ready"/);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        { cause: error },
      );
    } finally {
      await forceStop(child);
    }
  },
);
