import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('base tsconfig is valid strict Node ESM JSON', async () => {
  const raw = await readFile(
    new URL('../tsconfig/base.json', import.meta.url),
    'utf8',
  );
  const config = JSON.parse(raw);

  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.module, 'NodeNext');
  assert.equal(config.compilerOptions.moduleResolution, 'NodeNext');
  assert.equal(config.compilerOptions.verbatimModuleSyntax, true);
});

test('eslint base exports a flat config array', async () => {
  const { default: base } = await import('../eslint/base.mjs');

  assert.ok(Array.isArray(base));
  assert.ok(base.length > 0);
});
