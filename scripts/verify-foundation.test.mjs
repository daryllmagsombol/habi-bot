import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  FORCED_TEST_ARGS,
  NORMAL_BUILD_ARGS,
  SANITIZED_BUILD_ARGS,
  findForbiddenDotenvFiles,
  formatForbiddenDotenvMessage,
  resolveRoot,
  sanitizedEnvironment,
} from './verify-foundation-lib.mjs';

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('resolveRoot decodes file URLs containing spaces', () => {
  const root = tempDir('habi verify root ');
  const runnerUrl = pathToFileURL(
    path.join(root, 'scripts', 'verify-foundation.mjs'),
  ).href;

  try {
    assert.equal(resolveRoot(runnerUrl), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dotenv preflight rejects app files and allows root .env and .env.example', () => {
  const root = tempDir('habi verify dotenv ');
  const sentinel = 'DO_NOT_PRINT_THIS_SENTINEL';
  const appDir = path.join(root, 'apps', 'web');
  const backendDir = path.join(root, 'apps', 'backend');

  try {
    mkdirSync(path.join(appDir, 'src'), { recursive: true });
    mkdirSync(backendDir, { recursive: true });

    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      writeFileSync(path.join(appDir, name), sentinel);
    }

    writeFileSync(path.join(appDir, '.env.example'), 'EXAMPLE=1');
    writeFileSync(path.join(appDir, 'src', '.env'), sentinel);
    writeFileSync(path.join(backendDir, '.env.test'), 'BACKEND=1');
    writeFileSync(path.join(root, '.env'), 'ROOT=1');

    const files = findForbiddenDotenvFiles(root);
    const expected = [
      path.join('apps', 'backend', '.env.test'),
      path.join('apps', 'web', '.env'),
      path.join('apps', 'web', '.env.local'),
      path.join('apps', 'web', '.env.production'),
      path.join('apps', 'web', '.env.production.local'),
    ].sort();

    assert.deepEqual(files, expected);
    assert.ok(!files.includes(path.join('.env')));
    assert.ok(!files.includes(path.join('apps', 'web', '.env.example')));
    assert.ok(!files.includes(path.join('apps', 'web', 'src', '.env')));

    const message = formatForbiddenDotenvMessage(files);
    assert.ok(message.includes(path.join('apps', 'web', '.env')));
    assert.ok(message.includes('Root .env is allowed'));
    assert.ok(!message.includes(sentinel));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitized environment strips secrets and retains OS variables', () => {
  const env = sanitizedEnvironment({
    PATH: '/bin',
    HOME: '/home/test',
    SAFE: 'kept',
    DATABASE_URL: 'secret',
    POSTGRES_PASSWORD: 'secret',
    OPENAI_API_KEY: 'secret',
    OPENCODE_KEY: 'secret',
    HERMES_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    AWS_ACCESS_KEY_ID: 'secret',
    APPLICATION_SECRET: 'secret',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/home/test',
    SAFE: 'kept',
  });
});

test('verification uses forced build and forced tests while normal build stays cached', () => {
  assert.deepEqual(NORMAL_BUILD_ARGS, ['build']);
  assert.deepEqual(SANITIZED_BUILD_ARGS, ['exec', 'turbo', 'run', 'build', '--force']);
  assert.deepEqual(FORCED_TEST_ARGS, ['exec', 'turbo', 'run', 'test', '--force']);

  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.scripts.build, 'turbo run build');
  assert.equal(
    packageJson.scripts['test:verification'],
    'node --test scripts/verify-foundation.test.mjs',
  );
});
