// Focused retention tests for scripts/backup/pg-prune.sh.
//
// These tests do not need Docker or age: prune never decrypts an archive. They
// synthesize encrypted-looking archive files with a valid SHA-256 sidecar and a
// creation-time verification receipt, then assert the GFS selection, the
// dry-run default, and the refusal to delete anything unverified.
//
// The fixture spans eight daily archives plus older weekly/monthly points so
// each tier is exercised independently. `--now` is fixed at
// 2026-11-09T12:00:00Z so the calendar windows are deterministic:
//
//   daily 7   -> 2026-11-03 .. 2026-11-09
//   weekly 4  -> weeks 46,45,44,43 -> 11-09, 11-08, 10-26, 10-19
//   monthly 6 -> months 11,10,09,08,07,06 -> 11-09, 10-26, 09-15, 08-15, 07-15, 06-15
//
// Surplus: 2026-11-02 (8th day), 2026-10-12 (week 42), 2026-09-01 (month 09
// already represented by 09-15), 2026-05-15 (7th month).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('..', import.meta.url));
const PRUNE_SCRIPT = path.join(SCRIPT_DIR, 'backup', 'pg-prune.sh');

const FIXTURE_STAMPS = [
  '20261102T000000Z',
  '20261103T000000Z',
  '20261104T000000Z',
  '20261105T000000Z',
  '20261106T000000Z',
  '20261107T000000Z',
  '20261108T000000Z',
  '20261109T000000Z',
  '20261026T000000Z',
  '20261019T000000Z',
  '20261012T000000Z',
  '20260915T000000Z',
  '20260901T000000Z',
  '20260815T000000Z',
  '20260715T000000Z',
  '20260615T000000Z',
  '20260515T000000Z',
];

const EXPECTED_KEEP = new Set([
  'habi-20261103T000000Z.dump.age',
  'habi-20261104T000000Z.dump.age',
  'habi-20261105T000000Z.dump.age',
  'habi-20261106T000000Z.dump.age',
  'habi-20261107T000000Z.dump.age',
  'habi-20261108T000000Z.dump.age',
  'habi-20261109T000000Z.dump.age',
  'habi-20261026T000000Z.dump.age',
  'habi-20261019T000000Z.dump.age',
  'habi-20260915T000000Z.dump.age',
  'habi-20260815T000000Z.dump.age',
  'habi-20260715T000000Z.dump.age',
  'habi-20260615T000000Z.dump.age',
]);

const EXPECTED_DELETE = new Set([
  'habi-20261102T000000Z.dump.age',
  'habi-20261012T000000Z.dump.age',
  'habi-20260901T000000Z.dump.age',
  'habi-20260515T000000Z.dump.age',
]);

function archiveName(stamp) {
  return `habi-${stamp}.dump.age`;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Writes an archive that looks like age ciphertext. Prune never decrypts it,
// so the bytes are deterministic filler rather than a real keypair output.
function writeVerifiedArchive(directory, stamp, options = {}) {
  const name = archiveName(stamp);
  const archivePath = path.join(directory, name);
  const bytes = Buffer.from(`age-encryption.org/v1\nfixture ${stamp}\n`);
  writeFileSync(archivePath, bytes);

  const hash = sha256(bytes);
  writeFileSync(`${archivePath}.sha256`, `${hash}  ${name}\n`);

  const tocEntries = options.tocEntries ?? 3;
  writeFileSync(
    `${archivePath}.verified`,
    [
      'format=habi-backup-verified-v1',
      `archive=${name}`,
      `sha256=${hash}`,
      `toc_entries=${tocEntries}`,
      'verified_at=2026-11-09T00:00:00Z',
      '',
    ].join('\n'),
  );

  return { name, path: archivePath, hash };
}

function makeFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'habi-prune-test-'));
  for (const stamp of FIXTURE_STAMPS) {
    writeVerifiedArchive(directory, stamp);
  }
  return directory;
}

