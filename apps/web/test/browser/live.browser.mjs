/**
 * Live-mode verification in a real browser.
 *
 * `design.browser.mjs` runs the sample preview only: it boots Next with
 * `HABI_API_URL` unset. Every surface that exists only with an API configured —
 * the live gallery, `/account`, the live context panel's skills and artifacts,
 * the streamed run, the attachment-content failure, and the whole
 * preview/live state matrix in `docs/DESIGN.md` §2.1 — therefore had no browser
 * coverage at all. This suite closes that gap.
 *
 * The built app is booted against a settable stub upstream (`stub-api.mjs`,
 * modelled on `test/api-proxy.test.mjs`). One `next start` process and one
 * Chromium serve every state: the stub's mode is flipped per test, so the
 * healthy, 401, 500, dropped-connection, and failed-preflight answers are
 * exercised against the same build. A second boot (with an unparsable
 * `HABI_API_URL`) covers the configuration-error state, which is decided at
 * process start.
 *
 * The assertions are the design's stated boundaries, not a screenshot:
 *
 *   provenance   live records render with the `Live` mark, and no sample-data
 *                copy or sample record appears on any live route
 *   states       401 is a "Sign in" state with a `/login` link; 5xx and an
 *                unreachable API are explicit; an invalid URL is a
 *                configuration error; a 503 attachment is "Not stored on this
 *                server" with its metadata intact
 *   layout       no horizontal overflow, one h1, no skipped levels, contrast
 *                and 44px targets, at 320 and 1440 in light and dark
 *   account      the verbatim 184-day disclosure, the typed-email gate, a
 *                streamed export download behind a preflight (filename and
 *                bytes), and no navigation when that preflight fails
 *   editors      a skill edit prefills and submits only changed fields; artifact
 *                metadata editing has no content field and sends none
 *   interactions a content save and a restore post the body and the version the
 *                UI says they do; a memory approval carries both gates and the
 *                thread, and the row shows the server's answer even when it
 *                contradicts the switch; search posts the query and renders the
 *                hit; every cursor footer (artifacts, versions, skills, memories,
 *                search) appends one page behind its footer and the footer goes
 *                when `nextCursor` is null
 *   writes       a create posts the form body plus the CSRF token and the record
 *                only appears after the answer; an artifact past the 100 KB cap
 *                is refused before any request and the bound is stated; a skill
 *                create posts the form and the Bot it attaches to, and its name
 *                and 64 KiB body bounds refuse before any request; a Bot profile
 *                edit patches all three profile fields and only the refreshed
 *                card or identity takes the server's answer; a skill attach
 *                carries `{botId}`, detach carries none, and both badges follow
 *                the server; a memory proposal carries `{text, threadId}`; a Bot
 *                and both thread-create affordances post and open what the
 *                server returned
 *   streaming    a sent message renders the streamed reply the stub wrote, a
 *                dropped stream reconnects from its last `id:`, a stream that
 *                never resumes exhausts the documented bound of five
 *                connections into the explicit Retry state with its text kept,
 *                and Stop run posts one cancel whose label is the state the
 *                server answered (never a local "stopped")
 *
 * Run `pnpm --filter @habi/web build` first. No screenshot is written or kept.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import {
  auditContrast,
  auditHeadings,
  auditOverflow,
  auditTargets,
  readThemeState,
} from './probes.mjs';
import {
  ARTIFACT_ID,
  BOT_ID,
  CSRF,
  EXPORT_FILENAME,
  MEMORY_ID,
  NEW_THREAD_ID,
  RUN_ID,
  SESSION,
  SKILL_ID,
  THREAD_ID,
  createStub,
} from './stub-api.mjs';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../../', import.meta.url));

const WORKSPACE = `/bots/${BOT_ID}?thread=${THREAD_ID}`;

const LIVE_ROUTES = [
  { label: 'live gallery /bots', path: '/bots', settled: 'Live Field Notes' },
  { label: 'live thread index /threads', path: '/threads', settled: 'Live thread about ordering' },
  {
    label: 'live thread workspace',
    path: WORKSPACE,
    settled: 'First live question',
  },
  {
    label: 'live Document panel',
    path: `${WORKSPACE}&panel=document`,
    settled: 'Not stored on this server',
  },
  {
    label: 'live Context panel',
    path: `${WORKSPACE}&panel=context`,
    settled: 'Plain verbs',
  },
  { label: 'live account /account', path: '/account', settled: 'Delete account' },
];

const VIEWPORTS = [
  { width: 320, height: 760 },
  { width: 1440, height: 1000 },
];

const THEMES = ['light', 'dark'];

const EXPECTED = {
  light: { canvasToken: '#fbfaf6', bodyBackground: 'rgb(251, 250, 246)' },
  dark: { canvasToken: '#141317', bodyBackground: 'rgb(20, 19, 23)' },
};

/**
 * Preview-only copy and sample-only records. A live route may say the words
 * "sample data" negatively ("no figure here is sample data"), so these are the
 * preview's own claims and its fixture names, not a substring ban.
 */
const SAMPLE_ONLY_COPY = [
  'local sample data',
  'Interface preview',
  'Four working assistants',
  'Preview mode',
  'Preview only',
  'Not available in this preview',
  'Nothing is saved',
  'sample Bots',
  'stream-notes.md',
  'Should the allowance pause or stop?',
];

const ACCOUNT_BACKUP_DISCLOSURE =
  "A copy of this account's data survives in age-encrypted backups created before this deletion until those archives age out under the 7 daily / 4 weekly / 6 monthly retention policy — up to 184 days. Nothing is purged from an existing archive.";

const chromiumPath = chromium.executablePath();
const browserSkip = existsSync(chromiumPath)
  ? false
  : `Chromium is not installed at ${chromiumPath}; run "pnpm --filter @habi/web exec playwright install chromium" to run the browser suite.`;

