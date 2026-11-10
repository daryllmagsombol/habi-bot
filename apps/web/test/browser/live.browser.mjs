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
 *   streaming    a sent message renders the streamed reply the stub wrote, and a
 *                dropped stream reconnects from its last `id:`
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
    stop: () => new Promise((resolve) => stub.server.close(resolve)),
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
