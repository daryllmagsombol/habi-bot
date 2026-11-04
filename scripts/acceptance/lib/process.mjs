/**
 * Process, port, and readiness helpers for the acceptance harness.
 *
 * These are intentionally small and dependency-free. PostgreSQL access is
 * resolved through `pg` from the backend workspace, matching
 * `scripts/db/migrate.mjs`, so the harness adds no root dependency.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const HARNESS_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BACKEND_ROOT = fileURLToPath(new URL('../../../apps/backend/', import.meta.url));

const requireBackend = createRequire(`${BACKEND_ROOT}package.json`);

/** Resolves a backend runtime dependency without a second root declaration. */
export function requireBackendModule(name) {
  return requireBackend(name);
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port.')));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    env: options.env ?? process.env,
    input: options.input,
  });
}

export function runChecked(command, args, options = {}) {
  const result = run(command, args, options);

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed (status ${result.status}): ${stderr.slice(0, 2000)}`,
    );
  }

  return result;
}

export function captureOutput(child) {
  const output = { stdout: '', stderr: '' };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output.stderr += chunk;
  });

  return output;
}

function logLines(output) {
  return `${output.stdout}\n${output.stderr}`.split(/\r?\n/);
}

/**
 * Waits for one JSON log line whose `event` field matches. The API and worker
 * both emit this shape; non-JSON output is ignored rather than parsed loosely.
 */
export function waitForLogEvent(child, output, eventName, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for "${eventName}" after ${timeoutMs}ms.\n` +
            `stdout:\n${output.stdout.slice(-4000)}\n` +
            `stderr:\n${output.stderr.slice(-4000)}`,
        ),
      );
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off('data', check);
      child.stderr?.off('data', check);
      child.off('exit', onExit);
    }

    function check() {
      for (const line of logLines(output)) {
        if (line.trim() === '') {
          continue;
        }

        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (entry !== null && typeof entry === 'object' && entry.event === eventName) {
          cleanup();
          resolve(entry);
          return;
        }
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(
        new Error(
          `Process exited before "${eventName}" (code=${code}, signal=${signal}).\n` +
            `stdout:\n${output.stdout.slice(-4000)}\n` +
            `stderr:\n${output.stderr.slice(-4000)}`,
        ),
      );
    }

    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.once('exit', onExit);
    check();
  });
}

export function waitForExit(child, timeoutMs, label) {
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

export async function stopChild(child, { graceMs = 10_000, signal = 'SIGTERM' } = {}) {
  if (child === undefined || child === null) {
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill(signal);

  try {
    await waitForExit(child, graceMs, 'Child process');
  } catch {
    // Fall through to SIGKILL below.
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');

    try {
      await waitForExit(child, 5_000, 'Child process');
    } catch {
      // Best effort; the caller's teardown still removes the container.
    }
  }
}

export async function waitFor(predicate, label, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    last = await predicate();

    if (last) {
      return last;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for ${label}. Last observed: ${JSON.stringify(last)}`,
  );
}