function normalizeColor(value) {
  return value.replace(/\s+/g, '');
}

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
  const deadline = Date.now() + 30_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Next exited before readiness:\n${output}`);

    try {
      const response = await fetch(`${origin}/bots`, { signal: AbortSignal.timeout(1500) });
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

async function startStub() {
  const stub = createStub();
  stub.server.listen(0, '127.0.0.1');
  await once(stub.server, 'listening');
  const address = stub.server.address();
  assert.ok(address && typeof address === 'object');

  return {
    stub,
    origin: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise((resolve) => {
        // A held event stream (a cancelled run) would otherwise keep `close`
        // waiting for its socket to drain.
        stub.server.closeAllConnections();
        stub.server.close(resolve);
      }),
  };
}

/** A fresh browser context; the same-origin cookies are the only session. */
async function openContext(browser, { origin, width, height, theme, session, csrf }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: 'reduce',
    acceptDownloads: true,
  });

  const cookies = [];

  if (session !== undefined) {
    cookies.push({ name: 'habi_session', value: session, url: origin });
  }

  if (csrf === true) {
    cookies.push({ name: 'habi_csrf', value: CSRF, url: origin, httpOnly: false });
  }

  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  return context;
}

/** Layout, heading, contrast and target checks shared by every live route. */
async function assertDesignFloor(page, label) {
  const overflow = await page.evaluate(auditOverflow);
  assert.equal(
    overflow.scrollWidth,
    overflow.clientWidth,
    `${label}: horizontal overflow ${JSON.stringify(overflow)}`,
  );
  assert.equal(
    overflow.bodyScrollWidth,
    overflow.bodyClientWidth,
    `${label}: body overflows horizontally ${JSON.stringify(overflow)}`,
  );

  const headings = (await page.evaluate(auditHeadings)).filter((heading) => heading.visible);
  const h1s = headings.filter((heading) => heading.level === 1);
  assert.equal(h1s.length, 1, `${label}: expected one visible h1, found ${JSON.stringify(headings)}`);
  assert.ok(headings.length > 0, `${label}: no visible headings`);
  assert.equal(headings[0].level, 1, `${label}: the first heading is not an h1`);

  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1];
    const current = headings[index];
    assert.ok(
      current.level <= previous.level + 1,
      `${label}: heading level skipped from h${previous.level} to h${current.level}`,
    );
  }

  const contrast = await page.evaluate(auditContrast);
  assert.ok(contrast.checked > 0, `${label}: no text was measured`);
  assert.deepEqual(
    contrast.violations,
    [],
    `${label}: contrast below threshold (normal 4.5:1, large 3:1)`,
  );

  const targets = await page.evaluate(auditTargets);
  assert.ok(targets.checked > 0, `${label}: no interactive targets were measured`);
  assert.deepEqual(targets.violations, [], `${label}: interactive targets below 44px tall`);
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
}

/** Both memory gates render unchecked. Module-level so it stays one callback. */
function bothMemoryGatesOff() {
  const section = document.querySelector('section[aria-labelledby="context-memory"]');
  const boxes = section === null ? [] : [...section.querySelectorAll('input[type="checkbox"]')];

  return boxes.length === 2 && boxes.every((box) => !box.checked);
}

/** The Context panel's scrolling body, so a paging test can watch its position. */
function readPanelScroll(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('aside[aria-labelledby="context-panel-title"]');
    const scroller = panel === null ? null : panel.lastElementChild;

    if (!(scroller instanceof HTMLElement)) {
      return undefined;
    }

    return { top: scroller.scrollTop, height: scroller.scrollHeight };
  });
}

/** The Context panel's artifact section. */
function artifactsSection(page) {
  return page.locator('section[aria-labelledby="context-artifacts"]');
}

function assertNoSampleCopy(text, label) {
  for (const forbidden of SAMPLE_ONLY_COPY) {
    assert.ok(!text.includes(forbidden), `${label}: sample-data copy leaked: ${forbidden}`);
  }
}

async function gotoLive(page, origin, path, settled) {
  const response = await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  assert.equal(response?.status(), 200, `${path}: unexpected status`);
  await page.waitForSelector('main', { state: 'visible' });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  if (settled !== undefined) {
    await page.getByText(settled, { exact: true }).first().waitFor({ state: 'visible' });
  }

  return response;
}

describe(
  'live mode in Chromium',
  { skip: browserSkip, timeout: 420_000 },
  () => {
    let stub;
    let upstreamOrigin;
    let stopStub;
    let server;
    let browser;

    before(async () => {
      const upstream = await startStub();
      stub = upstream.stub;
      upstreamOrigin = upstream.origin;
      stopStub = upstream.stop;
      server = await bootNext({ HABI_API_URL: upstreamOrigin });
      browser = await chromium.launch();
    }, { timeout: 90_000 });

    after(async () => {
      await browser?.close();
      await server?.stop();
      await stopStub?.();
    }, { timeout: 30_000 });

    describe('live records · layout and accessibility', () => {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          describe(`${viewport.width}×${viewport.height} · ${theme}`, () => {
            let context;

            before(async () => {
              stub.setMode('ok');
              context = await openContext(browser, {
                origin: server.origin,
                width: viewport.width,
                height: viewport.height,
                theme,
                session: SESSION,
                csrf: true,
              });
            });

            after(async () => {
              await context?.close();
            });

            for (const route of LIVE_ROUTES) {
              test(route.label, { timeout: 60_000 }, async () => {
                const page = await context.newPage();
                const label = `${viewport.width}×${viewport.height} ${theme} ${route.path}`;

                try {
                  await gotoLive(page, server.origin, route.path, route.settled);

                  const themeState = await page.evaluate(readThemeState);
                  assert.equal(
                    themeState.mediaDark,
                    theme === 'dark',
                    `${label}: prefers-color-scheme did not resolve`,
                  );
                  assert.equal(
                    themeState.attribute,
                    null,
                    `${label}: a fresh context must not carry a stored theme`,
                  );
                  assert.equal(
                    themeState.canvasToken,
                    EXPECTED[theme].canvasToken,
                    `${label}: the ${theme} canvas token was not resolved`,
                  );
                  assert.equal(
                    normalizeColor(themeState.bodyBackground),
                    normalizeColor(EXPECTED[theme].bodyBackground),
                    `${label}: the page is not painted in the ${theme} palette`,
                  );

                  await assertDesignFloor(page, label);

                  assertNoSampleCopy(await bodyText(page), label);
                } finally {
                  await page.close();
                }
              });
            }
          });
        }
      }
    });

    describe('provenance', () => {
      test('1440 light: live records are marked Live and no sample copy renders', async () => {
        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          stub.setMode('ok');
          await gotoLive(page, server.origin, '/bots', 'Live Field Notes');

          await page.getByText('Live', { exact: true }).first().waitFor({ state: 'visible' });

          assert.equal(
            await page.getByText('Preview', { exact: true }).count(),
            0,
            'the live gallery rendered the Preview marker',
          );

          const text = await bodyText(page);
          assert.ok(text.includes('Live Field Notes'), 'the API record did not render');
          assert.ok(
            text.includes('come from the Habi API'),
            'the live gallery did not state its provenance',
          );
          assertNoSampleCopy(text, 'live gallery');
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('320 light: the Live marker is in the phone menu, not the desktop badge', async () => {
        const context = await openContext(browser, {
          origin: server.origin,
          width: 320,
          height: 760,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          stub.setMode('ok');
          await gotoLive(page, server.origin, '/bots', 'Live Field Notes');

          // The badge is `hidden sm:inline-flex` by design, so at 320 the
          // provenance sentence in the phone menu is the visible marker.
          await page.getByRole('button', { name: 'Open menu' }).click();
          await page
            .getByText('Live data from the Habi API.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });

          assertNoSampleCopy(await bodyText(page), 'live gallery 320');
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('every live surface is free of sample-data copy', async () => {
        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'dark',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          stub.setMode('ok');

          for (const route of LIVE_ROUTES) {
            await gotoLive(page, server.origin, route.path, route.settled);
            assertNoSampleCopy(await bodyText(page), route.path);
          }

          await gotoLive(page, server.origin, WORKSPACE, 'First live question');
          const workspace = await bodyText(page);
          assert.ok(
            workspace.includes('This conversation is stored by the Habi API.'),
            'the live workspace did not state its provenance',
          );
          assert.ok(
            !workspace.includes('This thread is local sample data.'),
            'the live workspace kept the preview footnote',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });
    });

    describe('state matrix', () => {
      for (const [label, width, height, theme] of [
        ['320 light', 320, 760, 'light'],
        ['1440 dark', 1440, 1000, 'dark'],
      ]) {
        test(`${label}: 401 renders the sign-in state with a /login link`, async () => {
          stub.setMode('unauthenticated');

          // No session cookie: the page's own account read answers 401.
          const context = await openContext(browser, {
            origin: server.origin,
            width,
            height,
            theme,
          });
          const page = await context.newPage();

          try {
            await gotoLive(page, server.origin, '/bots', 'Sign in to see your Bots');

            const text = await bodyText(page);
            assert.ok(
              text.includes('Sign in to see your Bots'),
              'the gallery did not render the sign-in state',
            );
            assert.ok(
              !text.includes('Live Field Notes'),
              'the gallery invented records without a session',
            );
            assert.ok(
              text.includes('No records are shown without a session.'),
              'the gallery rendered an empty state instead of the sign-in explanation',
            );
            assert.ok(
              await page.locator('a[href="/login"]').first().isVisible(),
              'the sign-in state has no /login link',
            );
            assertNoSampleCopy(text, '401 gallery');

            await gotoLive(page, server.origin, '/account', 'Sign in to manage your account');
            const accountText = await bodyText(page);
            assert.ok(
              accountText.includes('No account is loaded without a session.'),
              'the account page did not name the missing session',
            );
            assert.ok(
              await page.locator('a[href="/login"]').first().isVisible(),
              'the account sign-in state has no /login link',
            );
            assertNoSampleCopy(accountText, '401 account');
          } finally {
            stub.setMode('ok');
            await page.close();
            await context.close();
          }
        });

        test(`${label}: a 5xx is an explicit unavailable state, never sample data`, async () => {
          stub.setMode('error');

          const context = await openContext(browser, {
            origin: server.origin,
            width,
            height,
            theme,
            session: SESSION,
          });
          const page = await context.newPage();

          try {
            await gotoLive(page, server.origin, '/bots', 'The chat API is not reachable');
            const text = await bodyText(page);
            assert.ok(
              text.includes('No sample data here.'),
              'the 5xx state did not state that no sample data is shown',
            );
            assert.ok(
              !text.includes('Live Field Notes'),
              'the 5xx state rendered records it could not read',
            );
            assert.ok(
              await page.locator('a[href="/bots"]').first().isVisible(),
              'the unavailable state has no retry link',
            );
            assertNoSampleCopy(text, '5xx gallery');

            await gotoLive(page, server.origin, '/account', 'Account settings are not available');
            const accountText = await bodyText(page);
            assert.ok(
              accountText.includes('No account data is shown.'),
              'the account page did not render its unavailable state',
            );
            assertNoSampleCopy(accountText, '5xx account');
          } finally {
            stub.setMode('ok');
            await page.close();
            await context.close();
          }
        });

        test(`${label}: an unreachable API is the same explicit state`, async () => {
          stub.setMode('drop');

          const context = await openContext(browser, {
            origin: server.origin,
            width,
            height,
            theme,
            session: SESSION,
          });
          const page = await context.newPage();

          try {
            await gotoLive(page, server.origin, '/threads', 'The chat API is not reachable');
            const text = await bodyText(page);
            assert.ok(
              !text.includes('Should the allowance pause or stop?'),
              'the unreachable state fell back to a sample thread',
            );
            assertNoSampleCopy(text, 'unreachable threads');
          } finally {
            stub.setMode('ok');
            await page.close();
            await context.close();
          }
        });

        test(`${label}: attachment content 503 says it is not stored, metadata intact`, async () => {
          stub.setMode('ok');

          const context = await openContext(browser, {
            origin: server.origin,
            width,
            height,
            theme,
            session: SESSION,
          });
          const page = await context.newPage();

          try {
            await gotoLive(
              page,
              server.origin,
              `${WORKSPACE}&panel=document`,
              'Not stored on this server',
            );

            const text = await bodyText(page);
            assert.ok(
              text.includes('live-notes.md'),
              'the readable attachment metadata did not render',
            );
            assert.ok(
              text.includes('The stored paragraph mentions ordering.'),
              'the readable attachment text did not render',
            );
            assert.ok(
              text.includes('not-stored.txt'),
              'the unavailable attachment lost its metadata',
            );
            assert.ok(
              text.includes('12 B'),
              'the unavailable attachment lost its byte size',
            );
            assert.ok(
              text.includes('has no attachment storage root configured'),
              'the 503 did not name the missing storage root',
            );
            assert.ok(
              !text.includes('stream-notes.md'),
              'the 503 was filled with a sample attachment',
            );
          } finally {
            await page.close();
            await context.close();
          }
        });
      }
    });

    describe('account surfaces', () => {
      for (const [label, width, height, theme] of [
        ['1440 light', 1440, 1000, 'light'],
        ['320 dark', 320, 760, 'dark'],
      ]) {
        test(`${label}: the disclosure is verbatim and deletion needs the typed email`, async () => {
          stub.setMode('ok');

          const context = await openContext(browser, {
            origin: server.origin,
            width,
            height,
            theme,
            session: SESSION,
            csrf: true,
          });
          const page = await context.newPage();

          try {
            await gotoLive(page, server.origin, '/account', 'Delete account');

            const text = await bodyText(page);
            assert.ok(
              text.includes(ACCOUNT_BACKUP_DISCLOSURE),
              'the 184-day backup disclosure is not verbatim',
            );
            assert.ok(
              text.includes('up to 184 days'),
              'the disclosure lost its retention bound',
            );

            const deleteButton = page.getByRole('button', {
              name: 'Delete account permanently',
            });
            assert.equal(await deleteButton.isDisabled(), true, 'deletion starts enabled');

            const field = page.getByLabel('Type your account email to confirm');
            await field.fill('wrong@example.test');
            assert.equal(
              await deleteButton.isDisabled(),
              true,
              'a mismatched confirmation enabled deletion',
            );

            await field.fill('owner@example.test');
            await deleteButton.waitFor();
            assert.equal(
              await deleteButton.isDisabled(),
              false,
              'a matching confirmation did not enable deletion',
            );
            assert.ok(
              (await bodyText(page)).includes('The confirmation matches.'),
              'the matching confirmation was not announced',
            );

            await deleteButton.click();
            await page.getByText('Account deleted', { exact: true }).waitFor({ state: 'visible' });

            const deletion = stub.requests.find(
              (entry) => entry.method === 'DELETE' && entry.url === '/api/account',
            );
            assert.ok(deletion, 'the browser did not send the deletion');
            assert.deepEqual(JSON.parse(deletion.body), { confirm: 'owner@example.test' });
            assert.equal(deletion.headers['x-csrf-token'], CSRF);

            const result = await bodyText(page);
            assert.ok(
              result.includes('1 live session was revoked'),
              'the deletion result did not report the revoked session',
            );
            assert.ok(
              result.includes(ACCOUNT_BACKUP_DISCLOSURE),
              'the result dropped the verbatim disclosure',
            );
          } finally {
            await page.close();
            await context.close();
          }
        });
      }

      test('the export navigates to the streaming route instead of buffering', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, '/account', 'Delete account');
          stub.clearRequests();

          const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
          await page.getByRole('button', { name: 'Download export' }).click();
          const download = await downloadPromise;

          assert.equal(
            download.suggestedFilename(),
            EXPORT_FILENAME,
            'the download did not carry the export content-disposition',
          );

          const saved = await download.path();
          assert.ok(saved, 'Chromium did not write the download to disk');
          const document = JSON.parse(await readFile(saved, 'utf8'));
          assert.equal(
            document.manifest.schemaVersion,
            1,
            'the downloaded document was not the export body',
          );
          await download.delete();

          const preflight = stub.requests.find(
            (entry) => entry.method === 'GET' && entry.url === '/api/account',
          );
          assert.ok(preflight, 'the export did not preflight the account read');

          const forwarded = stub.requests.find(
            (entry) => entry.method === 'GET' && entry.url === '/api/account/export',
          );
          assert.ok(forwarded, 'the export body was never requested from the API');

          await page
            .getByText('The export download has started.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });
          assert.match(page.url(), /\/account$/, 'the export replaced the page instead of downloading');
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('a failed export preflight renders the error and navigates nowhere', async () => {
        stub.setMode('preflight-fail');

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();
        let downloaded = false;

        page.on('download', () => {
          downloaded = true;
        });

        try {
          // The first account read is the page render; the preflight is the second.
          await gotoLive(page, server.origin, '/account', 'Delete account');
          stub.clearRequests();

          await page.getByRole('button', { name: 'Download export' }).click();
          await page
            .getByText('The chat API is not reachable right now.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });

          await delay(400);

          assert.equal(downloaded, false, 'a failed preflight still started a download');
          assert.match(page.url(), /\/account$/, 'a failed preflight navigated the page');
          assert.equal(
            stub.requests.filter(
              (entry) => entry.method === 'GET' && entry.url === '/api/account/export',
            ).length,
            0,
            'a failed preflight still requested the export body',
          );
          assert.equal(
            stub.requests.filter(
              (entry) => entry.method === 'GET' && entry.url === '/api/account',
            ).length,
            1,
            'the export did not preflight exactly once',
          );
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });
    });

    describe('live editors', () => {
      test('a skill edit is prefilled and submits only the changed field', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Plain verbs');

          // The artifact panel also offers "Save new version"; scope to Skills.
          const skills = page.locator('section[aria-labelledby="context-skills"]');
          await skills.getByRole('button', { name: 'Edit', exact: true }).click();

          const name = skills.getByLabel('Name', { exact: true });
          const description = skills.getByLabel('Description', { exact: true });
          const body = skills.getByLabel('Body Markdown', { exact: true });

          assert.equal(await name.inputValue(), 'Plain verbs', 'the skill name was not prefilled');
          assert.equal(
            await description.inputValue(),
            'Prefer plain verbs over nominalisations.',
            'the skill description was not prefilled',
          );
          assert.equal(await body.inputValue(), 'Use plain verbs.', 'the skill body was not prefilled');

          const save = skills.getByRole('button', { name: 'Save new version' });
          assert.equal(
            await save.isDisabled(),
            true,
            'an unchanged edit was offered as savable',
          );

          await description.fill('Edited description only.');
          assert.equal(await save.isDisabled(), false, 'a changed edit was not savable');

          await save.click();
          await page
            .getByText('Saved “Plain verbs” as version 2.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });

          const patches = stub.requests.filter(
            (entry) => entry.method === 'PATCH' && entry.url === `/api/skills/${SKILL_ID}`,
          );
          assert.equal(patches.length, 1, 'the edit did not send exactly one PATCH');
          assert.deepEqual(
            JSON.parse(patches[0].body),
            { description: 'Edited description only.' },
            'the edit sent fields the reader did not change',
          );
          assert.equal(patches[0].headers['x-csrf-token'], CSRF);
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('artifact metadata editing has no content field and sends no content', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          await page.getByRole('button', { name: 'Edit metadata' }).click();

          const metadataForm = page.locator('form').filter({ hasText: 'Edit metadata' });
          await metadataForm.waitFor({ state: 'visible' });

          assert.equal(
            await metadataForm.locator('textarea').count(),
            0,
            'the metadata editor exposed a content field',
          );
          const formText = (await metadataForm.innerText()).replace(/\s+/g, ' ');
          assert.ok(
            formText.includes('leaves the stored content untouched'),
            'the metadata editor did not say the body is untouched',
          );
          assert.ok(
            formText.includes('Content is not touched by this form.'),
            'the metadata editor did not repeat that no content is sent',
          );

          const title = metadataForm.getByLabel('Title');
          assert.equal(await title.inputValue(), 'Ordering note', 'the title was not prefilled');

          await title.fill('Ordering note (edited)');
          await metadataForm.getByRole('button', { name: 'Save metadata' }).click();
          await page
            .getByText('Metadata saved as version 2.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });

          const patches = stub.requests.filter(
            (entry) =>
              entry.method === 'PATCH' && entry.url === `/api/artifacts/${ARTIFACT_ID}`,
          );
          assert.equal(patches.length, 1, 'the metadata save did not send exactly one PATCH');
          const payload = JSON.parse(patches[0].body);
          assert.deepEqual(payload, {
            title: 'Ordering note (edited)',
            kind: 'markdown',
            status: 'draft',
          });
          assert.ok(!('content' in payload), 'the metadata PATCH carried the body');

          // The content editor is a separate path and still present.
          assert.ok(
            await page.getByLabel('Artifact content').isVisible(),
            'the separate content editor disappeared',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });
    });

    describe('context interactions', () => {
      test('a content edit saves one new version and names it', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          const artifacts = artifactsSection(page);
          const content = artifacts.getByLabel('Artifact content');
          const saved = '# Ordering note\n\nSecond body, saved from the browser.';

          await content.fill(saved);
          await artifacts.getByRole('button', { name: 'Save new version' }).click();
          await page
            .getByText('Saved as version 2.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });

          const patches = stub.requests.filter(
            (entry) =>
              entry.method === 'PATCH' && entry.url === `/api/artifacts/${ARTIFACT_ID}`,
          );
          assert.equal(patches.length, 1, 'the content save did not send exactly one PATCH');
          assert.deepEqual(
            JSON.parse(patches[0].body),
            { content: saved },
            'the content save did not carry the edited body',
          );
          assert.equal(patches[0].headers['x-csrf-token'], CSRF);

          assert.ok(
            (await bodyText(page)).includes('Saved as version 2.'),
            'the success state did not name the appended version',
          );
          await page.getByText(/^version 2 ·/).first().waitFor({ state: 'visible' });
          assert.equal(
            await content.inputValue(),
            saved,
            'the editor did not show the version the server returned',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('restoring a listed version confirms the append and posts the version', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          const artifacts = artifactsSection(page);

          // Setup: a second version makes v1 history rather than the head, which
          // is the only state in which the UI offers a restore.
          await artifacts.getByLabel('Artifact content').fill('Second body.');
          await artifacts.getByRole('button', { name: 'Save new version' }).click();
          await page
            .getByText('Saved as version 2.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });

          await artifacts.getByRole('button', { name: 'Restore v1', exact: true }).click();
          await page
            .getByText(
              'Restoring v1 appends a new version. Earlier versions are never rewritten.',
              { exact: true },
            )
            .waitFor({ state: 'visible' });
          assert.ok(
            await artifacts.getByRole('button', { name: 'Cancel', exact: true }).isVisible(),
            'the restore confirmation cannot be declined',
          );

          // The confirmation replaces the row's control, so this is the same
          // accessible name on the one button that performs the restore.
          await artifacts.getByRole('button', { name: 'Restore v1', exact: true }).click();
          await page
            .getByText('Version 1 restored as version 3.', { exact: false })
            .first()
            .waitFor({ state: 'visible' });

          const restores = stub.requests.filter(
            (entry) =>
              entry.method === 'POST' &&
              entry.url === `/api/artifacts/${ARTIFACT_ID}/restore`,
          );
          assert.equal(restores.length, 1, 'the restore did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(restores[0].body),
            { version: 1 },
            'the restore did not name the version it restored',
          );
          assert.equal(restores[0].headers['x-csrf-token'], CSRF);
          assert.equal(
            await artifacts.getByLabel('Artifact content').inputValue(),
            '# Ordering note\n\nThe cursor is the sequence, not the clock.',
            'the editor did not show the body the server restored',
          );
          assert.ok(
            (await bodyText(page)).includes('append'),
            'the restore did not say it appends rather than rewrites',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('memory approvals post both gates and the row follows the server', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(
            page,
            server.origin,
            `${WORKSPACE}&panel=context`,
            'Prefers short sections over bullet dumps.',
          );

          const memory = page.locator('section[aria-labelledby="context-memory"]');
          const bot = memory.getByRole('checkbox', { name: /^Bot approval/ });
          const thread = memory.getByRole('checkbox', { name: /^Thread approval/ });

          // The API's seed: the Bot gate is on, the thread gate is off.
          assert.equal(await bot.isChecked(), true, 'the Bot gate did not start approved');
          assert.equal(await thread.isChecked(), false, 'the thread gate did not start held');
          await memory.getByText('Held', { exact: true }).waitFor({ state: 'visible' });

          await thread.click();
          await memory.getByText('Recalled', { exact: true }).waitFor({ state: 'visible' });
          assert.equal(await bot.isChecked(), true, 'moving the thread gate moved the Bot gate');
          assert.equal(await thread.isChecked(), true, 'the thread gate did not move');

          // Now the server keeps both gates off, whatever the write asked for.
          // The click only moves the Bot switch, so both switches ending off can
          // only be the server's answer arriving through the refresh.
          stub.setMode('approval-hold');
          await bot.click();

          await page.waitForFunction(bothMemoryGatesOff, undefined, { timeout: 15_000 });
          await memory.getByText('Held', { exact: true }).waitFor({ state: 'visible' });

          const approvals = stub.requests.filter(
            (entry) =>
              entry.method === 'POST' && entry.url === `/api/memories/${MEMORY_ID}/approvals`,
          );
          assert.equal(approvals.length, 2, 'the gates were not written twice');
          assert.deepEqual(
            JSON.parse(approvals[0].body),
            { bot: true, thread: true, threadId: THREAD_ID },
            'the first approval did not carry both gates and the thread',
          );
          assert.deepEqual(
            JSON.parse(approvals[1].body),
            { bot: false, thread: true, threadId: THREAD_ID },
            'the second approval did not carry the moved gate and the held one',
          );
          assert.equal(approvals[0].headers['x-csrf-token'], CSRF);
          assert.equal(approvals[1].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });

      test('search posts the query and renders the hit', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Plain verbs');

          const search = page.locator('section[aria-labelledby="context-search"]');
          await search.getByLabel('Search this account').fill('First live');
          await search.getByRole('button', { name: 'Search messages' }).click();

          const link = search.getByRole('link', { name: 'Live thread about ordering' });
          await link.waitFor({ state: 'visible' });
          assert.equal(
            await link.getAttribute('href'),
            `/bots/${BOT_ID}?thread=${THREAD_ID}`,
            'the hit did not link to its conversation',
          );
          assert.equal(
            await search.locator('mark').textContent(),
            'live',
            'the escaped <mark> fragment was not rendered as the only markup',
          );
          assert.ok(
            (await bodyText(search)).includes('First live question'),
            'the snippet did not render its text around the mark',
          );

          const calls = stub.requests.filter(
            (entry) => entry.method === 'GET' && entry.url.startsWith('/api/search'),
          );
          assert.equal(calls.length, 1, 'the search did not send exactly one request');
          const url = new URL(calls[0].url, 'http://stub.test');
          assert.equal(url.searchParams.get('q'), 'First live');
          assert.equal(url.searchParams.get('botId'), BOT_ID);
          assert.equal(url.searchParams.get('limit'), '20');
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('a cursor page appends behind its footer, then the footer goes', async () => {
        stub.setMode('paged-artifacts');
        stub.clearRequests();
        // The stub's answer is held so the in-flight state is observable, not raced.
        stub.setDelay(400);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          const artifacts = artifactsSection(page);
          const loadMore = artifacts.getByRole('button', { name: 'Load more artifacts' });
          await loadMore.waitFor({ state: 'visible' });

          // Page one ends with a cursor, so the footer says so.
          assert.ok(
            (await bodyText(artifacts)).includes('More results are available.'),
            'a page with a nextCursor did not offer another page',
          );

          await loadMore.click();
          await page
            .getByText('Loading more artifacts…', { exact: true })
            .waitFor({ state: 'visible', timeout: 5_000 });

          // In flight: busy, disabled, and announced politely.
          assert.equal(
            await loadMore.getAttribute('aria-busy'),
            'true',
            'the in-flight footer control was not busy',
          );
          assert.equal(
            await loadMore.isDisabled(),
            true,
            'the in-flight footer control was still clickable',
          );

          const before = await readPanelScroll(page);
          assert.ok(before !== undefined, 'the panel has no scrolling body');

          await page
            .getByRole('button', { name: /Second ordering note/ })
            .waitFor({ state: 'visible', timeout: 10_000 });

          // Appended, not replaced: the first row, its selection and the body the
          // reader had open are all still there, and the panel did not jump back
          // to the top.
          assert.equal(
            await page.locator('button[aria-current="true"]').filter({ hasText: 'Ordering note' }).count(),
            1,
            'paging replaced the selected row',
          );
          assert.equal(
            await artifacts.getByLabel('Artifact content').inputValue(),
            '# Ordering note\n\nThe cursor is the sequence, not the clock.',
            'paging replaced the open artifact',
          );

          const after = await readPanelScroll(page);
          assert.ok(after !== undefined, 'the panel lost its scrolling body');
          assert.equal(
            await artifacts.locator('ul').first().getByRole('button').count(),
            2,
            'the next cursor page was not appended to the list',
          );
          assert.ok(
            after.top >= before.top && after.top > 0,
            `the panel lost its reading position (${before.top} → ${after.top})`,
          );

          // Page two has `nextCursor: null`, so the footer is gone entirely.
          assert.equal(
            await artifacts.getByRole('button', { name: 'Load more artifacts' }).count(),
            0,
            'the footer survived a page with no nextCursor',
          );
          assert.ok(
            !(await bodyText(artifacts)).includes('More results are available.'),
            'the footer copy survived a page with no nextCursor',
          );

          const lists = stub.requests.filter(
            (entry) => entry.method === 'GET' && entry.url.startsWith('/api/artifacts?'),
          );
          assert.equal(lists.length, 2, 'the list was not read once per cursor page');
          const second = new URL(lists[1].url, 'http://stub.test');
          assert.equal(second.searchParams.get('cursor'), 'artifacts-page-2');
          assert.equal(second.searchParams.get('conversationId'), THREAD_ID);
        } finally {
          stub.setDelay(0);
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });
    });

    describe('artifact writing', () => {
      test('creating an artifact posts the body and the row follows the answer', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        // Held so the in-flight state is asserted instead of raced.
        stub.setDelay(800);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          const artifacts = artifactsSection(page);
          await artifacts.getByRole('button', { name: 'New artifact' }).click();

          const form = artifacts.locator('form').filter({ hasText: 'Create an artifact' });
          await form.waitFor({ state: 'visible' });

          const title = 'Created from the browser';
          const content = 'A new body, written in the browser.';

          await form.getByLabel('Title', { exact: true }).fill(title);
          await form.getByLabel('Kind', { exact: true }).selectOption('text');
          await form.getByLabel('Content', { exact: true }).fill(content);

          const submit = form.getByRole('button', { name: 'Create artifact' });
          assert.equal(await submit.isDisabled(), false, 'a complete create form was not savable');

          await submit.click();
          await form
            .locator('button[type="submit"][aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          // While the write is in flight the list cannot carry the record.
          assert.equal(
            await artifacts.getByRole('button', { name: title }).count(),
            0,
            'the new artifact was listed before the server answered',
          );

          await page
            .getByText(`Created “${title}” as version 1.`, { exact: false })
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 });

          await artifacts.getByRole('button', { name: title }).waitFor({ state: 'visible' });
          assert.equal(
            await artifacts
              .locator('button[aria-current="true"]')
              .filter({ hasText: title })
              .count(),
            1,
            'the created artifact was not the open record',
          );
          assert.equal(
            await artifacts.getByLabel('Artifact content').inputValue(),
            content,
            'the editor did not show the body the server stored',
          );

          const posts = stub.requests.filter(
            (entry) => entry.method === 'POST' && entry.url === '/api/artifacts',
          );
          assert.equal(posts.length, 1, 'the create did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(posts[0].body),
            { kind: 'text', title, content, conversationId: THREAD_ID },
            'the create did not carry the form and the open conversation',
          );
          assert.equal(posts[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });

      test('an over-cap body is refused before any request, and the bound is stated', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          const artifacts = artifactsSection(page);
          await artifacts.getByRole('button', { name: 'New artifact' }).click();

          const form = artifacts.locator('form').filter({ hasText: 'Create an artifact' });
          await form.waitFor({ state: 'visible' });

          await form.getByLabel('Title', { exact: true }).fill('Too much body');

          const overCap = 100 * 1024 + 1;
          const content = form.getByLabel('Content', { exact: true });
          await content.fill('x'.repeat(overCap));

          await form
            .getByText(
              'This body is 102,401 bytes. Reduce it below the 100 KB transport cap.',
              { exact: true },
            )
            .waitFor({ state: 'visible' });
          assert.ok(
            (await form.innerText()).includes(
              'Content is capped at 102,400 bytes (100 KB) per HTTP request.',
            ),
            'the form did not state the transport bound',
          );
          assert.ok(
            (await form.innerText()).includes('102,401 / 102,400 bytes'),
            'the byte counter did not show the over-cap size',
          );

          const submit = form.getByRole('button', { name: 'Create artifact' });
          assert.equal(await submit.isDisabled(), true, 'an over-cap body was offered as savable');

          // The submit handler refuses too, not only the disabled attribute.
          await form.evaluate((element) => element.requestSubmit());
          await delay(400);
          assert.equal(
            stub.requests.filter(
              (entry) => entry.method === 'POST' && entry.url === '/api/artifacts',
            ).length,
            0,
            'an over-cap body was sent anyway',
          );

          // Back under the bound, the editor is usable again.
          await content.fill('Small enough.');
          assert.equal(
            await submit.isDisabled(),
            false,
            'a body under the cap did not enable the create',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('the API 413 relay is shown and no record is invented', async () => {
        stub.setMode('artifact-413');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          const artifacts = artifactsSection(page);
          await artifacts.getByRole('button', { name: 'New artifact' }).click();

          const form = artifacts.locator('form').filter({ hasText: 'Create an artifact' });
          await form.getByLabel('Title', { exact: true }).fill('Refused by the API');
          await form
            .getByLabel('Content', { exact: true })
            .fill('A body the transport refused.');
          await form.getByRole('button', { name: 'Create artifact' }).click();

          await page
            .getByText('The request could not be sent as written.', { exact: true })
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 });

          const posts = stub.requests.filter(
            (entry) => entry.method === 'POST' && entry.url === '/api/artifacts',
          );
          assert.equal(posts.length, 1, 'the refused create was not sent exactly once');
          assert.equal(posts[0].headers['x-csrf-token'], CSRF);
          assert.equal(
            await artifacts.getByRole('button', { name: 'Refused by the API' }).count(),
            0,
            'a refused create was still listed',
          );
          assert.equal(
            await artifacts.getByRole('button', { name: 'Ordering note' }).count(),
            1,
            'the refused create disturbed the record already open',
          );
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });
    });

    describe('skill and memory writing', () => {
      test('attaching and detaching a skill posts the Bot and follows the server', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        stub.setDelay(500);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Plain verbs');

          const skills = page.locator('section[aria-labelledby="context-skills"]');
          await skills.getByText('Library', { exact: true }).waitFor({ state: 'visible' });

          const attach = skills.getByRole('button', { name: 'Attach to this bot' });
          await attach.click();
          await skills
            .locator('button[aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          // Held by the stub: the badge cannot move before the write answers.
          assert.equal(
            await skills.getByText('Attached', { exact: true }).count(),
            0,
            'the skill was marked attached before the server answered',
          );

          await skills.getByText('Attached', { exact: true }).waitFor({ state: 'visible' });
          await skills.getByRole('button', { name: 'Detach', exact: true }).waitFor();

          const attaches = stub.requests.filter(
            (entry) => entry.method === 'POST' && entry.url === `/api/skills/${SKILL_ID}/attach`,
          );
          assert.equal(attaches.length, 1, 'the attach did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(attaches[0].body),
            { botId: BOT_ID },
            'the attach did not name the Bot',
          );
          assert.equal(attaches[0].headers['x-csrf-token'], CSRF);

          await skills.getByRole('button', { name: 'Detach', exact: true }).click();
          await skills.getByText('Library', { exact: true }).waitFor({ state: 'visible' });
          await skills.getByRole('button', { name: 'Attach to this bot' }).waitFor();

          const detaches = stub.requests.filter(
            (entry) => entry.method === 'POST' && entry.url === `/api/skills/${SKILL_ID}/detach`,
          );
          assert.equal(detaches.length, 1, 'the detach did not send exactly one POST');
          assert.equal(detaches[0].body, '', 'the detach carried a body it did not need');
          assert.equal(detaches[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });

      test('creating a skill posts the form and the new skill appears after the answer', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        stub.setDelay(600);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Plain verbs');

          const skills = page.locator('section[aria-labelledby="context-skills"]');
          await skills.getByRole('button', { name: 'New skill', exact: true }).click();

          const form = skills.locator('form');
          await form.waitFor({ state: 'visible' });
          assert.ok(
            (await form.innerText()).includes('Create a skill'),
            'the panel did not open the create mode',
          );

          const name = 'Plain nouns';
          const description = 'Prefer a noun when it is the subject.';
          const bodyMarkdown = 'Name the actor, then the action.';

          await form.getByLabel('Name', { exact: true }).fill(name);
          await form.getByLabel('Description', { exact: true }).fill(description);
          await form.getByLabel('Body Markdown', { exact: true }).fill(bodyMarkdown);

          // The panel belongs to a Bot, so the create form offers the optional
          // attachment and starts it checked.
          const attach = form.getByLabel('Attach to Live Field Notes');
          assert.equal(
            await attach.isChecked(),
            true,
            'the create form did not default to attaching the skill to the open Bot',
          );

          const submit = form.getByRole('button', { name: 'Create skill' });
          assert.equal(await submit.isDisabled(), false, 'a complete skill form was not savable');

          await submit.click();
          await form
            .locator('button[type="submit"][aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          // Held by the stub: the list cannot carry a record the server has not
          // answered with yet.
          assert.equal(
            await skills.getByText(name, { exact: true }).count(),
            0,
            'the skill was listed before the server answered',
          );

          await page
            .getByText('Created “Plain nouns” as a draft. It grants no tools.', {
              exact: false,
            })
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 });

          const row = skills.locator('li').filter({ hasText: name });
          await row.waitFor({ state: 'visible' });
          assert.equal(
            await row.getByText('Attached', { exact: true }).count(),
            1,
            'the created skill did not follow the attachment the server answered with',
          );
          assert.equal(
            await skills.getByText('Plain verbs', { exact: true }).count(),
            1,
            'the create disturbed the skill already listed',
          );

          const posts = stub.requests.filter(
            (entry) => entry.method === 'POST' && entry.url === '/api/skills',
          );
          assert.equal(posts.length, 1, 'the create did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(posts[0].body),
            { name, description, bodyMarkdown, botId: BOT_ID },
            'the create did not carry the form and the attached Bot',
          );
          assert.equal(posts[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });

      test('the skill bounds are enforced before any request, and the bound is stated', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Plain verbs');

          const skills = page.locator('section[aria-labelledby="context-skills"]');
          await skills.getByRole('button', { name: 'New skill', exact: true }).click();

          const form = skills.locator('form');
          await form.waitFor({ state: 'visible' });

          const submit = form.getByRole('button', { name: 'Create skill' });
          assert.equal(
            await submit.isDisabled(),
            true,
            'an empty skill name was offered as savable',
          );

          // The name bound is the field's own: an 81st character cannot be typed.
          const name = form.getByLabel('Name', { exact: true });
          assert.equal(
            await name.getAttribute('maxlength'),
            '80',
            'the name field did not carry the 80-character bound',
          );
          assert.ok(
            (await form.innerText()).includes('1–80 characters. Names are unique per owner.'),
            'the form did not state the name bound',
          );

          await name.fill('n'.repeat(80));
          await name.press('n');
          assert.equal(
            (await name.inputValue()).length,
            80,
            'the name field accepted an 81st character',
          );

          // The body bound is measured in UTF-8 bytes and refused in the form.
          await name.fill('Too much guidance');

          const overCap = 64 * 1024 + 1;
          const body = form.getByLabel('Body Markdown', { exact: true });
          await body.fill('x'.repeat(overCap));

          await form
            .getByText(
              'This body is 65,537 bytes. The API accepts at most 65,536 bytes.',
              { exact: true },
            )
            .waitFor({ state: 'visible' });
          assert.ok(
            (await form.innerText()).includes('65,537 / 65,536 bytes'),
            'the byte counter did not show the over-cap size',
          );
          assert.equal(
            await submit.isDisabled(),
            true,
            'an over-cap skill body was offered as savable',
          );

          // The submit handler refuses too, not only the disabled attribute.
          await form.evaluate((element) => element.requestSubmit());
          await delay(400);
          assert.equal(
            stub.requests.filter(
              (entry) => entry.method === 'POST' && entry.url === '/api/skills',
            ).length,
            0,
            'a skill outside the bounds was sent anyway',
          );

          await body.fill('Small enough.');
          assert.equal(
            await submit.isDisabled(),
            false,
            'a skill inside the bounds did not enable the create',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('a proposed memory carries its text and source thread', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(
            page,
            server.origin,
            `${WORKSPACE}&panel=context`,
            'Prefers short sections over bullet dumps.',
          );

          const memory = page.locator('section[aria-labelledby="context-memory"]');
          const text = 'Keep the closing summary to one line.';

          await memory.getByLabel('Propose a memory').fill(text);
          await memory.getByRole('button', { name: 'Propose memory' }).click();

          await page
            .getByText('Memory proposed. Both gates start off, so nothing is recalled yet.', {
              exact: false,
            })
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 });

          const posts = stub.requests.filter(
            (entry) =>
              entry.method === 'POST' && entry.url === `/api/bots/${BOT_ID}/memories`,
          );
          assert.equal(posts.length, 1, 'the proposal did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(posts[0].body),
            { text, threadId: THREAD_ID },
            'the proposal did not bind the memory to the open thread',
          );
          assert.equal(posts[0].headers['x-csrf-token'], CSRF);
          assert.equal(
            await memory.getByLabel('Propose a memory').inputValue(),
            '',
            'the composer kept the submitted text',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });
    });

    describe('gallery and thread writing', () => {
      test('creating a bot posts its profile and the card follows the answer', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        stub.setDelay(800);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, '/bots', 'Live Field Notes');

          await page.getByRole('button', { name: 'Create bot', exact: true }).click();

          const form = page.locator('form').filter({ hasText: 'Instructions' });
          await form.waitFor({ state: 'visible' });

          const name = 'Second Field Notes';
          await form.getByLabel('Name', { exact: true }).fill(name);
          await form.getByLabel('Purpose', { exact: true }).fill('Keeps the second notebook.');
          await form
            .getByLabel('Instructions', { exact: true })
            .fill('Cite the second document.');

          await form.getByRole('button', { name: 'Create bot' }).click();
          await form
            .locator('button[type="submit"][aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          assert.equal(
            await page.getByRole('link', { name, exact: false }).count(),
            0,
            'the card was rendered before the server answered',
          );

          await page.getByRole('link', { name, exact: false }).waitFor({
            state: 'visible',
            timeout: 15_000,
          });

          const posts = stub.requests.filter(
            (entry) => entry.method === 'POST' && entry.url === '/api/bots',
          );
          assert.equal(posts.length, 1, 'the create did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(posts[0].body),
            {
              name,
              description: 'Keeps the second notebook.',
              instructionsMarkdown: 'Cite the second document.',
            },
            'the create did not carry the form fields',
          );
          assert.equal(posts[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });

      test('creating a thread posts its title and opens the thread the server returned', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        stub.setDelay(600);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          const threads = page.locator('section[aria-labelledby="bot-threads-title"]');
          await threads.getByRole('button', { name: 'New thread', exact: true }).click();

          const form = page.locator('form').filter({ hasText: 'Thread title' });
          await form.getByLabel('Thread title').fill('Ordered by the browser');
          await form.getByRole('button', { name: 'Create thread' }).click();
          await form
            .locator('button[type="submit"][aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          // Held by the stub: no navigation and no row before the write answers.
          assert.equal(
            new URL(page.url()).searchParams.get('thread'),
            THREAD_ID,
            'the workspace moved before the server answered',
          );
          assert.equal(
            await page.getByRole('link', { name: 'Ordered by the browser' }).count(),
            0,
            'the thread row appeared before the server answered',
          );

          await page.waitForURL(new RegExp(`thread=${NEW_THREAD_ID}`), { timeout: 15_000 });
          await page.getByRole('link', { name: 'Ordered by the browser' }).waitFor({
            state: 'visible',
          });

          const posts = stub.requests.filter(
            (entry) =>
              entry.method === 'POST' && entry.url === `/api/bots/${BOT_ID}/threads`,
          );
          assert.equal(posts.length, 1, 'the create did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(posts[0].body),
            { title: 'Ordered by the browser' },
            'the create did not carry the title',
          );
          assert.equal(posts[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });

      test('the header create action sends no title and opens the server-named thread', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          // Two real affordances: the header creates immediately, the Threads
          // card opens the titled form. The header's precedes it in the DOM.
          const newThread = page.getByRole('button', { name: 'New thread', exact: true });
          assert.equal(
            await newThread.count(),
            2,
            'the workspace did not offer both create-thread actions',
          );

          await newThread.first().click();
          await page.waitForURL(new RegExp(`thread=${NEW_THREAD_ID}`), { timeout: 15_000 });
          await page.getByRole('link', { name: 'New conversation' }).waitFor({
            state: 'visible',
          });

          const posts = stub.requests.filter(
            (entry) =>
              entry.method === 'POST' && entry.url === `/api/bots/${BOT_ID}/threads`,
          );
          assert.equal(posts.length, 1, 'the create did not send exactly one POST');
          assert.deepEqual(
            JSON.parse(posts[0].body),
            {},
            'a create without a title invented one instead of letting the server name it',
          );
          assert.equal(posts[0].headers['x-csrf-token'], CSRF);
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('renaming a thread posts the changed title and the row follows the server', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        stub.setDelay(600);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          const threads = page.locator('section[aria-labelledby="bot-threads-title"]');
          await threads.getByRole('button', { name: 'Rename', exact: true }).click();

          const form = page.locator('form').filter({ hasText: 'Rename thread' });
          const title = form.getByLabel('Rename thread');
          assert.equal(
            await title.inputValue(),
            'Live thread about ordering',
            'the rename form was not prefilled',
          );

          await title.fill('Ordering, renamed');
          await form.getByRole('button', { name: 'Save title' }).click();
          await form
            .locator('button[type="submit"][aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          assert.equal(
            await page.getByRole('link', { name: 'Ordering, renamed' }).count(),
            0,
            'the row changed before the server answered',
          );

          await page.getByRole('link', { name: 'Ordering, renamed' }).waitFor({
            state: 'visible',
            timeout: 15_000,
          });
          await page.getByText('Thread renamed.', { exact: true }).waitFor({
            state: 'visible',
          });

          const patches = stub.requests.filter(
            (entry) =>
              entry.method === 'PATCH' && entry.url === `/api/threads/${THREAD_ID}`,
          );
          assert.equal(patches.length, 1, 'the rename did not send exactly one PATCH');
          assert.deepEqual(
            JSON.parse(patches[0].body),
            { title: 'Ordering, renamed' },
            'the rename did not carry the new title',
          );
          assert.equal(patches[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });

      test('editing a bot from the gallery patches the profile and the card follows the server', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        stub.setDelay(700);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, '/bots', 'Live Field Notes');

          await page.getByRole('button', { name: 'Edit bot', exact: true }).click();

          const form = page.locator('form').filter({ hasText: 'Instructions' });
          await form.waitFor({ state: 'visible' });

          // The edit card reads the profile before it opens, so all three
          // fields are the API's text rather than the gallery's summary line.
          assert.equal(
            await form.getByLabel('Name', { exact: true }).inputValue(),
            'Live Field Notes',
            'the edit form was not prefilled from the profile read',
          );
          assert.equal(
            await form.getByLabel('Purpose', { exact: true }).inputValue(),
            'Reads what you attach.',
            'the purpose was not prefilled from the profile read',
          );
          assert.equal(
            await form.getByLabel('Instructions', { exact: true }).inputValue(),
            'Cite the document.',
            'the instructions were not prefilled from the profile read',
          );

          const name = 'Field Notes, edited';
          const purpose = 'Reads only the edited notes.';

          await form.getByLabel('Name', { exact: true }).fill(name);
          await form.getByLabel('Purpose', { exact: true }).fill(purpose);
          await form.getByRole('button', { name: 'Save changes' }).click();
          await form
            .locator('button[type="submit"][aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          // Held by the stub: the card cannot take the draft name before the
          // answer, and it keeps the name the server still serves.
          assert.equal(
            await page.getByRole('link', { name, exact: false }).count(),
            0,
            'the card took the draft name before the server answered',
          );
          assert.ok(
            (await bodyText(page)).includes('Live Field Notes'),
            'the card left its served name before the answer',
          );

          await page.getByRole('link', { name, exact: false }).waitFor({
            state: 'visible',
            timeout: 15_000,
          });
          await page.getByText(purpose, { exact: true }).first().waitFor({ state: 'visible' });
          await form.waitFor({ state: 'detached' });

          const patches = stub.requests.filter(
            (entry) => entry.method === 'PATCH' && entry.url === `/api/bots/${BOT_ID}`,
          );
          assert.equal(patches.length, 1, 'the edit did not send exactly one PATCH');
          assert.deepEqual(
            JSON.parse(patches[0].body),
            { name, description: purpose, instructionsMarkdown: 'Cite the document.' },
            'the edit form sends all three profile fields, including the unchanged instructions',
          );
          assert.equal(patches[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });

      test('a no-change bot edit is still offered and sends the prefilled profile', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, '/bots', 'Live Field Notes');

          await page.getByRole('button', { name: 'Edit bot', exact: true }).click();

          const form = page.locator('form').filter({ hasText: 'Instructions' });
          await form.waitFor({ state: 'visible' });

          // The edit form validates the name, not the difference: submitting an
          // unchanged profile is offered and writes the fields it was given.
          const submit = form.getByRole('button', { name: 'Save changes' });
          assert.equal(
            await submit.isDisabled(),
            false,
            'the edit form blocked a submit it does not diff',
          );

          await submit.click();
          await form.waitFor({ state: 'detached', timeout: 15_000 });

          const patches = stub.requests.filter(
            (entry) => entry.method === 'PATCH' && entry.url === `/api/bots/${BOT_ID}`,
          );
          assert.equal(patches.length, 1, 'the no-change edit did not send exactly one PATCH');
          assert.deepEqual(
            JSON.parse(patches[0].body),
            {
              name: 'Live Field Notes',
              description: 'Reads what you attach.',
              instructionsMarkdown: 'Cite the document.',
            },
            'the no-change edit sent fields that were not the prefilled profile',
          );
          assert.equal(patches[0].headers['x-csrf-token'], CSRF);
          assert.equal(
            await page.getByRole('link', { name: 'Live Field Notes', exact: false }).count(),
            1,
            'the no-change edit removed or duplicated the card',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('editing a bot from the workspace refreshes the identity from the server', async () => {
        stub.setMode('ok');
        stub.clearRequests();
        stub.setDelay(600);

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          await page.getByRole('button', { name: 'Edit bot', exact: true }).click();

          const form = page.locator('form').filter({ hasText: 'Instructions' });
          await form.waitFor({ state: 'visible' });

          assert.equal(
            await form.getByLabel('Instructions', { exact: true }).inputValue(),
            'Cite the document.',
            'the edit form did not hold the instructions the page already rendered',
          );

          const name = 'Workspace Notes';
          const purpose = 'Reads the workspace notes.';
          const instructions = 'Cite the workspace document.';

          await form.getByLabel('Name', { exact: true }).fill(name);
          await form.getByLabel('Purpose', { exact: true }).fill(purpose);
          await form.getByLabel('Instructions', { exact: true }).fill(instructions);
          await form.getByRole('button', { name: 'Save changes' }).click();
          await form
            .locator('button[type="submit"][aria-busy="true"]')
            .waitFor({ state: 'attached', timeout: 5_000 });

          // Held by the stub: the identity heading keeps the served name.
          assert.equal(
            await page.getByRole('heading', { level: 1, name, exact: true }).count(),
            0,
            'the identity took the draft name before the server answered',
          );
          await page
            .getByRole('heading', { level: 1, name: 'Live Field Notes', exact: true })
            .waitFor({ state: 'visible' });

          await page.getByRole('heading', { level: 1, name, exact: true }).waitFor({
            state: 'visible',
            timeout: 15_000,
          });

          // The refreshed page remounts the form with the server's profile.
          assert.equal(
            await form.getByLabel('Name', { exact: true }).inputValue(),
            name,
            'the open edit form did not re-prefill from the refreshed profile',
          );

          const patches = stub.requests.filter(
            (entry) => entry.method === 'PATCH' && entry.url === `/api/bots/${BOT_ID}`,
          );
          assert.equal(patches.length, 1, 'the edit did not send exactly one PATCH');
          assert.deepEqual(
            JSON.parse(patches[0].body),
            { name, description: purpose, instructionsMarkdown: instructions },
            'the workspace edit did not carry the changed profile',
          );
          assert.equal(patches[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setDelay(0);
          await page.close();
          await context.close();
        }
      });
    });

    describe('cursor footers', () => {
      test('the skills footer loads one cursor page, then goes', async () => {
        stub.setMode('paged-skills');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Plain verbs');

          const skills = page.locator('section[aria-labelledby="context-skills"]');
          const loadMore = skills.getByRole('button', { name: 'Load more skills' });
          await loadMore.waitFor({ state: 'visible' });
          assert.ok(
            (await skills.innerText()).includes('More results are available.'),
            'a page with a nextCursor did not offer another page',
          );

          await loadMore.click();
          await skills.getByText('Short sentences', { exact: true }).waitFor({
            state: 'visible',
            timeout: 15_000,
          });

          assert.ok(
            (await skills.innerText()).includes('Plain verbs'),
            'the next page replaced the first one',
          );
          assert.equal(
            await skills.getByRole('button', { name: 'Load more skills' }).count(),
            0,
            'the footer survived a page with no nextCursor',
          );

          const lists = stub.requests.filter(
            (entry) => entry.method === 'GET' && entry.url.startsWith('/api/skills?'),
          );
          assert.equal(lists.length, 2, 'the list was not read once per cursor page');
          const second = new URL(lists[1].url, 'http://stub.test');
          assert.equal(second.searchParams.get('cursor'), 'skills-page-2');
          assert.equal(second.searchParams.get('limit'), '20');
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });

      test('the memories footer loads one cursor page, then goes', async () => {
        stub.setMode('paged-memories');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(
            page,
            server.origin,
            `${WORKSPACE}&panel=context`,
            'Prefers short sections over bullet dumps.',
          );

          const memory = page.locator('section[aria-labelledby="context-memory"]');
          const loadMore = memory.getByRole('button', { name: 'Load more memories' });
          await loadMore.waitFor({ state: 'visible' });

          await loadMore.click();
          await memory
            .getByText('Wants a one-line summary at the end of long replies.', {
              exact: true,
            })
            .waitFor({ state: 'visible', timeout: 15_000 });

          assert.equal(
            await memory.getByRole('checkbox').count(),
            4,
            'the second memory page was not appended with its gates',
          );
          assert.equal(
            await memory.getByRole('button', { name: 'Load more memories' }).count(),
            0,
            'the footer survived a page with no nextCursor',
          );

          const pages = stub.requests.filter(
            (entry) =>
              entry.method === 'GET' &&
              entry.url.startsWith(`/api/bots/${BOT_ID}/memories`),
          );
          const paged = pages.filter(
            (entry) =>
              new URL(entry.url, 'http://stub.test').searchParams.get('cursor') ===
              'memories-page-2',
          );
          assert.equal(paged.length, 1, 'the next page was not requested with its cursor');
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });

      test('the versions footer loads one older page, then goes', async () => {
        stub.setMode('paged-versions');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Ordering note');

          const artifacts = artifactsSection(page);
          const loadMore = artifacts.getByRole('button', { name: 'Load older versions' });
          await loadMore.waitFor({ state: 'visible' });

          assert.equal(
            await artifacts.getByText(/^v2 ·/).count(),
            1,
            'the head version was not listed',
          );
          assert.equal(
            await artifacts.getByText(/^v1 ·/).count(),
            0,
            'the next version page was already listed',
          );

          await loadMore.click();
          await artifacts.getByText(/^v1 ·/).first().waitFor({
            state: 'visible',
            timeout: 15_000,
          });

          assert.equal(
            await artifacts.getByText(/^v2 ·/).count(),
            1,
            'the next page replaced the head version',
          );
          assert.equal(
            await artifacts.getByRole('button', { name: 'Load older versions' }).count(),
            0,
            'the footer survived a page with no nextCursor',
          );
          assert.equal(
            await artifacts.getByLabel('Artifact content').inputValue(),
            '# Ordering note\n\nThe cursor is the sequence, not the clock.',
            'paging the versions changed the open body',
          );

          const pages = stub.requests.filter(
            (entry) =>
              entry.method === 'GET' &&
              entry.url.startsWith(`/api/artifacts/${ARTIFACT_ID}/versions?`),
          );
          const paged = pages.filter(
            (entry) =>
              new URL(entry.url, 'http://stub.test').searchParams.get('cursor') ===
              'versions-page-2',
          );
          assert.equal(paged.length, 1, 'the older page was not requested with its cursor');
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });

      test('the search footer loads one cursor page, then goes', async () => {
        stub.setMode('paged-search');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, `${WORKSPACE}&panel=context`, 'Plain verbs');

          const search = page.locator('section[aria-labelledby="context-search"]');
          await search.getByLabel('Search this account').fill('First live');
          await search.getByRole('button', { name: 'Search messages' }).click();

          const loadMore = search.getByRole('button', { name: 'Load more results' });
          await loadMore.waitFor({ state: 'visible' });
          await search
            .getByRole('link', { name: 'Live thread about ordering' })
            .first()
            .waitFor({ state: 'visible' });

          await loadMore.click();
          await search
            .getByRole('link', { name: 'Live thread about ordering' })
            .nth(1)
            .waitFor({ state: 'visible', timeout: 15_000 });

          assert.equal(
            await search.locator('li').count(),
            2,
            'the next hit page was not appended',
          );
          assert.equal(
            await search.locator('li').nth(1).locator('mark').textContent(),
            'live',
            'the second hit did not render its escaped mark',
          );
          assert.equal(
            await search.getByRole('button', { name: 'Load more results' }).count(),
            0,
            'the footer survived a page with no nextCursor',
          );

          const calls = stub.requests.filter(
            (entry) => entry.method === 'GET' && entry.url.startsWith('/api/search?'),
          );
          assert.equal(calls.length, 2, 'the search was not read once per cursor page');
          const second = new URL(calls[1].url, 'http://stub.test');
          assert.equal(second.searchParams.get('cursor'), 'search-page-2');
          assert.equal(second.searchParams.get('q'), 'First live');
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });
    });

    describe('streaming', () => {
      test('a sent message renders the streamed reply and the completed run', async () => {
        stub.setMode('ok');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          await page
            .getByLabel('Write a message to Live Field Notes')
            .fill('What does the cursor mean?');
          await page.getByRole('button', { name: 'Send message' }).click();

          await page
            .getByText('Streamed reply.', { exact: true })
            .first()
            .waitFor({ state: 'visible' });
          await page
            .getByText(`Run ${RUN_ID} · complete`, { exact: true })
            .first()
            .waitFor({ state: 'visible' });

          const stream = stub.requests.find(
            (entry) => entry.method === 'GET' && entry.url === `/api/runs/${RUN_ID}/events`,
          );
          assert.ok(stream, 'the browser never opened the run event stream');
          assert.equal(
            stream.headers['last-event-id'],
            undefined,
            'the first stream connection carried a resume cursor',
          );

          const sent = stub.requests.find(
            (entry) =>
              entry.method === 'POST' && entry.url === `/api/threads/${THREAD_ID}/messages`,
          );
          assert.ok(sent, 'the browser never sent the message');
          assert.equal(sent.headers['x-csrf-token'], CSRF);
          assert.equal(JSON.parse(sent.body).content, 'What does the cursor mean?');

          assertNoSampleCopy(await bodyText(page), 'streamed workspace');
        } finally {
          await page.close();
          await context.close();
        }
      });

      test('a dropped event stream resumes from the last id, then completes', async () => {
        stub.setMode('stream-drop');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          await page
            .getByLabel('Write a message to Live Field Notes')
            .fill('Resume this stream');
          await page.getByRole('button', { name: 'Send message' }).click();

          await page
            .getByText(`Run ${RUN_ID} · complete`, { exact: true })
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 });

          const streams = stub.requests.filter(
            (entry) => entry.method === 'GET' && entry.url === `/api/runs/${RUN_ID}/events`,
          );
          assert.equal(streams.length, 2, 'the dropped stream was not reopened exactly once');
          assert.equal(
            streams[0].headers['last-event-id'],
            undefined,
            'the first connection carried a cursor it could not have',
          );
          assert.equal(
            streams[1].headers['last-event-id'],
            `e1.${RUN_ID}.4`,
            'the reconnect did not resume from the last applied frame id',
          );
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });

      test(
        'a stream that never resumes exhausts five connections into the Retry state',
        { timeout: 90_000 },
        async () => {
          stub.setMode('stream-exhaust');
          stub.clearRequests();

          const context = await openContext(browser, {
            origin: server.origin,
            width: 1440,
            height: 1000,
            theme: 'light',
            session: SESSION,
            csrf: true,
          });
          const page = await context.newPage();

          try {
            await gotoLive(page, server.origin, WORKSPACE, 'First live question');

            await page
              .getByLabel('Write a message to Live Field Notes')
              .fill('Exhaust this stream');

            const started = Date.now();
            await page.getByRole('button', { name: 'Send message' }).click();

            // Deliberately slow but real: the product's backoff is
            // 400 + 800 + 1600 + 3200 ms, and shortening it would mean editing
            // product code. This waits the real ~6 s instead.
            await page
              .getByText(
                'The run stream stopped and could not be resumed. Retry to reconnect with the last sequence this tab saw.',
                { exact: true },
              )
              .first()
              .waitFor({ state: 'visible', timeout: 30_000 });
            const elapsed = Date.now() - started;

            assert.ok(
              elapsed >= 5_900,
              `the bounded retries did not wait their backoff (${elapsed} ms)`,
            );

            // One initial connection plus MAX_RECONNECTS = 4 in
            // `app/bots/[botId]/use-live-run.ts`: five attempts, not "some".
            const streams = stub.requests.filter(
              (entry) => entry.method === 'GET' && entry.url === `/api/runs/${RUN_ID}/events`,
            );
            assert.equal(
              streams.length,
              5,
              `the terminal state arrived after ${streams.length} connections, not the documented five`,
            );
            assert.deepEqual(
              streams.map((entry) => entry.headers['last-event-id']),
              [
                undefined,
                `e1.${RUN_ID}.4`,
                `e1.${RUN_ID}.5`,
                `e1.${RUN_ID}.6`,
                `e1.${RUN_ID}.7`,
              ],
              'a reconnect did not resume from the last applied frame id',
            );

            // Every delta the stub wrote before the terminal state is still
            // rendered, in order: the failure is not allowed to drop text.
            const text = await bodyText(page);
            assert.ok(
              text.includes('attempt 1 attempt 2 attempt 3 attempt 4 attempt 5'),
              `the streamed text was lost or reordered: ${text}`,
            );
            assert.ok(text.includes('Exhaust this stream'), 'the sent turn disappeared');

            const retry = page.getByRole('button', { name: 'Retry', exact: true });
            await retry.waitFor({ state: 'visible' });
            assert.equal(
              await retry.isEnabled(),
              true,
              'the retry affordance is present but cannot be used',
            );

            // Not falsely terminal: no completed run and no completed reply.
            assert.equal(
              await page.getByText(`Run ${RUN_ID} · complete`, { exact: true }).count(),
              0,
              'the exhausted stream was marked complete',
            );
            assert.ok(
              !text.includes('Reply complete.'),
              'the exhausted stream claimed the reply completed',
            );
          } finally {
            stub.setMode('ok');
            await page.close();
            await context.close();
          }
        },
      );

      test('Stop run posts one cancel and shows the stopped state the server returned', async () => {
        stub.setMode('stream-hold');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          await page
            .getByLabel('Write a message to Live Field Notes')
            .fill('Stop this run');
          await page.getByRole('button', { name: 'Send message' }).click();

          // The stub holds the stream open after one delta, so the run is live.
          const stop = page.getByRole('button', { name: 'Stop run' });
          await stop.waitFor({ state: 'visible', timeout: 15_000 });

          assert.equal(
            await page.getByText(`Run ${RUN_ID} · stopped`, { exact: true }).count(),
            0,
            'the run was labelled stopped before the cancel answered',
          );

          await stop.click();

          await page
            .getByText(`Run ${RUN_ID} · stopped`, { exact: true })
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 });
          await page
            .getByText('Run stopped before it was dispatched. The reply will not continue.', {
              exact: true,
            })
            .first()
            .waitFor({ state: 'visible' });

          const cancels = stub.requests.filter(
            (entry) =>
              entry.method === 'POST' && entry.url === `/api/runs/${RUN_ID}/cancel`,
          );
          assert.equal(cancels.length, 1, 'the stop did not send exactly one POST');
          assert.equal(cancels[0].headers['x-csrf-token'], CSRF);
          assert.equal(cancels[0].body, '', 'the cancel carried a body it did not need');

          // The delta that arrived before the stop is still in the transcript.
          assert.ok(
            (await bodyText(page)).includes('Streaming'),
            'the text streamed before the stop was dropped',
          );
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });

      test('a cancel the server refuses keeps the terminal state it answered', async () => {
        stub.setMode('stream-hold-terminal');
        stub.clearRequests();

        const context = await openContext(browser, {
          origin: server.origin,
          width: 1440,
          height: 1000,
          theme: 'light',
          session: SESSION,
          csrf: true,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, WORKSPACE, 'First live question');

          await page
            .getByLabel('Write a message to Live Field Notes')
            .fill('Stop an already-finished run');
          await page.getByRole('button', { name: 'Send message' }).click();

          const stop = page.getByRole('button', { name: 'Stop run' });
          await stop.waitFor({ state: 'visible', timeout: 15_000 });
          await stop.click();

          // The server's answer is a finished run, not a cancel; the client must
          // show that instead of claiming the stop it asked for.
          await page
            .getByText('The run is already terminal; it was not changed.', { exact: true })
            .first()
            .waitFor({ state: 'visible', timeout: 15_000 });
          await page
            .getByText(`Run ${RUN_ID} · complete`, { exact: true })
            .first()
            .waitFor({ state: 'visible' });
          assert.equal(
            await page.getByText(`Run ${RUN_ID} · stopped`, { exact: true }).count(),
            0,
            'a refused cancel was labelled stopped',
          );
          assert.equal(
            await page
              .getByText(
                'Run stopped before it was dispatched. The reply will not continue.',
                { exact: true },
              )
              .count(),
            0,
            'a refused cancel claimed the run stopped',
          );

          const cancels = stub.requests.filter(
            (entry) =>
              entry.method === 'POST' && entry.url === `/api/runs/${RUN_ID}/cancel`,
          );
          assert.equal(cancels.length, 1, 'the stop did not send exactly one POST');
          assert.equal(cancels[0].headers['x-csrf-token'], CSRF);
        } finally {
          stub.setMode('ok');
          await page.close();
          await context.close();
        }
      });
    });
  },
);

describe(
  'invalid HABI_API_URL in Chromium',
  { skip: browserSkip, timeout: 180_000 },
  () => {
    let server;
    let browser;

    before(async () => {
      server = await bootNext({ HABI_API_URL: 'not a usable api address' });
      browser = await chromium.launch();
    }, { timeout: 90_000 });

    after(async () => {
      await browser?.close();
      await server?.stop();
    }, { timeout: 30_000 });

    for (const [label, width, height, theme] of [
      ['320 light', 320, 760, 'light'],
      ['1440 dark', 1440, 1000, 'dark'],
    ]) {
      test(`${label}: configuration error, not the preview`, async () => {
        const context = await openContext(browser, {
          origin: server.origin,
          width,
          height,
          theme,
          session: SESSION,
        });
        const page = await context.newPage();

        try {
          await gotoLive(page, server.origin, '/bots', 'The chat API address is not valid');

          const text = await bodyText(page);
          assert.ok(
            text.includes('The sample preview is not shown while an API is configured.'),
            'the configuration error did not explain the boundary',
          );
          assertNoSampleCopy(text, 'invalid config gallery');

          await gotoLive(page, server.origin, '/threads', 'The chat API address is not valid');
          await gotoLive(
            page,
            server.origin,
            WORKSPACE,
            'The chat API address is not valid',
          );

          await gotoLive(
            page,
            server.origin,
            '/account',
            'The account API address is not valid',
          );
          const accountText = await bodyText(page);
          assert.ok(
            accountText.includes('Fix the server-side API configuration.'),
            'the account page did not render the configuration error',
          );
          assertNoSampleCopy(accountText, 'invalid config account');

          assert.equal(
            await page.getByText('Preview', { exact: true }).count(),
            0,
            'the configuration error rendered the Preview marker',
          );
        } finally {
          await page.close();
          await context.close();
        }
      });
    }
  },
);
