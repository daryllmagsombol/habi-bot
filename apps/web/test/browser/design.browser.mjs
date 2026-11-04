/**
 * Design verification in a real browser.
 *
 * The shell, the gallery, the thread workspace, both evidence panels, and the
 * identity screens are held to the design's stated boundaries at 320×760,
 * 768×1000, and 1440×1000 in light and dark:
 *
 *   layout      no horizontal overflow (`scrollWidth === clientWidth`)
 *   structure   exactly one h1, no skipped heading levels
 *   contrast    >= 4.5:1 for text, >= 3:1 for large text, measured from
 *               computed styles against the nearest opaque ancestor surface
 *   targets     every control at least 44px tall, except inline text links
 *               (WCAG 2.5.8) and form labels, which are the checkbox target
 *   theme       the OS preference resolves with no stored choice; a toggle
 *               writes `habi-theme` and applies it before content on reload
 *   keyboard    the skip link is first on /bots; the panel control is
 *               reachable by Tab and changes `?panel=`
 *   boundary    an unknown Bot renders the not-found copy, not the error page
 *
 * The built app is booted once (`next start` on an ephemeral port) and shared,
 * as is one Chromium instance. Browsers are never downloaded here: when the
 * Chromium build Playwright expects is missing, the whole suite skips with the
 * install command, the same way the Docker-backed suites skip.
 *
 * Run `pnpm --filter @habi/web build` first. No screenshot is written or kept.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
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
  readBoundary,
  readFocus,
  readThemeState,
  readThemeTimeline,
  recordThemeTimeline,
} from './probes.mjs';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../../', import.meta.url));

const WORKSPACE = '/bots/field-notes?thread=run-ordering';

const ROUTES = [
  { label: 'home /', path: '/' },
  { label: 'Bot gallery /bots', path: '/bots' },
  { label: 'thread index /threads', path: '/threads' },
  { label: 'thread workspace', path: WORKSPACE },
  { label: 'Document panel', path: `${WORKSPACE}&panel=document` },
  { label: 'Document panel, no attachment', path: '/bots/draft-partner?thread=boundary-note&panel=document' },
  { label: 'Context panel', path: `${WORKSPACE}&panel=context` },
  { label: 'login /login', path: '/login' },
  { label: 'signup /signup', path: '/signup' },
  { label: 'identity landing /start', path: '/start' },
  { label: 'recovery /recovery', path: '/recovery' },
];

const VIEWPORTS = [
  { width: 320, height: 760 },
  { width: 768, height: 1000 },
  { width: 1440, height: 1000 },
];

const THEMES = ['light', 'dark'];

const EXPECTED = {
  light: { canvasToken: '#fbfaf6', bodyBackground: 'rgb(251, 250, 246)' },
  dark: { canvasToken: '#141317', bodyBackground: 'rgb(20, 19, 23)' },
};

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

async function bootNext() {
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

describe(
  'design verification in Chromium',
  { skip: browserSkip, timeout: 300_000 },
  () => {
    let server;
    let browser;

    before(async () => {
      server = await bootNext();
      browser = await chromium.launch();
    }, { timeout: 60_000 });

    after(async () => {
      await browser?.close();
      await server?.stop();
    }, { timeout: 30_000 });

    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        describe(`${viewport.width}×${viewport.height} · ${theme}`, () => {
          let context;

          before(async () => {
            context = await browser.newContext({
              viewport,
              colorScheme: theme,
              reducedMotion: 'reduce',
            });
          });

          after(async () => {
            await context?.close();
          });

          for (const route of ROUTES) {
            test(route.label, { timeout: 45_000 }, async () => {
              const page = await context.newPage();
              const label = `${viewport.width}×${viewport.height} ${theme} ${route.path}`;

              try {
                const response = await page.goto(`${server.origin}${route.path}`, {
                  waitUntil: 'load',
                });

                assert.equal(response?.status(), 200, `${label}: unexpected status`);
                await page.waitForSelector('main', { state: 'visible' });
                await page.evaluate(async () => {
                  await document.fonts.ready;
                });

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

                const headings = (await page.evaluate(auditHeadings)).filter(
                  (heading) => heading.visible,
                );
                const h1s = headings.filter((heading) => heading.level === 1);
                assert.equal(h1s.length, 1, `${label}: expected one visible h1, found ${JSON.stringify(headings)}`);
                assert.ok(headings.length > 0, `${label}: no visible headings`);
                assert.equal(headings[0].level, 1, `${label}: the first heading is not an h1`);

                for (let index = 1; index < headings.length; index += 1) {
                  const previous = headings[index - 1];
                  const current = headings[index];
                  assert.ok(
                    current.level <= previous.level + 1,
                    `${label}: heading level skipped from h${previous.level} "${previous.text}" to h${current.level} "${current.text}"`,
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
                assert.deepEqual(
                  targets.violations,
                  [],
                  `${label}: interactive targets below 44px tall`,
                );
              } finally {
                await page.close();
              }
            });
          }
        });
      }
    }

    test('dark mode resolves from prefers-color-scheme with no stored choice', async () => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      try {
        await page.goto(`${server.origin}/bots`, { waitUntil: 'load' });
        const state = await page.evaluate(readThemeState);

        assert.equal(state.mediaDark, true);
        assert.equal(state.attribute, null);
        assert.equal(state.storedTheme, null);
        assert.equal(state.canvasToken, EXPECTED.dark.canvasToken);
        assert.equal(
          normalizeColor(state.bodyBackground),
          normalizeColor(EXPECTED.dark.bodyBackground),
        );

        const contrast = await page.evaluate(auditContrast);
        assert.deepEqual(contrast.violations, [], 'dark palette contrast regressed');
      } finally {
        await context.close();
      }
    });

    test('the toggle writes habi-theme and survives reload before content', async () => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      try {
        await page.goto(`${server.origin}/bots`, { waitUntil: 'load' });
        const raw = await (await fetch(`${server.origin}/bots`)).text();

        const scriptIndex = raw.indexOf("localStorage.getItem('habi-theme')");
        const bodyIndex = raw.indexOf('<body');
        const mainIndex = raw.indexOf('id="main-content"');

        assert.ok(scriptIndex > bodyIndex, 'the pre-paint theme script is missing from <body>');
        assert.ok(
          scriptIndex < mainIndex,
          'the pre-paint theme script is emitted after the rendered content',
        );
        assert.match(
          raw,
          /document\.documentElement\.dataset\.theme/,
          'the pre-paint script does not apply data-theme to <html>',
        );

        const start = await page.evaluate(readThemeState);
        assert.equal(start.attribute, null, 'no choice should be applied before the toggle');
        assert.equal(start.storedTheme, null, 'no choice should be stored before the toggle');

        await page.getByRole('button', { name: 'Switch to dark theme' }).click();
        await page.waitForSelector('html[data-theme="dark"]');

        const toggled = await page.evaluate(readThemeState);
        assert.equal(toggled.attribute, 'dark');
        assert.equal(toggled.storedTheme, 'dark');
        assert.equal(
          normalizeColor(toggled.bodyBackground),
          normalizeColor(EXPECTED.dark.bodyBackground),
        );

        await page.addInitScript(recordThemeTimeline);
        await page.reload({ waitUntil: 'domcontentloaded' });

        const timeline = await page.evaluate(readThemeTimeline);
        const applied = timeline.find((entry) => entry.phase === 'mutation');
        const parsed = timeline.find((entry) => entry.phase === 'domcontentloaded');

        assert.ok(applied, 'data-theme was never written before the reloaded document parsed');
        assert.equal(applied.theme, 'dark');
        assert.equal(applied.canvasToken, EXPECTED.dark.canvasToken);
        assert.ok(parsed, 'DOMContentLoaded was not observed');
        assert.ok(
          applied.at <= parsed.at,
          `data-theme was applied after content parsed (${applied.at}ms > ${parsed.at}ms)`,
        );

        const reloaded = await page.evaluate(readThemeState);
        assert.equal(reloaded.attribute, 'dark');
        assert.equal(reloaded.storedTheme, 'dark');
        assert.equal(
          normalizeColor(reloaded.bodyBackground),
          normalizeColor(EXPECTED.dark.bodyBackground),
        );
      } finally {
        await context.close();
      }
    });

    test('keyboard reaches the skip link first and the panel control toggles ?panel=', async () => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      try {
        await page.goto(`${server.origin}/bots`, { waitUntil: 'load' });
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        await page.keyboard.press('Tab');
        const first = await page.evaluate(readFocus);

        assert.ok(first, 'nothing received focus');
        assert.equal(first.tag, 'a', 'the first tab stop is not a link');
        assert.equal(first.href, '#main-content');
        assert.equal(first.text, 'Skip to content');
        await page.waitForFunction(
          () => {
            const active = document.activeElement;
            return active !== null && active.getBoundingClientRect().top >= -1;
          },
          undefined,
          { timeout: 2000 },
        );
        const revealed = await page.evaluate(readFocus);
        assert.ok(
          revealed !== null && Math.abs(revealed.top) <= 1,
          `the focused skip link is off-screen (top ${revealed?.top})`,
        );

        await page.goto(`${server.origin}${WORKSPACE}`, { waitUntil: 'load' });
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        let reached = false;
        let focus = null;

        for (let presses = 0; presses < 15; presses += 1) {
          await page.keyboard.press('Tab');
          focus = await page.evaluate(readFocus);

          if (focus?.panelNav === true) {
            reached = true;
            break;
          }
        }

        assert.ok(reached, `the Document panel control was not reachable by Tab (${JSON.stringify(focus)})`);
        assert.equal(focus.text, 'Document');

        assert.equal(
          await page.evaluate(() => new URL(window.location.href).searchParams.get('panel')),
          null,
          'the panel opened before it was activated',
        );

        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => new URL(window.location.href).searchParams.get('panel') === 'document',
        );
        await page.waitForSelector('aside[aria-labelledby="document-panel-title"]', {
          state: 'visible',
        });

        assert.equal(
          await page.evaluate(() => new URL(window.location.href).searchParams.get('panel')),
          'document',
        );
      } finally {
        await context.close();
      }
    });

    test('an unknown Bot renders the 404 boundary, not the error page', async () => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      try {
        const response = await page.goto(`${server.origin}/bots/not-a-bot`, { waitUntil: 'load' });

        assert.equal(response?.status(), 404);
        await page.waitForSelector('h1', { state: 'visible' });

        const boundary = await page.evaluate(readBoundary);

        assert.equal(boundary.h1.length, 1, `expected one h1: ${JSON.stringify(boundary.h1)}`);
        assert.match(boundary.h1[0], /That Bot or thread is not in this preview\./);
        assert.match(boundary.text, /Back to the gallery/);
        assert.doesNotMatch(
          boundary.text,
          /Application error|This page could not be found|Internal Server Error/i,
          'the generic Next error page was rendered instead of the custom boundary',
        );
        assert.match(boundary.title, /— Habi$/, `unexpected title: ${boundary.title}`);
        assert.doesNotMatch(boundary.title, /404|error/i);
        assert.notEqual(boundary.title, 'Habi — Interface preview', 'the 404 did not set a page title');
        assert.ok(
          boundary.links.some((link) => link.href === '/bots' && link.text === 'Back to the gallery'),
          'the boundary has no way back to the gallery',
        );
      } finally {
        await context.close();
      }
    });
  },
);
