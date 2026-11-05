#!/usr/bin/env node
/**
 * Compose stack contract tests.
 *
 * These tests read the three compose files and assert what a deployment needs:
 * the P1 stack is wired (database URL, session/auth gates, provider config, the
 * four P1 flags, web API origin), required secrets fail fast, no secret literal
 * is committed, readiness probes assert the real surface, and the P0
 * constraints (caps, networks, no published database port) are preserved.
 *
 * The parser here is a deliberately small YAML subset: mappings, block
 * sequences of scalars, flow sequences of scalars, and `|`/`>` block scalars.
 * It exists so the file contract can be checked without Docker or a new
 * dependency. When a Compose CLI is available the same files are additionally
 * interpolated with a throwaway env file under the OS temp directory, which is
 * never committed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const STAGING_FILE = 'compose.staging.yaml';
const PRODUCTION_FILE = 'compose.production.yaml';
const LOCAL_FILE = 'compose.yaml';

/** The four P1 gates and the surface each one adds. */
const P1_FLAGS = [
  'HABI_AUTH_SPIKE',
  'HABI_SESSION_SPIKE',
  'HABI_P1_API',
  'HABI_P1_WORKER',
];

/** Caps and restart policy from the accepted H-007 decision; must not drift. */
const LIMITS = {
  postgres: { mem_limit: '512m', cpus: '0.50' },
  api: { mem_limit: '512m', cpus: '0.50' },
  worker: { mem_limit: '384m', cpus: '0.50' },
  web: { mem_limit: '512m', cpus: '0.50' },
  migrate: { mem_limit: '128m', cpus: '0.25' },
};

function tokenize(text) {
  const tokens = [];
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      return;
    }
    tokens.push({
      indent: raw.length - raw.trimStart().length,
      text: trimmed,
      line: index + 1,
    });
  });
  return tokens;
}

