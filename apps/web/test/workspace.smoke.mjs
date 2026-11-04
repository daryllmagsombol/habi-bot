/**
 * Design-preview smoke: the gallery, the thread workspace, and the two evidence
 * panels render on the server with the copy and landmarks the design relies on.
 *
 * This is a server-rendered assertion, not a browser test. Visual behaviour
 * (panes, sheets, focus order) is verified by hand at 320/768/1440; what is
 * checked here is that the shell is honest — sample data is labelled, no
 * secret or upstream URL leaks into the page, and unknown Bots 404 instead of
 * inventing one.
 */
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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

test('built Bot gallery and thread workspace render honest sample data', { timeout: 60_000 }, async () => {
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
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
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
      signal: AbortSignal.timeout(8000),
    });
    return { response, html: await response.text() };
  }

  try {
    const deadline = Date.now() + 25_000;
    let ready = false;

    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Next exited before readiness:\n${output}`);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/bots`, {
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

    const gallery = await page('/bots');
    assert.equal(gallery.response.status, 200);
    assert.match(gallery.response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(gallery.html, /<html\b[^>]*lang="en"/i);
    assert.match(gallery.html, /href="#main-content"/);
    assert.match(gallery.html, /<main[^>]*id="main-content"/);
    assert.equal((gallery.html.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(gallery.html, /<h1[^>]*>Your bots<\/h1>/);

    const galleryText = visibleText(gallery.html);
    for (const copy of [
      'Four working assistants',
      'Field Notes',
      'Draft Partner',
      'Sounding Board',
      'Second Reader',
      'memories',
      'threads',
      'Open',
      'New bot',
      'Not available in this preview',
      'local sample data',
    ]) {
      assert.ok(galleryText.includes(copy), `gallery is missing: ${copy}`);
    }

    assert.match(gallery.html, /aria-label="Workspace"/);
    assert.match(gallery.html, /aria-label="Switch to (?:light|dark) theme"/);
    assert.match(gallery.html, /localStorage\.getItem\('habi-theme'\)/);
    assert.match(gallery.html, /href="\/bots\/field-notes"/);
    assert.match(gallery.html, /href="\/threads"/);

    const threads = await page('/threads');
    assert.equal(threads.response.status, 200);
    assert.equal((threads.html.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(threads.html, /<h1[^>]*>Threads<\/h1>/);
    assert.ok(visibleText(threads.html).includes('Should the allowance pause or stop?'));

    const thread = await page('/bots/field-notes?thread=run-ordering');
    assert.equal(thread.response.status, 200);
    assert.equal((thread.html.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(thread.html, /<h1[^>]*>Field Notes<\/h1>/);

    const threadText = visibleText(thread.html);
    for (const copy of [
      'Run event ordering across a reconnect',
      'Run 4821',
      'streaming',
      'tools 0',
      'Both the bot and the thread have to approve a memory',
      'No tools · 2 of 3 memories selected',
    ]) {
      assert.ok(threadText.includes(copy), `thread is missing: ${copy}`);
    }

    assert.match(thread.html, /<label[^>]*for="composer"/);
    assert.match(thread.html, /id="composer"/);
    assert.match(thread.html, /role="status"/);
    assert.match(thread.html, /aria-current="page"/);
    assert.match(thread.html, /aria-label="Thread panels"/);
    assert.match(thread.html, /panel=document/);
    assert.match(thread.html, /panel=context/);

    const documentPanel = await page('/bots/field-notes?thread=run-ordering&panel=document');
    assert.equal(documentPanel.response.status, 200);
    const documentText = visibleText(documentPanel.html);
    for (const copy of [
      'stream-notes.md',
      'Cited in the reply above',
      'read-only',
      'Close panel',
    ]) {
      assert.ok(documentText.includes(copy), `document panel is missing: ${copy}`);
    }
    assert.match(documentPanel.html, /<aside[^>]*aria-labelledby="document-panel-title"/);

    const contextPanel = await page('/bots/field-notes?thread=run-ordering&panel=context');
    assert.equal(contextPanel.response.status, 200);
    const contextText = visibleText(contextPanel.html);
    for (const copy of [
      'Memory',
      'Recalled',
      'Held',
      'Tools allowed',
      'Allow-list',
      '00:00 Asia/Manila',
      'Both approvals are needed',
    ]) {
      assert.ok(contextText.includes(copy), `context panel is missing: ${copy}`);
    }
    assert.match(contextPanel.html, /<aside[^>]*aria-labelledby="context-panel-title"/);

    const emptyDocument = await page('/bots/draft-partner?thread=boundary-note&panel=document');
    assert.equal(emptyDocument.response.status, 200);
    assert.ok(visibleText(emptyDocument.html).includes('No document in this thread'));

    // A missing Bot must be a 404, not an invented screen. Next sends the app
    // shell and hydrates the not-found boundary, so the status and the document
    // title are what the server response can be held to.
    const unknownBot = await page('/bots/not-a-bot');
    assert.equal(unknownBot.response.status, 404);
    assert.match(unknownBot.html, /<title>Not in this preview — Habi<\/title>/);
    // `notFound()` in a streaming dynamic route sends the boundary inside the
    // RSC payload rather than the initial HTML, so assert against the payload:
    // the http-error digest must be the 404 fallback, and the custom boundary
    // must be the tree that fallback renders.
    assert.match(unknownBot.html, /NEXT_HTTP_ERROR_FALLBACK;404/);
    assert.ok(
      unknownBot.html.includes('That Bot or thread is not in this preview'),
      'the custom not-found boundary is missing from the response payload',
    );
    assert.ok(
      unknownBot.html.includes('Back to the gallery'),
      'the not-found boundary has no way back to the gallery',
    );

    const unknownThread = await page('/bots/field-notes?thread=not-a-thread');
    assert.equal(unknownThread.response.status, 404);

    const combined = `${gallery.html}\n${thread.html}\n${documentPanel.html}\n${contextPanel.html}`;
    for (const forbidden of [
      'HABI_AUTH_API_URL',
      'DATABASE_URL',
      'api.openai.com',
      'sessionStorage',
      'coming soon',
    ]) {
      assert.ok(!combined.includes(forbidden), `preview leaked or promised: ${forbidden}`);
    }

    // The theme choice is the only thing this preview may store.
    const storageCalls = combined.match(/localStorage\.[a-zA-Z]+\([^)]*\)/g) ?? [];
    assert.ok(storageCalls.length > 0, 'the pre-paint theme script should be present');
    assert.ok(
      storageCalls.every((call) => call === "localStorage.getItem('habi-theme')"),
      `the preview may only read the theme preference: ${storageCalls.join(', ')}`,
    );
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
