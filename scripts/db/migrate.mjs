#!/usr/bin/env node
/**
 * H-019 schema migration runner.
 *
 * Plain SQL files under `migrations/` are applied in filename order, tracked in
 * `schema_migrations`, and wrapped one transaction per file. The runner is
 * idempotent, refuses to skip an earlier pending migration, detects modified
 * files by checksum, and serializes concurrent runs with a PostgreSQL advisory
 * lock.
 *
 * `pg` is resolved from the backend workspace so the script does not need a
 * second dependency declaration. Node built-ins do the rest.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/db/migrate.mjs
 *   DATABASE_URL=postgres://... node scripts/db/migrate.mjs --dry-run
 *   DATABASE_URL=postgres://... node scripts/db/migrate.mjs --list
 *   node scripts/db/migrate.mjs --database-url postgres://... --migrations-dir ./tmp
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../..');
const DEFAULT_MIGRATIONS_DIR = join(REPOSITORY_ROOT, 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';
const MIGRATION_FILE_PATTERN = /^(\d{4,})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const LOCK_NAME = 'habi.schema_migrations';
const HELP = `Usage: node scripts/db/migrate.mjs [options]

Options:
  --dry-run, --list          Show applied and pending migrations; change nothing.
  --database-url <url>       PostgreSQL URL. Defaults to DATABASE_URL.
  --migrations-dir <path>    Directory of NNNN_name.sql files.
  --help                     Show this message.
`;

const backendRequire = createRequire(join(REPOSITORY_ROOT, 'apps/backend/package.json'));
const { Client } = backendRequire('pg');

class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    databaseUrl: process.env.DATABASE_URL ?? '',
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run' || arg === '--list') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--database-url') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new MigrationError('--database-url requires a value.');
      }
      options.databaseUrl = value;
      index += 1;
    } else if (arg.startsWith('--database-url=')) {
      options.databaseUrl = arg.slice('--database-url='.length);
    } else if (arg === '--migrations-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new MigrationError('--migrations-dir requires a value.');
      }
      options.migrationsDir = resolve(value);
      index += 1;
    } else if (arg.startsWith('--migrations-dir=')) {
      options.migrationsDir = resolve(arg.slice('--migrations-dir='.length));
    } else {
      throw new MigrationError(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function checksum(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function readMigrations(directory) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    throw new MigrationError(`Cannot read migrations directory ${directory}: ${error.message}`);
  }

  const migrations = [];
  const seenVersions = new Map();

  for (const filename of entries) {
    if (!filename.endsWith('.sql')) {
      continue;
    }

    const fullPath = join(directory, filename);
    if (!statSync(fullPath).isFile()) {
      continue;
    }

    const match = MIGRATION_FILE_PATTERN.exec(filename);
    if (match === null) {
      throw new MigrationError(
        `Invalid migration filename ${filename}; expected NNNN_lower_snake_case.sql.`,
      );
    }

    const version = match[1];
    if (seenVersions.has(version)) {
      throw new MigrationError(
        `Duplicate migration version ${version}: ${seenVersions.get(version)} and ${filename}.`,
      );
    }
    seenVersions.set(version, filename);

    const contents = readFileSync(fullPath, 'utf8');
    migrations.push({
      version,
      filename,
      checksum: checksum(contents),
      sql: contents,
    });
  }

  migrations.sort((left, right) => {
    const byNumber = Number(left.version) - Number(right.version);
    if (byNumber !== 0) {
      return byNumber;
    }
    return left.version < right.version ? -1 : 1;
  });
  return migrations;
}

/**
 * Validates that the database's applied history is a prefix of the files on
 * disk. A pending file sorting before an applied file is refused, because
 * applying it now would not match the order other environments already ran.
 */
function planMigrations(migrations, appliedRows) {
  const filesByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));

  for (const row of appliedRows) {
    const file = filesByVersion.get(row.version);
    if (file === undefined) {
      throw new MigrationError(
        `Applied migration ${row.version} (${row.name}) has no file in the migrations directory.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Checksum mismatch for applied migration ${row.version} (${row.name}); do not edit an applied migration.`,
      );
    }
  }

  let sawPending = false;
  for (const migration of migrations) {
    const applied = appliedByVersion.get(migration.version);

    if (applied === undefined) {
      sawPending = true;
    } else if (sawPending) {
      throw new MigrationError(
        `Refusing out-of-order migration: ${migration.filename} is already applied but an earlier migration is pending.`,
      );
    }
  }

  return {
    applied: migrations.filter((migration) => appliedByVersion.has(migration.version)),
    pending: migrations.filter((migration) => !appliedByVersion.has(migration.version)),
  };
}

async function readApplied(client) {
  const exists = await client.query('SELECT to_regclass($1) AS table_name', [
    `public.${MIGRATIONS_TABLE}`,
  ]);

  if (exists.rows[0]?.table_name === null || exists.rows[0]?.table_name === undefined) {
    return [];
  }

  const result = await client.query(
    `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return result.rows;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.databaseUrl.trim().length === 0) {
    throw new MigrationError('DATABASE_URL or --database-url is required.');
  }

  const migrations = readMigrations(options.migrationsDir);
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: 'habi-migrate',
  });

  await client.connect();

  let lockHeld = false;
  try {
    if (options.dryRun) {
      const appliedRows = await readApplied(client);
      const plan = planMigrations(migrations, appliedRows);

      for (const migration of plan.applied) {
        process.stdout.write(`applied  ${migration.filename}\n`);
      }
      for (const migration of plan.pending) {
        process.stdout.write(`pending  ${migration.filename}\n`);
      }
      process.stdout.write(
        plan.pending.length === 0
          ? 'dry run: schema is up to date; no changes made.\n'
          : `dry run: ${plan.pending.length} migration(s) pending; no changes made.\n`,
      );
      return;
    }

    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);
    lockHeld = true;
    await ensureMigrationsTable(client);

    const appliedRows = await readApplied(client);
    const plan = planMigrations(migrations, appliedRows);

    if (plan.pending.length === 0) {
      process.stdout.write(`up to date: ${appliedRows.length} migration(s) applied.\n`);
      return;
    }

    for (const migration of plan.pending) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum],
        );
        await client.query('COMMIT');
        process.stdout.write(`applied  ${migration.filename}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(
          `Migration ${migration.filename} failed and was rolled back: ${error.message}`,
        );
      }
    }

    process.stdout.write(`done: applied ${plan.pending.length} migration(s).\n`);
  } finally {
    if (lockHeld) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
    }
    await client.end();
  }
}

try {
  await run();
} catch (error) {
  if (error instanceof MigrationError) {
    process.stderr.write(`migration error: ${error.message}\n`);
  } else {
    process.stderr.write(`migration error: ${error.message ?? String(error)}\n`);
  }
  process.exitCode = 1;
}
