/**
 * Disposable PostgreSQL lifecycle for acceptance.
 *
 * One container per run, one database per restore check. The harness never
 * points at a developer database: the connection string is generated from a
 * random container port and password, and teardown removes the container.
 */
import { randomBytes } from 'node:crypto';
import { run, runChecked, requireBackendModule, sleep } from './process.mjs';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const USER = 'habi';
const DATABASE = 'habi';

export function dockerAvailable() {
  const result = run('docker', ['info'], { timeoutMs: 8_000 });

  return result.status === 0;
}

export function postgresClientAvailable() {
  return ['pg_dump', 'pg_restore', 'psql'].every(
    (tool) => run(tool, ['--version'], { timeoutMs: 8_000 }).status === 0,
  );
}

/** Returns the immutable digest when the local image carries one. */
export function postgresImageDigest() {
  const result = run(
    'docker',
    ['image', 'inspect', POSTGRES_IMAGE, '--format', '{{json .RepoDigests}}'],
    { timeoutMs: 15_000 },
  );

  if (result.status !== 0) {
    return 'unavailable';
  }

  try {
    const digests = JSON.parse(result.stdout.trim());

    return Array.isArray(digests) && digests.length > 0
      ? digests[0]
      : 'no RepoDigest recorded locally';
  } catch {
    return 'unavailable';
  }
}

export function dockerServerVersion() {
  const result = run('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 10_000,
  });

  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

async function waitForDatabase(pool, containerName) {
  const deadline = Date.now() + 90_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1 FROM pg_database LIMIT 1');
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  const logs = run('docker', ['logs', '--tail', '80', containerName], {
    timeoutMs: 15_000,
  });

  throw new Error(
    `PostgreSQL did not become ready: ${lastError?.message ?? 'unknown error'}\n` +
      `${logs.stdout ?? ''}\n${logs.stderr ?? ''}`,
  );
}

export async function startPostgres() {
  const { Pool } = requireBackendModule('pg');
  const containerName = `habi-acceptance-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');

  const container = run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--tmpfs',
      '/var/lib/postgresql:rw,noexec,nosuid',
      '--name',
      containerName,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      `POSTGRES_USER=${USER}`,
      '-e',
      `POSTGRES_DB=${DATABASE}`,
      '-p',
      '127.0.0.1::5432',
      POSTGRES_IMAGE,
    ],
    { timeoutMs: 180_000 },
  );

  if (container.status !== 0) {
    throw new Error(`Could not start PostgreSQL: ${(container.stderr ?? '').trim()}`);
  }

  try {
    const portResult = run('docker', ['port', containerName, '5432/tcp'], {
      timeoutMs: 15_000,
    });

    if (portResult.status !== 0) {
      throw new Error(`Could not read the container port: ${portResult.stderr}`);
    }

    const port = Number.parseInt(portResult.stdout.trim().split(':').pop() ?? '', 10);

    if (!Number.isInteger(port) || port < 1) {
      throw new Error('Docker did not publish a PostgreSQL port.');
    }

    const pool = new Pool({
      host: '127.0.0.1',
      port,
      user: USER,
      password,
      database: DATABASE,
      max: 12,
    });

    await waitForDatabase(pool, containerName);

    const url = `postgres://${USER}:${password}@127.0.0.1:${port}/${DATABASE}`;

    return {
      containerName,
      host: '127.0.0.1',
      port,
      user: USER,
      database: DATABASE,
      password,
      url,
      pool,
      async stop() {
        await pool.end().catch(() => {});
        run('docker', ['rm', '-f', containerName], { timeoutMs: 30_000 });
      },
    };
  } catch (error) {
    run('docker', ['rm', '-f', containerName], { timeoutMs: 30_000 });
    throw error;
  }
}

export function applyMigrations(databaseUrl) {
  const result = run(
    process.execPath,
    ['scripts/db/migrate.mjs', '--database-url', databaseUrl],
    { timeoutMs: 120_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `Migrations failed: ${(result.stderr ?? result.stdout ?? '').trim().slice(0, 3000)}`,
    );
  }

  return {
    applied: (result.stdout.match(/applied\s+\S+\.sql/g) ?? []).length,
    stdout: result.stdout,
  };
}

/** Creates a database from the maintenance database and returns its URL. */
export function createDatabase(postgres, name) {
  const admin = `postgres://${postgres.user}:${postgres.password}@${postgres.host}:${postgres.port}/postgres`;

  runChecked(
    'psql',
    ['--no-password', '--no-psqlrc', admin, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${name}"`],
    { env: { ...process.env, PGPASSWORD: postgres.password }, timeoutMs: 30_000 },
  );

  return `postgres://${postgres.user}:${postgres.password}@${postgres.host}:${postgres.port}/${name}`;
}

export function dropDatabase(postgres, name) {
  const admin = `postgres://${postgres.user}:${postgres.password}@${postgres.host}:${postgres.port}/postgres`;

  run(
    'psql',
    [
      '--no-password',
      '--no-psqlrc',
      admin,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    ],
    { env: { ...process.env, PGPASSWORD: postgres.password }, timeoutMs: 30_000 },
  );
}

export { POSTGRES_IMAGE };
