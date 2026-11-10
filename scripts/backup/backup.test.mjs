// End-to-end rehearsal for scripts/backup/pg-backup.sh and
// scripts/backup/pg-restore-rehearsal.sh.
//
// The test starts a throwaway postgres:18.6-alpine container on a random
// loopback port, seeds a synthetic table, generates a throwaway age keypair,
// backs the table up into an encrypted archive, changes the source, restores
// the archive with the private key into a new disposable database, and asserts
// the restored rows match the backup rather than the mutated source. It also
// asserts that the published file is ciphertext, that restore without the key
// fails, that the wrong key and corrupt ciphertext fail, and that cleanup
// leaves no container, disposable database, or temp file.
//
// It is not wired into pnpm verify:foundation (no package.json or CI change was
// in scope for H-012). Run it directly:
//
//   node --test scripts/backup/backup.test.mjs
//
// It skips cleanly when Docker, the PostgreSQL client tools, or age/age-keygen
// are unavailable. It never touches the Compose databases or any existing
// cluster: it creates its own container and database names and removes them on
// the way out. The age keypair is generated in the test's temp directory and is
// never a real key.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const BACKUP_SCRIPT = path.join(SCRIPT_DIR, 'pg-backup.sh');
const REHEARSAL_SCRIPT = path.join(SCRIPT_DIR, 'pg-restore-rehearsal.sh');
const IMAGE = 'postgres:18.6-alpine';
const TEST_LABEL = 'habi.test=backup';

