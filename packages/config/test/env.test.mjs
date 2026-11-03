import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const distModuleUrl = new URL('../dist/index.js', import.meta.url);
const indexTypesUrl = new URL('../dist/index.d.ts', import.meta.url);
const envTypesUrl = new URL('../dist/env.d.ts', import.meta.url);
const packageJsonUrl = new URL('../package.json', import.meta.url);

async function loadBuiltEntryPoint() {
  try {
    return await import(distModuleUrl.href);
  } catch (error) {
    throw new Error(
      'Build @habi/config before running its tests: pnpm --filter @habi/config build',
      { cause: error },
    );
  }
}

const { EnvValidationError, parseEnv } = await loadBuiltEntryPoint();

function captureError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }

  assert.fail('expected parseEnv to throw');
}

test('parseEnv applies documented defaults to an empty environment', () => {
  assert.deepEqual(parseEnv({}), {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 3001,
  });
});

test('parseEnv accepts valid overrides and returns numeric ports', () => {
  const env = parseEnv({
    NODE_ENV: 'production',
    HOST: 'localhost',
    PORT: '8080',
    API_PORT: ' 3002 ',
    POSTGRES_DB: 'habi',
    POSTGRES_USER: 'habi_app',
    POSTGRES_PASSWORD: 'local-only-placeholder',
    POSTGRES_PORT: '5433',
  });

  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.HOST, 'localhost');
  assert.equal(env.PORT, 8080);
  assert.equal(env.API_PORT, 3002);
  assert.equal(env.POSTGRES_DB, 'habi');
  assert.equal(env.POSTGRES_USER, 'habi_app');
  assert.equal(env.POSTGRES_PASSWORD, 'local-only-placeholder');
  assert.equal(env.POSTGRES_PORT, 5433);
});

test('parseEnv omits absent database keys instead of requiring them', () => {
  const env = parseEnv({});

  assert.equal('API_PORT' in env, false);
  assert.equal('POSTGRES_DB' in env, false);
  assert.equal('POSTGRES_USER' in env, false);
  assert.equal('POSTGRES_PASSWORD' in env, false);
  assert.equal('POSTGRES_PORT' in env, false);
});

test('parseEnv treats an empty value as unset', () => {
  assert.deepEqual(parseEnv({ NODE_ENV: '', HOST: '', PORT: '', POSTGRES_DB: '' }), {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 3001,
  });
});

test('parseEnv rejects a PORT that is not an integer in range', () => {
  for (const value of ['80a', '0', '65536', '80.5', '-1', '1e3']) {
    const error = captureError(() => parseEnv({ PORT: value }));

    assert.ok(error instanceof EnvValidationError);
    assert.deepEqual(error.keys, ['PORT']);
    assert.match(error.message, /PORT \(must be an integer between 1 and 65535\)/);
  }
});

test('parseEnv validates POSTGRES_PORT with the same port rules', () => {
  const error = captureError(() => parseEnv({ POSTGRES_PORT: 'not-a-port' }));

  assert.ok(error instanceof EnvValidationError);
  assert.deepEqual(error.keys, ['POSTGRES_PORT']);
});

test('parseEnv rejects an unknown NODE_ENV', () => {
  const error = captureError(() => parseEnv({ NODE_ENV: 'staging' }));

  assert.ok(error instanceof EnvValidationError);
  assert.deepEqual(error.keys, ['NODE_ENV']);
  assert.match(
    error.message,
    /NODE_ENV \(must be one of development, test, production\)/,
  );
  assert.equal(error.message.includes('staging'), false);
});

test('parseEnv rejects whitespace-only values', () => {
  const hostError = captureError(() => parseEnv({ HOST: '   ' }));

  assert.ok(hostError instanceof EnvValidationError);
  assert.deepEqual(hostError.keys, ['HOST']);
  assert.match(hostError.message, /HOST \(must not be blank\)/);

  const nameError = captureError(() => parseEnv({ POSTGRES_USER: ' \t ' }));

  assert.ok(nameError instanceof EnvValidationError);
  assert.deepEqual(nameError.keys, ['POSTGRES_USER']);
});

test('parseEnv rejects database names containing whitespace', () => {
  const error = captureError(() => parseEnv({ POSTGRES_DB: 'habi database' }));

  assert.ok(error instanceof EnvValidationError);
  assert.deepEqual(error.keys, ['POSTGRES_DB']);
  assert.match(
    error.message,
    /POSTGRES_DB \(must be a non-empty value without whitespace\)/,
  );
});

test('parseEnv aggregates every invalid key into one error', () => {
  const error = captureError(() =>
    parseEnv({ PORT: '0', NODE_ENV: 'staging', POSTGRES_PORT: 'not-a-port' }),
  );

  assert.ok(error instanceof EnvValidationError);
  assert.deepEqual(error.keys, ['NODE_ENV', 'PORT', 'POSTGRES_PORT']);
  assert.equal(error.issues.length, 3);
  assert.equal(error.name, 'EnvValidationError');
});

test('validation errors never echo supplied values', () => {
  const secret = 'sup3r-s3cret-local-password';
  const error = captureError(() =>
    parseEnv({ POSTGRES_PASSWORD: secret, POSTGRES_PORT: 'not-a-port' }),
  );

  assert.ok(error instanceof EnvValidationError);
  assert.deepEqual(error.keys, ['POSTGRES_PORT']);
  assert.equal(error.message.includes(secret), false);
  assert.equal(JSON.stringify(error.issues).includes(secret), false);
});

test('a malformed secret value never appears in the error message', () => {
  const secret = 'sup3r s3cret with spaces';
  const error = captureError(() => parseEnv({ POSTGRES_PASSWORD: secret }));

  assert.ok(error instanceof EnvValidationError);
  assert.deepEqual(error.keys, ['POSTGRES_PASSWORD']);
  assert.equal(error.message.includes('sup3r'), false);
  assert.equal(error.issues.some((issue) => issue.reason.includes('sup3r')), false);
});

test('entry point exposes the parser and keeps existing subpath exports', async () => {
  const pkg = JSON.parse(await readFile(packageJsonUrl, 'utf8'));

  assert.equal(typeof parseEnv, 'function');
  assert.equal(typeof EnvValidationError, 'function');
  assert.equal(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.exports['./tsconfig/base.json'], './tsconfig/base.json');
  assert.equal(pkg.exports['./eslint/base.mjs'], './eslint/base.mjs');
});

test('built runtime stays browser-safe by importing no Node built-ins', async () => {
  const runtime = await readFile(distModuleUrl, 'utf8');

  assert.doesNotMatch(runtime, /from ['"]node:/);
  assert.doesNotMatch(runtime, /\brequire\(/);
});

test('declarations expose the validated environment shape', async () => {
  const entryTypes = await readFile(indexTypesUrl, 'utf8');
  const envTypes = await readFile(envTypesUrl, 'utf8');

  assert.match(entryTypes, /parseEnv/);
  assert.match(entryTypes, /from '\.\/env\.js'/);
  assert.match(envTypes, /interface Env/);
  assert.match(envTypes, /NODE_ENV: NodeEnv/);
  assert.match(envTypes, /POSTGRES_PORT\?: number/);
});
