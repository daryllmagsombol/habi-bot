import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../', import.meta.url));

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('built homepage renders the honest foundation without product controls', { timeout: 40_000 }, async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError;
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => child.once('close', resolve));

  try {
    const deadline = Date.now() + 25_000;
    let response;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Next exited before readiness:\n${output}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(response, `Next did not become ready:\n${output}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    // Check rendered content, not duplicated/escaped Next metadata or RSC payloads.
    const rendered = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    const text = rendered.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    for (const sentence of [
      'Habi',
      'Weave ideas into action.',
      'Foundation preview',
      'This repository proves the workspace, web shell, API health endpoint, worker boot path, and local PostgreSQL tooling.',
      'It does not include sign-in, chat, Bots, model calls, or Hermes.',
      'No product functionality is available yet.',
    ]) {
      assert.ok(text.includes(sentence), `Missing visible copy: ${sentence}`);
    }
    assert.doesNotMatch(rendered, /<(?:form|input|textarea|button)\b/i);
    assert.doesNotMatch(rendered, /\btype\s*=\s*["']?password\b/i);
    assert.equal((rendered.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(rendered, /<html\b[^>]*lang="en"/i);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
    clearTimeout(timer);
    if (!stopped) {
      child.kill('SIGKILL');
      await exited;
      assert.fail(`Next did not stop after SIGTERM:\n${output}`);
    }
  }
});