const PG_CLIENTS = ['pg_dump', 'pg_restore', 'psql'];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function dockerAvailable() {
  const result = run('docker', ['version', '--format', '{{.Server.Version}}']);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function postgresClientAvailable() {
  return PG_CLIENTS.every((tool) => run(tool, ['--version']).status === 0);
}

function ageAvailable() {
  return ['age', 'age-keygen'].every((tool) => run(tool, ['--version']).status === 0);
}

function imageAvailable() {
  if (run('docker', ['image', 'inspect', IMAGE]).status === 0) {
    return true;
  }

  // Best effort: only used when the image is not already cached.
  return run('docker', ['pull', IMAGE], { timeout: 240_000 }).status === 0;
}

function skipReason() {
  if (!dockerAvailable()) {
    return 'Docker daemon is not available; skipping the backup rehearsal';
  }

  if (!postgresClientAvailable()) {
    return `PostgreSQL client tools are not on PATH (${PG_CLIENTS.join(', ')}); skipping the backup rehearsal`;
  }

  if (!ageAvailable()) {
    return 'age and age-keygen are not on PATH; skipping the encrypted backup rehearsal';
  }

  if (!imageAvailable()) {
    return `Docker image ${IMAGE} is not available and could not be pulled; skipping the backup rehearsal`;
  }

  return '';
}

const SKIP = skipReason();

test('backup and restore rehearsal against a disposable PostgreSQL container', {
  skip: SKIP || false,
  timeout: 240_000,
}, async (t) => {
  const suffix = randomBytes(4).toString('hex');
  const container = `habi-backup-test-${suffix}`;
  const password = randomBytes(16).toString('hex');
  const user = 'habi_backup_test';
  const sourceDb = 'habi_backup_test';
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'habi-backup-test-'));
  const backupDir = path.join(workRoot, 'backups');
  const scriptTmp = path.join(workRoot, 'script-tmp');
  mkdirSync(scriptTmp, { recursive: true });

  let port = '';

  const baseEnv = {
    ...process.env,
    PGPASSWORD: password,
    PGCONNECT_TIMEOUT: '5',
    TMPDIR: scriptTmp,
  };

  // Throwaway keypair for this run only. The private key stays in the test's
  // temp directory and is removed with it; no real key is ever used.
  const identityFile = path.join(workRoot, 'backup.key');
  const keygen = run('age-keygen', ['-o', identityFile]);
  assert.equal(keygen.status, 0, `age-keygen failed: ${keygen.stderr}`);
  const recipientMatch = readFileSync(identityFile, 'utf8').match(/^# public key: (age1\S+)$/m);
  assert.ok(recipientMatch, 'age-keygen did not report a public key');
  const recipient = recipientMatch[1];

  const wrongIdentityFile = path.join(workRoot, 'wrong.key');
  const wrongKeygen = run('age-keygen', ['-o', wrongIdentityFile]);
  assert.equal(wrongKeygen.status, 0, `second age-keygen failed: ${wrongKeygen.stderr}`);

  const psqlArgs = (database) => [
    '--no-password',
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '--username',
    user,
    '--dbname',
    database,
  ];

  const sourceSql = (sql) =>
    run('psql', [...psqlArgs(sourceDb), '--set', 'ON_ERROR_STOP=1', '--command', sql], {
      env: baseEnv,
    });

  const rehearsalDatabases = () => {
    const result = run(
      'psql',
      [...psqlArgs(sourceDb), '--command', "SELECT count(*) FROM pg_database WHERE datname LIKE 'habi_rehearsal_%'"],
      { env: baseEnv },
    );

    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  t.after(() => {
    run('docker', ['rm', '-f', container], { timeout: 60_000 });
    rmSync(workRoot, { recursive: true, force: true });
  });

  const started = run('docker', [
    'run',
    '--detach',
    '--rm',
    '--tmpfs',
    '/var/lib/postgresql:rw,noexec,nosuid',
    '--name',
    container,
    '--label',
    TEST_LABEL,
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    `POSTGRES_USER=${user}`,
    '--env',
    `POSTGRES_DB=${sourceDb}`,
    '--publish',
    '127.0.0.1::5432',
    IMAGE,
  ]);

  assert.equal(started.status, 0, `docker run failed: ${started.stderr}`);

  const portMapping = run('docker', ['port', container, '5432/tcp']);
  assert.equal(portMapping.status, 0, portMapping.stderr);
  port = portMapping.stdout.trim().split(':').pop();
  assert.match(port, /^[0-9]+$/, `unexpected port mapping: ${portMapping.stdout}`);

  const deadline = Date.now() + 90_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (run('psql', [...psqlArgs(sourceDb), '--command', 'SELECT 1'], { env: baseEnv }).status === 0) {
      ready = true;
      break;
    }

    sleep(500);
  }

  assert.ok(ready, 'disposable PostgreSQL container did not become ready in 90s');

  const seeded = sourceSql(
    'CREATE TABLE rehearsal_items (id integer PRIMARY KEY, label text NOT NULL);' +
      " INSERT INTO rehearsal_items (id, label) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma');",
  );
  assert.equal(seeded.status, 0, `seed failed: ${seeded.stderr}`);

  // No recipient must fail before touching the database: plaintext backups are
  // not supported, so there is no silent unsafe fallback.
  const noRecipientEnv = { ...baseEnv };
  delete noRecipientEnv.BACKUP_RECIPIENT;
  delete noRecipientEnv.BACKUP_RECIPIENT_FILE;

  const noRecipient = run(
    BACKUP_SCRIPT,
    [
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--database',
      sourceDb,
      '--user',
      user,
      '--output-dir',
      backupDir,
    ],
    { env: noRecipientEnv },
  );

  assert.notEqual(noRecipient.status, 0, 'backup without a recipient must fail');
  assert.match(
    noRecipient.stdout + noRecipient.stderr,
    /no backup recipient/,
    'backup should explain that a recipient public key is required',
  );
  assert.equal(
    existsSync(backupDir) ? readdirSync(backupDir).length : 0,
    0,
    'a rejected backup must not leave files behind',
  );

  // A failed dump must not leave a partial archive looking publishable.
  const failedDump = run(
    BACKUP_SCRIPT,
    [
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--database',
      'habi_no_such_database',
      '--user',
      user,
      '--recipient',
      recipient,
      '--output-dir',
      backupDir,
    ],
    { env: baseEnv },
  );

  assert.notEqual(failedDump.status, 0, 'a dump of a missing database must fail');
  assert.match(failedDump.stdout + failedDump.stderr, /pg_dump failed/);
  assert.equal(
    existsSync(backupDir) ? readdirSync(backupDir).length : 0,
    0,
    'a failed dump must not leave a partial archive or plaintext dotfile',
  );

  const backup = run(
    BACKUP_SCRIPT,
    [
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--database',
      sourceDb,
      '--user',
      user,
      '--recipient',
      recipient,
      '--output-dir',
      backupDir,
    ],
    { env: { ...baseEnv, BACKUP_COMPRESS_LEVEL: '6' } },
  );

  assert.equal(backup.status, 0, `backup failed:\n${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stdout, /backup: ok/);

  // The password must never reach stdout/stderr, even on success.
  assert.equal(backup.stdout.includes(password), false, 'backup printed the password');
  assert.equal(backup.stderr.includes(password), false, 'backup printed the password to stderr');

  const dumpNames = readdirSync(backupDir).filter((name) => name.endsWith('.dump.age'));
  assert.equal(dumpNames.length, 1, `expected exactly one archive, found ${dumpNames.join(', ')}`);

  const archive = path.join(backupDir, dumpNames[0]);
  const checksumFile = `${archive}.sha256`;
  const verifiedFile = `${archive}.verified`;

  assert.ok(existsSync(checksumFile), 'checksum sidecar was not created');
  assert.ok(existsSync(verifiedFile), 'verification receipt was not created');
  assert.ok(statSync(archive).size > 0, 'archive is empty');
  assert.equal(statSync(archive).mode & 0o777, 0o600, 'archive must be owner-only');
  assert.equal(statSync(checksumFile).mode & 0o777, 0o600, 'checksum must be owner-only');
  assert.equal(statSync(verifiedFile).mode & 0o777, 0o600, 'receipt must be owner-only');

  // The published file is ciphertext, not a pg_dump archive. The sidecar hashes
  // the ciphertext, and the age header is present.
  const ciphertext = readFileSync(archive);
  assert.equal(ciphertext.subarray(0, 21).toString(), 'age-encryption.org/v1');
  assert.equal(ciphertext.includes('alpha'), false, 'plaintext row data leaked into the ciphertext');
  assert.equal(
    ciphertext.includes('rehearsal_items'),
    false,
    'plaintext table name leaked into the ciphertext',
  );
  assert.notEqual(
    run('pg_restore', ['--list', archive]).status,
    0,
    'the encrypted archive must not be readable by pg_restore without decryption',
  );

  const archiveHash = createHash('sha256').update(ciphertext).digest('hex');
  const [declaredHash, declaredName] = readFileSync(checksumFile, 'utf8').trim().split(/\s+/);

  assert.equal(declaredHash, archiveHash, 'sidecar checksum does not match the ciphertext');
  assert.equal(declaredName, dumpNames[0], 'sidecar does not name the archive');

  const receipt = readFileSync(verifiedFile, 'utf8');
  assert.match(receipt, /^format=habi-backup-verified-v1$/m);
  assert.match(receipt, new RegExp(`^archive=${dumpNames[0]}$`, 'm'));
  assert.match(receipt, new RegExp(`^sha256=${archiveHash}$`, 'm'));
  assert.match(receipt, /^toc_entries=[0-9]+$/m);

  assert.deepEqual(
    readdirSync(backupDir).sort(),
    [dumpNames[0], `${dumpNames[0]}.sha256`, `${dumpNames[0]}.verified`].sort(),
    'backup left an unexpected file (partial plaintext or ciphertext) behind',
  );

  // Change the source after the backup: a restore must return the backup rows,
  // not the current source state.
  const mutated = sourceSql("DELETE FROM rehearsal_items WHERE id = 2; INSERT INTO rehearsal_items (id, label) VALUES (4, 'delta');");
  assert.equal(mutated.status, 0, mutated.stderr);

  const sourceCount = sourceSql('SELECT count(*) FROM rehearsal_items;');
  assert.equal(sourceCount.stdout.trim(), '3');

  // Without the private key the rehearsal must fail loudly and create nothing.
  const noIdentity = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      archive,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--expect',
      'public.rehearsal_items=3',
    ],
    { env: baseEnv },
  );

  assert.equal(noIdentity.status, 2, 'a missing identity must be a usage error');
  assert.match(noIdentity.stdout + noIdentity.stderr, /no decryption identity/);
  assert.equal(rehearsalDatabases(), '0', 'missing identity must not create a database');
  assert.deepEqual(readdirSync(scriptTmp), [], 'missing identity must not leave temp files');

  // The wrong private key must fail at decryption, not restore garbage.
  const wrongIdentity = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      archive,
      '--identity',
      wrongIdentityFile,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--expect',
      'public.rehearsal_items=3',
    ],
    { env: baseEnv },
  );

  assert.notEqual(wrongIdentity.status, 0, 'a wrong identity must fail the rehearsal');
  assert.match(
    wrongIdentity.stdout + wrongIdentity.stderr,
    /decryption failed/,
    'wrong-key failure should name decryption, not a restore error',
  );
  assert.equal(rehearsalDatabases(), '0', 'wrong identity must not create a database');

  const rehearsal = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      archive,
      '--identity',
      identityFile,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--expect',
      'public.rehearsal_items=3',
    ],
    { env: baseEnv },
  );

  assert.equal(rehearsal.status, 0, `rehearsal failed:\n${rehearsal.stdout}\n${rehearsal.stderr}`);
  assert.match(rehearsal.stdout, /PASS {2}public\.rehearsal_items {2}rows=3 expected=3/);
  assert.match(rehearsal.stdout, /rehearsal: PASS/);
  assert.match(rehearsal.stdout, /cleanup: dropped disposable database habi_rehearsal_/);
  assert.match(rehearsal.stdout, /cleanup: removed temp working directory/);
  assert.equal(rehearsal.stdout.includes(password), false, 'rehearsal printed the password');

  assert.equal(rehearsalDatabases(), '0', 'rehearsal left a disposable database behind');
  assert.deepEqual(readdirSync(scriptTmp), [], 'rehearsal left temp files behind');

  // A wrong expectation must fail loudly and still clean up.
  const failingAssertion = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      archive,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--identity',
      identityFile,
      '--expect',
      'public.rehearsal_items=999',
    ],
    { env: baseEnv },
  );

  assert.notEqual(failingAssertion.status, 0, 'a wrong row count must fail the rehearsal');
  assert.match(failingAssertion.stdout + failingAssertion.stderr, /FAIL {2}public\.rehearsal_items/);
  assert.equal(rehearsalDatabases(), '0', 'failed rehearsal left a disposable database behind');
  assert.deepEqual(readdirSync(scriptTmp), [], 'failed rehearsal left temp files behind');

  // A missing table must also fail.
  const missingTable = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      archive,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--identity',
      identityFile,
      '--expect',
      'public.no_such_table=0',
    ],
    { env: baseEnv },
  );

  assert.notEqual(missingTable.status, 0, 'a missing table must fail the rehearsal');
  assert.match(missingTable.stdout + missingTable.stderr, /FAIL {2}public\.no_such_table {2}missing/);
  assert.equal(rehearsalDatabases(), '0');

  // Corrupt archive with a *valid* checksum must still fail, and must never
  // report success.
  const corruptDir = path.join(workRoot, 'corrupt');
  mkdirSync(corruptDir, { recursive: true });
  const corruptArchive = path.join(corruptDir, dumpNames[0]);
  copyFileSync(archive, corruptArchive);

  const originalSize = statSync(corruptArchive).size;
  truncateSync(corruptArchive, Math.max(64, Math.floor(originalSize / 2)));

  const corruptHash = createHash('sha256').update(readFileSync(corruptArchive)).digest('hex');
  writeFileSync(
    `${corruptArchive}.sha256`,
    `${corruptHash}  ${path.basename(corruptArchive)}\n`,
  );

  const corruptRun = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      corruptArchive,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--identity',
      identityFile,
      '--expect',
      'public.rehearsal_items=3',
    ],
    { env: baseEnv },
  );

  assert.notEqual(corruptRun.status, 0, 'a corrupt archive must fail the rehearsal');
  assert.match(
    corruptRun.stdout + corruptRun.stderr,
    /decryption failed/,
    'corrupt ciphertext failure should name decryption',
  );
  assert.equal(rehearsalDatabases(), '0', 'corrupt archive run left a database behind');
  assert.deepEqual(readdirSync(scriptTmp), [], 'corrupt archive run left temp files behind');

  // Damaged checksum must fail before any database is created.
  const checksumMismatch = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      archive,
      '--checksum',
      `${corruptArchive}.sha256`,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--identity',
      identityFile,
      '--expect',
      'public.rehearsal_items=3',
    ],
    { env: baseEnv },
  );

  assert.notEqual(checksumMismatch.status, 0, 'a checksum mismatch must fail the rehearsal');
  assert.match(checksumMismatch.stdout + checksumMismatch.stderr, /checksum mismatch/);
  assert.equal(rehearsalDatabases(), '0');

  // Unsafe target names must be refused without creating anything.
  const unsafeTarget = run(
    REHEARSAL_SCRIPT,
    [
      '--archive',
      archive,
      '--database',
      sourceDb,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--user',
      user,
      '--identity',
      identityFile,
      '--expect',
      'public.rehearsal_items=3',
    ],
    { env: baseEnv },
  );

  assert.notEqual(unsafeTarget.status, 0, 'restoring over the source database must be refused');
  assert.match(unsafeTarget.stdout + unsafeTarget.stderr, /refusing to restore over/);
  assert.equal(sourceSql('SELECT count(*) FROM rehearsal_items;').stdout.trim(), '3');

  // Cleanup proof: no disposable databases survive before the container goes away.
  assert.equal(rehearsalDatabases(), '0', 'disposable databases remain before teardown');

  const removed = run('docker', ['rm', '-f', container], { timeout: 60_000 });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(
    run('docker', ['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'])
      .stdout.trim(),
    '',
    'test container still exists',
  );
  assert.equal(
    run('docker', ['ps', '-a', '--filter', `label=${TEST_LABEL}`, '--format', '{{.Names}}'])
      .stdout.trim(),
    '',
    'labelled test containers still exist',
  );

  rmSync(workRoot, { recursive: true, force: true });
  assert.equal(existsSync(workRoot), false, 'temp working root was not removed');
});