function runPrune(directory, args = []) {
  return spawnSync(
    'bash',
    [PRUNE_SCRIPT, '--dir', directory, '--now', '2026-11-09T12:00:00Z', ...args],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

function archiveNames(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.dump.age'))
    .sort();
}

test('dry-run reports the GFS plan and deletes nothing', () => {
  const directory = makeFixture();
  try {
    const result = runPrune(directory);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /prune: dry-run/);
    assert.match(result.stdout, /keep: 13/);
    assert.match(result.stdout, /delete: 4/);

    for (const name of EXPECTED_KEEP) {
      assert.match(result.stdout, new RegExp(`KEEP\\s+${name.replaceAll('.', '\\.')}`));
    }
    for (const name of EXPECTED_DELETE) {
      assert.match(
        result.stdout,
        new RegExp(`WOULD DELETE\\s+${name.replaceAll('.', '\\.')}`),
      );
    }

    assert.deepEqual(archiveNames(directory), [...FIXTURE_STAMPS].map(archiveName).sort());
    for (const name of EXPECTED_DELETE) {
      assert.ok(
        readdirSync(directory).includes(name),
        `dry-run must not delete ${name}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('apply deletes exactly the GFS surplus and its sidecars/receipts', () => {
  const directory = makeFixture();
  try {
    const result = runPrune(directory, ['--apply']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /prune: applied \(deleted 4 verified archive\(s\)\)/);

    const remaining = archiveNames(directory);
    assert.deepEqual(remaining, [...EXPECTED_KEEP].sort());

    const leftovers = readdirSync(directory).filter(
      (name) => EXPECTED_DELETE.has(name) || [...EXPECTED_DELETE].some((deleted) => name.startsWith(deleted)),
    );
    assert.deepEqual(leftovers, [], 'deleted archives must leave no sidecar or receipt behind');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('calendar monthly window does not stretch across a missing month', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'habi-prune-gap-'));
  const stamps = [
    '20261109T000000Z',
    '20260815T000000Z',
    '20260715T000000Z',
    '20260615T000000Z',
    '20260515T000000Z',
    '20260415T000000Z',
    '20260315T000000Z',
  ];
  for (const stamp of stamps) {
    writeVerifiedArchive(directory, stamp);
  }

  try {
    const result = runPrune(directory, ['--apply']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    // The window is Nov, Oct, Sep, Aug, Jul, Jun. October and September have no
    // archives, so those slots stay empty; May, April, and March age out. A
    // count-based "newest 6 months present" rule would have kept May and April.
    assert.deepEqual(
      archiveNames(directory),
      [
        'habi-20260615T000000Z.dump.age',
        'habi-20260715T000000Z.dump.age',
        'habi-20260815T000000Z.dump.age',
        'habi-20261109T000000Z.dump.age',
      ].sort(),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('without --now the newest archive anchors the windows', () => {
  const directory = makeFixture();
  try {
    const result = spawnSync('bash', [PRUNE_SCRIPT, '--dir', directory, '--apply'], {
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /anchor: 2026-11-09T00:00:00Z/);
    assert.deepEqual(archiveNames(directory), [...EXPECTED_KEEP].sort());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('apply refuses to delete an archive without a verification receipt', () => {
  const directory = makeFixture();
  try {
    rmSync(path.join(directory, 'habi-20260515T000000Z.dump.age.verified'));

    const result = runPrune(directory, ['--apply']);
    const combined = result.stdout + result.stderr;

    assert.equal(result.status, 1, combined);
    assert.match(
      combined,
      /REFUSE\s+habi-20260515T000000Z\.dump\.age\s+\(verification receipt missing/,
    );

    assert.deepEqual(archiveNames(directory), [
      ...EXPECTED_KEEP,
      'habi-20260515T000000Z.dump.age',
    ].sort());
    assert.ok(
      readdirSync(directory).includes('habi-20260515T000000Z.dump.age.sha256'),
      'refused archive must keep its sidecar',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('apply refuses a candidate whose ciphertext no longer matches its sidecar', () => {
  const directory = makeFixture();
  try {
    const target = path.join(directory, 'habi-20261012T000000Z.dump.age');
    writeFileSync(target, Buffer.from('age-encryption.org/v1\ntampered\n'));

    const result = runPrune(directory, ['--apply']);
    const combined = result.stdout + result.stderr;

    assert.equal(result.status, 1, combined);
    assert.match(
      combined,
      /REFUSE\s+habi-20261012T000000Z\.dump\.age\s+\(checksum does not match the ciphertext/,
    );
    assert.ok(
      readdirSync(directory).includes('habi-20261012T000000Z.dump.age'),
      'a mismatched archive must not be deleted',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dry-run still deletes nothing when a candidate is unverified', () => {
  const directory = makeFixture();
  try {
    rmSync(path.join(directory, 'habi-20260901T000000Z.dump.age.sha256'));

    const result = runPrune(directory);
    const combined = result.stdout + result.stderr;

    assert.equal(result.status, 0, combined);
    assert.match(combined, /REFUSE\s+habi-20260901T000000Z\.dump\.age\s+\(checksum sidecar missing/);
    assert.deepEqual(
      archiveNames(directory),
      [...FIXTURE_STAMPS].map(archiveName).sort(),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unrecognized files are ignored and never deleted', () => {
  const directory = makeFixture();
  try {
    writeFileSync(path.join(directory, 'notes.txt'), 'keep me\n');
    writeFileSync(path.join(directory, 'weird.dump.age'), 'no timestamp here\n');
    writeFileSync(path.join(directory, 'habi-partial.dump.age.partial'), 'keep me\n');

    const result = runPrune(directory, ['--apply']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /ignoring unrecognized file: weird\.dump\.age/);
    assert.ok(readdirSync(directory).includes('notes.txt'));
    assert.ok(readdirSync(directory).includes('weird.dump.age'));
    assert.ok(readdirSync(directory).includes('habi-partial.dump.age.partial'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
