import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const distModuleUrl = new URL('../dist/index.js', import.meta.url);
const distTypesUrl = new URL('../dist/index.d.ts', import.meta.url);

test('contract package resolves from built dist as an empty ESM module', async () => {
  await access(distModuleUrl);

  const contractModule = await import(distModuleUrl.href);

  assert.equal(typeof contractModule, 'object');
  assert.equal('HealthResponse' in contractModule, false);
});

test('contract declarations expose the exact health shape', async () => {
  const declarations = await readFile(distTypesUrl, 'utf8');

  assert.match(declarations, /interface HealthResponse/);
  assert.match(declarations, /status: 'ok'/);
  assert.match(declarations, /service: 'api'/);
});