function splitFlowItems(text) {
  const items = [];
  let current = '';
  let quote = '';
  for (const character of text) {
    if (quote !== '') {
      current += character;
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) {
    items.push(current.trim());
  }
  return items;
}

function parseScalar(text) {
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitFlowItems(text.slice(1, -1)).map(parseScalar);
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return JSON.parse(text);
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function splitKey(text) {
  if (text.endsWith(':')) {
    return { key: text.slice(0, -1).trim(), value: '' };
  }
  const separator = text.indexOf(': ');
  if (separator === -1) {
    return null;
  }
  return { key: text.slice(0, separator).trim(), value: text.slice(separator + 2).trim() };
}

function parseBlock(tokens, start, indent) {
  const first = tokens[start];
  if (first !== undefined && (first.text === '-' || first.text.startsWith('- '))) {
    return parseSequence(tokens, start, indent);
  }
  return parseMapping(tokens, start, indent);
}

function parseSequence(tokens, start, indent) {
  const items = [];
  let position = start;
  while (
    position < tokens.length &&
    tokens[position].indent === indent &&
    (tokens[position].text === '-' || tokens[position].text.startsWith('- '))
  ) {
    const token = tokens[position];
    const rest = token.text.slice(1).trim();
    position += 1;
    if (rest.length === 0) {
      const [value, next] = parseBlock(tokens, position, tokens[position].indent);
      items.push(value);
      position = next;
      continue;
    }
    if (splitKey(rest) !== null) {
      throw new Error(`Sequence mapping items are not supported (line ${token.line}).`);
    }
    items.push(parseScalar(rest));
  }
  return [items, position];
}

function parseMapping(tokens, start, indent) {
  const map = {};
  let position = start;
  while (position < tokens.length && tokens[position].indent === indent) {
    const token = tokens[position];
    const split = splitKey(token.text);
    if (split === null) {
      throw new Error(`Unparsable mapping line ${token.line}: ${token.text}`);
    }
    position += 1;

    if (split.value === '' || split.value.startsWith('&') || split.value.startsWith('!')) {
      if (position < tokens.length && tokens[position].indent > indent) {
        const [value, next] = parseBlock(tokens, position, tokens[position].indent);
        map[split.key] = value;
        position = next;
      } else {
        map[split.key] = split.value;
      }
      continue;
    }

    if (/^[>|][+-]?$/.test(split.value)) {
      const lines = [];
      while (position < tokens.length && tokens[position].indent > indent) {
        lines.push(tokens[position].text);
        position += 1;
      }
      map[split.key] = split.value.startsWith('|') ? lines.join('\n') : lines.join(' ');
      continue;
    }

    map[split.key] = parseScalar(split.value);

    if (position < tokens.length && tokens[position].indent > indent) {
      throw new Error(`Unexpected indentation after ${split.key} (line ${token.line}).`);
    }
  }
  return [map, position];
}

function parseCompose(relativePath) {
  const text = readFileSync(path.join(ROOT, relativePath), 'utf8');
  const tokens = tokenize(text);
  const [document] = parseBlock(tokens, 0, tokens[0].indent);
  return { text, document };
}

function service(document, name) {
  const entry = document.services?.[name];
  assert.ok(entry !== undefined, `service "${name}" is missing`);
  return entry;
}

function env(document, name) {
  const environment = service(document, name).environment;
  assert.equal(typeof environment, 'object', `service "${name}" has no environment map`);
  return environment;
}

function truthy(value) {
  return value === true || value === 'true';
}

function requiredValue(value, name, where) {
  assert.equal(typeof value, 'string', `${where}.${name} must be a string`);
  const match = /^\$\{([A-Z0-9_]+):\?([^}]+)\}$/.exec(value);
  assert.ok(
    match !== null,
    `${where}.${name} must use \${${name}:?message} so a missing value fails fast, got ${value}`,
  );
  assert.equal(match[1], name, `${where}.${name} interpolates the wrong variable`);
  assert.ok(
    match[2].trim().length >= 10,
    `${where}.${name} fails-fast message is too short to be actionable`,
  );
  return match[2];
}

function defaultOf(value, name, where) {
  assert.equal(typeof value, 'string', `${where}.${name} must be a string`);
  const match = new RegExp(`^\\$\\{${name}:-(.+)}$`).exec(value);
  assert.ok(match !== null, `${where}.${name} must use \${${name}:-default}, got ${value}`);
  return match[1];
}

function assertDatabaseUrl(document, name) {
  const url = env(document, name).DATABASE_URL;
  assert.equal(typeof url, 'string', `${name} must receive DATABASE_URL`);
  assert.match(url, /^postgresql:\/\//, `${name} DATABASE_URL is not a postgresql URL`);
  assert.match(
    url,
    /@postgres:5432\//,
    `${name} DATABASE_URL must use the compose service host "postgres" and port 5432`,
  );
  assert.doesNotMatch(
    url,
    /localhost|127\.0\.0\.1/,
    `${name} DATABASE_URL must not point at localhost; the database is a compose service`,
  );
  assert.match(
    url,
    /\$\{POSTGRES_PASSWORD:\?[^}]+\}/,
    `${name} DATABASE_URL must reuse the required POSTGRES_PASSWORD secret`,
  );
}

const staging = parseCompose(STAGING_FILE);
const production = parseCompose(PRODUCTION_FILE);
const local = parseCompose(LOCAL_FILE);

test('both stacks define the full runnable service set', () => {
  for (const [file, parsed] of [
    [STAGING_FILE, staging],
    [PRODUCTION_FILE, production],
  ]) {
    for (const name of ['postgres', 'migrate', 'api', 'worker', 'web']) {
      assert.ok(
        parsed.document.services?.[name] !== undefined,
        `${file} must define the "${name}" service`,
      );
    }
    assert.equal(parsed.document.name, file === STAGING_FILE ? 'habi-staging' : 'habi-production');
  }
});

test('DATABASE_URL targets the compose database service in every P1 process', () => {
  for (const parsed of [staging, production]) {
    for (const name of ['api', 'worker', 'migrate']) {
      assertDatabaseUrl(parsed.document, name);
    }
  }
});

test('required values are declared with :? and fail with a clear message', () => {
  requiredValue(env(staging.document, 'postgres').POSTGRES_PASSWORD, 'POSTGRES_PASSWORD', 'staging postgres');
  requiredValue(env(production.document, 'postgres').POSTGRES_PASSWORD, 'POSTGRES_PASSWORD', 'production postgres');

  for (const parsed of [staging, production]) {
    for (const name of ['api', 'worker', 'migrate']) {
      assert.match(
        env(parsed.document, name).DATABASE_URL,
        /\$\{POSTGRES_PASSWORD:\?[^}]+\}/,
        `${name} must fail fast when POSTGRES_PASSWORD is absent`,
      );
    }
  }

  const productionTag = service(production.document, 'api').image;
  assert.match(
    productionTag,
    /^\$\{HABI_IMAGE_TAG:\?[^}]+\}$|:\$\{HABI_IMAGE_TAG:\?[^}]+\}$/,
    'production must require an immutable HABI_IMAGE_TAG',
  );

  const productionWorkerTag = service(production.document, 'worker').image;
  assert.match(productionWorkerTag, /\$\{HABI_IMAGE_TAG:\?/, 'production worker tag must be required');

  assert.match(
    env(staging.document, 'worker').HABI_HERMES_GATEWAY_KEY,
    /^\$\{HABI_HERMES_GATEWAY_KEY:\?[^}]+\}$/,
    'staging worker must require the provider key at deploy time',
  );
  assert.match(
    env(staging.document, 'worker').HABI_HERMES_BASE_URL,
    /^\$\{HABI_HERMES_BASE_URL:\?[^}]+\}$/,
    'staging worker must require the provider endpoint at deploy time',
  );
});

