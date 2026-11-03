import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import process from 'node:process';
import {
  EXIT_OK,
  EXIT_USAGE,
  REPO_ROOT,
  SCRIPT_PATH,
  isInsideRepo,
  parseArgs,
  snapshotRepoShape,
} from './clean-install.mjs';

const NODE = process.execPath;
const STEP_LABELS = ['archive', 'install', 'build', 'typecheck', 'test'];

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function runScript(args, options = {}) {
  return spawnSync(NODE, [SCRIPT_PATH, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function makeGitFixture({ lockfile = false } = {}) {
  const dir = tempDir('habi clean install fixture ');

  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'clean-install-fixture',
        private: true,
        packageManager: 'pnpm@12.5.1',
        scripts: { build: 'true', typecheck: 'true', test: 'true' },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

  if (lockfile) {
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  }

  const git = (args) =>
    spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
      },
    });

  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'fixture'],
  ]) {
    const result = git(args);

    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  }

  return dir;
}

test('--dry-run exits 0 and lists the archive/install/build/typecheck/test plan', () => {
  const tempRoot = tempDir('habi clean install dry run ');

  try {
    const result = runScript(['--dry-run', '--temp-root', tempRoot]);

    assert.equal(result.status, EXIT_OK, result.stderr);

    for (const label of STEP_LABELS) {
      assert.match(result.stdout, new RegExp(`\\b${label}\\b`), `missing step: ${label}`);
    }

    assert.match(result.stdout, /git archive HEAD/);
    assert.match(result.stdout, /pnpm install --frozen-lockfile/);
    assert.match(result.stdout, /--store-dir/);
    assert.match(result.stdout, /cold store/);
    assert.match(result.stdout, /dry run/i);
    assert.match(result.stdout, /pnpm 12\.5\.1/);

    // Dry run must not install, extract, or create the temp tree.
    assert.deepEqual(readdirSync(tempRoot), []);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('fails cleanly, before install, when the archived tree has no lockfile', () => {
  const fixture = makeGitFixture({ lockfile: false });
  const tempRoot = tempDir('habi clean install no lockfile ');

  try {
    const result = runScript(['--source', fixture, '--temp-root', tempRoot]);

    assert.equal(result.status, EXIT_USAGE, `expected usage/preflight exit, got:\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /No lockfile in the archived tree/);
    assert.match(result.stderr, /pnpm-lock\.yaml/);
    assert.match(result.stderr, /FAIL after/);

    // The archive step runs first, then preflight stops before any install.
    assert.match(result.stdout, /archive ok/);
    assert.doesNotMatch(result.stdout, /install started/);

    // Temp tree is removed even though the run failed.
    assert.deepEqual(readdirSync(tempRoot), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('guard: never writes inside the repository and always clears its temp dir', () => {
  const before = snapshotRepoShape(REPO_ROOT);
  const tempRoot = tempDir('habi clean install guard ');
  const fixture = makeGitFixture({ lockfile: false });
  const fixtureBefore = snapshotRepoShape(fixture);

  try {
    // Failing run: temp tree removed, repo untouched.
    const failing = runScript(['--source', fixture, '--temp-root', tempRoot]);

    assert.equal(failing.status, EXIT_USAGE);
    assert.deepEqual(readdirSync(tempRoot), [], 'temp dir must be removed on failure');

    const reportedTemp = failing.stdout.match(/^\[clean-install\] temp tree (.+)$/m);

    assert.ok(reportedTemp, 'run must report its temp tree path');
    assert.ok(
      !isInsideRepo(reportedTemp[1], REPO_ROOT),
      `temp tree must live outside the repository: ${reportedTemp[1]}`,
    );

    // --keep preserves the temp tree, still outside the repository.
    const kept = runScript(['--source', fixture, '--temp-root', tempRoot, '--keep']);

    assert.equal(kept.status, EXIT_USAGE);

    const keptEntries = readdirSync(tempRoot);

    assert.equal(keptEntries.length, 1, 'temp parent must hold exactly one kept tree');
    assert.ok(keptEntries[0].startsWith('habi-clean-install-'));
    assert.ok(!isInsideRepo(path.join(tempRoot, keptEntries[0]), REPO_ROOT));

    rmSync(path.join(tempRoot, keptEntries[0]), { recursive: true, force: true });
    assert.deepEqual(readdirSync(tempRoot), []);

    // A temp root inside the repository is refused before anything is created.
    const refused = runScript([
      '--source',
      fixture,
      '--temp-root',
      path.join(REPO_ROOT, 'scripts'),
    ]);

    assert.equal(refused.status, EXIT_USAGE);
    assert.match(refused.stderr, /Refusing to write inside the repository/);

    // Unknown flags are usage errors, not partial runs.
    const unknown = runScript(['--nope']);

    assert.equal(unknown.status, EXIT_USAGE);
    assert.match(unknown.stderr, /Unknown argument: --nope/);

    // Nothing in the repository or the fixture changed.
    assert.deepEqual(snapshotRepoShape(REPO_ROOT), before);
    assert.deepEqual(snapshotRepoShape(fixture), fixtureBefore);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }

  // Script source must not contain repo-writing targets.
  const source = readFileSync(SCRIPT_PATH, 'utf8');

  assert.doesNotMatch(source, /cwd:\s*REPO_ROOT[^\n]*\n[^\n]*write/i);
});

test('--archive extracts a supplied tarball and fails cleanly when package.json is missing', () => {
  const stage = tempDir('habi clean install archive ');
  const tempRoot = tempDir('habi clean install archive target ');
  const tarPath = path.join(stage, 'tree.tar');

  try {
    writeFileSync(path.join(stage, 'README.md'), 'no package.json here\n');

    const tar = spawnSync('tar', ['-cf', tarPath, '-C', stage, 'README.md']);

    assert.equal(tar.status, 0, String(tar.stderr));

    const result = runScript(['--archive', tarPath, '--temp-root', tempRoot]);

    assert.equal(result.status, EXIT_USAGE, result.stderr);
    assert.match(result.stderr, /does not contain package\.json/);
    assert.doesNotMatch(result.stdout, /install started/);
    assert.deepEqual(readdirSync(tempRoot), []);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('helper guards keep temp paths outside the repository and reject bad arguments', () => {
  assert.equal(isInsideRepo(path.join(REPO_ROOT, 'tmp'), REPO_ROOT), true);
  assert.equal(isInsideRepo(REPO_ROOT, REPO_ROOT), true);
  assert.equal(isInsideRepo(tmpdir(), REPO_ROOT), false);
  assert.equal(isInsideRepo(path.join(REPO_ROOT, '..', 'elsewhere'), REPO_ROOT), false);

  assert.deepEqual(parseArgs(['--dry-run']), {
    dryRun: true,
    keep: false,
    help: false,
    source: null,
    archive: null,
    tempRoot: null,
  });
  assert.deepEqual(parseArgs(['--source', '/tmp/x', '--keep']), {
    dryRun: false,
    keep: true,
    help: false,
    source: '/tmp/x',
    archive: null,
    tempRoot: null,
  });

  assert.throws(() => parseArgs(['--source', '/tmp/x', '--archive', '/tmp/x.tar']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--temp-root']), /Missing value/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});

test('script leaves no temp artifacts behind after a full dry-run or failure cycle', () => {
  const tempRoot = tempDir('habi clean install leftover ');
  const fixture = makeGitFixture({ lockfile: false });

  try {
    runScript(['--dry-run', '--temp-root', tempRoot]);
    runScript(['--source', fixture, '--temp-root', tempRoot]);

    const leftovers = existsSync(tempRoot) ? readdirSync(tempRoot) : [];

    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