test('no secret literal, default password, or floating tag is committed', () => {
  for (const [file, parsed] of [
    [STAGING_FILE, staging],
    [PRODUCTION_FILE, production],
    [LOCAL_FILE, local],
  ]) {
    assert.doesNotMatch(parsed.text, /:latest\b/, `${file} must not use a floating latest tag`);

    for (const [name, definition] of Object.entries(parsed.document.services ?? {})) {
      for (const [key, value] of Object.entries(definition.environment ?? {})) {
        if (!/(PASSWORD|SECRET|TOKEN|_KEY|KEY_)/i.test(key)) {
          continue;
        }
        assert.match(
          value,
          /^\$\{[A-Z0-9_]+(?::[-?][^}]*)?\}$/,
          `${file} ${name}.${key} must be an interpolation, never a literal`,
        );
        assert.doesNotMatch(
          value,
          /^[A-Za-z0-9+/=_-]{20,}$/,
          `${file} ${name}.${key} looks like a committed secret`,
        );
      }
    }
  }
});

test('all four P1 flags are present with the intended staging and production values', () => {
  const stagingApi = env(staging.document, 'api');
  for (const flag of ['HABI_AUTH_SPIKE', 'HABI_SESSION_SPIKE', 'HABI_P1_API']) {
    assert.equal(
      defaultOf(stagingApi[flag], flag, 'staging api'),
      '1',
      `staging must default ${flag} to 1 so the P1 candidate is flag-on`,
    );
  }
  assert.equal(
    env(staging.document, 'worker').HABI_P1_WORKER,
    '1',
    'staging worker must run the P1 claim loop',
  );

  const productionApi = env(production.document, 'api');
  for (const flag of ['HABI_AUTH_SPIKE', 'HABI_SESSION_SPIKE', 'HABI_P1_API']) {
    assert.equal(
      defaultOf(productionApi[flag], flag, 'production api'),
      '0',
      `production must default ${flag} to 0: enabling a P1 surface is an owner decision`,
    );
  }
  assert.equal(
    defaultOf(env(production.document, 'worker').HABI_P1_WORKER, 'HABI_P1_WORKER', 'production worker'),
    '0',
    'production must not silently enable the P1 worker',
  );

  for (const flag of P1_FLAGS) {
    const combined = `${staging.text}\n${production.text}`;
    assert.ok(combined.includes(flag), `${flag} must be declared in both stacks`);
  }

  for (const [file, parsed] of [
    [STAGING_FILE, staging],
    [PRODUCTION_FILE, production],
  ]) {
    for (const name of Object.keys(parsed.document.services ?? {})) {
      assert.equal(
        (parsed.document.services[name].environment ?? {}).HABI_SESSION_SPIKE_TEST_CLOCK,
        undefined,
        `${file} must not pass the test-only session clock knob`,
      );
    }
  }
});

test('the worker image runs the worker entrypoint, not the API', () => {
  for (const [file, parsed] of [
    [STAGING_FILE, staging],
    [PRODUCTION_FILE, production],
  ]) {
    const worker = service(parsed.document, 'worker');
    assert.equal(worker.build?.target, 'worker', `${file} worker must build the worker image target`);
    assert.match(worker.image, /^habi-worker:/, `${file} worker must use the worker image`);
    assert.equal(worker.ports, undefined, `${file} worker must not publish a port`);
    assert.equal(worker.healthcheck !== undefined, true, `${file} worker must declare a healthcheck`);
    assert.equal(
      worker.entrypoint,
      undefined,
      `${file} worker must run the image entrypoint (dist/worker.js), not an override`,
    );
    assert.equal(worker.command, undefined, `${file} worker must not override the image command`);

    const api = service(parsed.document, 'api');
    assert.equal(api.build?.target, 'api', `${file} api must build the api image target`);
    assert.match(api.healthcheck.test, /\/api\/bots/, `${file} api probe must assert the P1 routes exist`);
  }

  assert.equal(service(staging.document, 'worker').environment.HABI_P1_WORKER, '1');
});

test('readiness probes assert the real surface, not just /health', () => {
  for (const [file, parsed] of [
    [STAGING_FILE, staging],
    [PRODUCTION_FILE, production],
  ]) {
    const apiProbe = service(parsed.document, 'api').healthcheck;
    assert.equal(typeof apiProbe.test, 'string', `${file} api probe must be a command string`);
    assert.match(apiProbe.test, /\/health/, `${file} api probe must check the health route`);
    assert.match(apiProbe.test, /\/api\/bots/, `${file} api probe must check the P1 surface`);
    assert.match(apiProbe.test, /HABI_P1_API/, `${file} api probe must compare the surface with the flag`);
    assert.match(apiProbe.test, /schema_migrations/, `${file} api probe must check the migrated schema`);
    assert.ok(apiProbe.interval !== undefined && apiProbe.timeout !== undefined);

    const workerProbe = service(parsed.document, 'worker').healthcheck;
    assert.match(workerProbe.test, /HABI_P1_WORKER/, `${file} worker probe must read the runner flag`);
    assert.match(
      workerProbe.test,
      /HABI_HERMES_GATEWAY_KEY/,
      `${file} worker probe must assert the provider pair`,
    );
    assert.match(workerProbe.test, /schema_migrations/, `${file} worker probe must check the schema`);

    const webProbe = service(parsed.document, 'web').healthcheck;
    assert.match(webProbe.test, /127\.0\.0\.1:3000\//, `${file} web probe must request the web root`);
    assert.match(webProbe.test, /\/api\/bots/, `${file} web probe must check the same-origin BFF`);
  }
});

test('the web knows the API origin and CSRF-relevant origins are explicit', () => {
  for (const [file, parsed] of [
    [STAGING_FILE, staging],
    [PRODUCTION_FILE, production],
  ]) {
    const webEnv = env(parsed.document, 'web');
    assert.equal(
      defaultOf(webEnv.HABI_API_URL, 'HABI_API_URL', `${file} web`),
      'http://api:3001',
      `${file} web must reach the API by compose service name`,
    );
    assert.equal(
      defaultOf(webEnv.HABI_AUTH_API_URL, 'HABI_AUTH_API_URL', `${file} web`),
      'http://api:3001',
      `${file} auth BFF must reach the API by compose service name`,
    );
    assert.equal(
      webEnv.HABI_P1_API,
      env(parsed.document, 'api').HABI_P1_API,
      `${file} web probe mode must mirror the API gate`,
    );
    for (const value of [webEnv.HABI_API_URL, webEnv.HABI_AUTH_API_URL]) {
      assert.doesNotMatch(value, /localhost|127\.0\.0\.1|\*/, `${file} web origin must be explicit`);
    }
  }
});

test('the P0 constraints are preserved', () => {
  for (const [file, parsed] of [
    [STAGING_FILE, staging],
    [PRODUCTION_FILE, production],
  ]) {
    const postgres = service(parsed.document, 'postgres');
    assert.equal(postgres.ports, undefined, `${file} postgres must not publish a port`);
    assert.match(postgres.healthcheck.test.join(' '), /pg_isready/);

    for (const [name, limits] of Object.entries(LIMITS)) {
      const definition = service(parsed.document, name);
      assert.equal(definition.mem_limit, limits.mem_limit, `${file} ${name} mem_limit changed`);
      assert.equal(definition.cpus, limits.cpus, `${file} ${name} cpus changed`);
    }
    for (const name of ['postgres', 'api', 'worker', 'web']) {
      assert.equal(
        service(parsed.document, name).restart,
        'unless-stopped',
        `${file} ${name} restart policy changed`,
      );
    }

    const networks = parsed.document.networks;
    assert.equal(truthy(networks.internal.internal), true, `${file} internal network must stay internal`);
    for (const name of ['postgres', 'worker']) {
      assert.deepEqual(service(parsed.document, name).networks, ['internal']);
    }
    assert.deepEqual(service(parsed.document, 'web').networks, ['edge']);
    assert.deepEqual(service(parsed.document, 'api').networks, ['internal', 'edge']);

    for (const name of ['api', 'web']) {
      for (const published of service(parsed.document, name).ports) {
        assert.match(
          published,
          /^127\.0\.0\.1:/,
          `${file} ${name} port must stay bound to loopback, got ${published}`,
        );
      }
    }
  }
});

test('the local development stack still runs only PostgreSQL', () => {
  const names = Object.keys(local.document.services ?? {});
  assert.deepEqual(names, ['postgres']);
  assert.equal(service(local.document, 'postgres').ports.length, 1);
  assert.match(local.document.services.postgres.healthcheck.test.join(' '), /pg_isready/);
});

function composeCli() {
  for (const [command, args] of [
    ['docker', ['compose', 'version']],
    ['docker-compose', ['version']],
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
    if (!result.error && result.status === 0) {
      return { command, prefix: command === 'docker' ? ['compose'] : [] };
    }
  }
  return null;
}

function writeDummyEnv(directory, includePassword) {
  const lines = [
    'POSTGRES_DB=habi',
    'POSTGRES_USER=habi',
    `HABI_IMAGE_TAG=sha-test`,
    'HABI_HERMES_BASE_URL=http://hermes.invalid:8080',
    'HABI_HERMES_GATEWAY_KEY=not-a-real-provider-key-for-config',
  ];
  if (includePassword) {
    lines.push('POSTGRES_PASSWORD=not-a-real-password-for-config');
  }
  const file = path.join(directory, includePassword ? 'with-secret.env' : 'without-secret.env');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

const cli = composeCli();

test(
  'both stacks interpolate with a throwaway env file',
  { skip: cli === null ? 'no Docker Compose CLI on PATH' : false },
  () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'habi-compose-test-'));
    try {
      const withSecret = writeDummyEnv(directory, true);

      for (const file of [STAGING_FILE, PRODUCTION_FILE]) {
        const result = spawnSync(
          cli.command,
          [...cli.prefix, '--env-file', withSecret, '-f', path.join(ROOT, file), 'config', '--quiet'],
          { cwd: directory, encoding: 'utf8', timeout: 60_000 },
        );
        assert.equal(result.status, 0, `${file} config failed:\n${result.stderr}`);
      }

      const withoutSecret = writeDummyEnv(directory, false);
      const missing = spawnSync(
        cli.command,
        [...cli.prefix, '--env-file', withoutSecret, '-f', path.join(ROOT, STAGING_FILE), 'config', '--quiet'],
        { cwd: directory, encoding: 'utf8', timeout: 60_000 },
      );
      assert.notEqual(missing.status, 0, 'a missing POSTGRES_PASSWORD must fail interpolation');
      assert.match(
        `${missing.stdout}${missing.stderr}`,
        /POSTGRES_PASSWORD/,
        'the failure must name the missing variable',
      );

      const productionMissing = spawnSync(
        cli.command,
        [...cli.prefix, '--env-file', withoutSecret, '-f', path.join(ROOT, PRODUCTION_FILE), 'config', '--quiet'],
        { cwd: directory, encoding: 'utf8', timeout: 60_000 },
      );
      assert.notEqual(
        productionMissing.status,
        0,
        'production must fail interpolation without POSTGRES_PASSWORD',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
