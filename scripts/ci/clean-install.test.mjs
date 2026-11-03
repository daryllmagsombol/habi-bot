import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  SYSTEM_PATH_DIRECTORIES,
  childPath,
  corepackCommand,
  detectPnpmLauncher,
  isInsideRepo,
  parseArgs,
  resolveSystemTool,
  snapshotRepoShape,
  spawnCommand,
  stepEnvironment,
  stringifyForLog,
  writeToolShims,
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

test('child process env replaces the inherited PATH with system directories only', () => {
  const hostilePath = '/tmp/habi-untrusted-bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin';
  const env = stepEnvironment({ ...process.env, PATH: hostilePath });
  const entries = env.PATH.split(path.delimiter);
  const expected = SYSTEM_PATH_DIRECTORIES.filter((directory) => existsSync(directory));

  assert.notEqual(env.PATH, hostilePath);
  assert.deepEqual(entries, expected);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => path.isAbsolute(entry)), `not absolute: ${env.PATH}`);
  assert.ok(
    entries.every((entry) => SYSTEM_PATH_DIRECTORIES.includes(entry)),
    `PATH must contain only system directories: ${env.PATH}`,
  );
  assert.ok(!entries.includes(path.dirname(process.execPath)), 'node directory must not be on PATH');
  assert.doesNotMatch(env.PATH, /habi-untrusted-bin/);
  assert.doesNotMatch(env.PATH, /homebrew/);
  assert.doesNotMatch(env.PATH, /\/usr\/local/);
  assert.equal(env.PATH, childPath());
  assert.equal(env.HOME, process.env.HOME, 'HOME must stay forwarded');

  if (process.env.TMPDIR !== undefined) {
    assert.equal(env.TMPDIR, process.env.TMPDIR, 'TMPDIR must stay forwarded');
  }
});

test('spawn commands resolve git and tar absolutely and run corepack through node', () => {
  const git = resolveSystemTool('git');
  const tar = resolveSystemTool('tar');

  assert.equal(git, '/usr/bin/git');
  assert.equal(tar, '/usr/bin/tar');
  assert.ok(path.isAbsolute(git) && path.isAbsolute(tar));

  assert.deepEqual(spawnCommand({ executable: git }, ['rev-parse', 'HEAD']), {
    executable: '/usr/bin/git',
    args: ['rev-parse', 'HEAD'],
  });
  assert.deepEqual(spawnCommand({ executable: tar, baseArgs: [] }, ['-x', '-C', '/tmp/tree']), {
    executable: '/usr/bin/tar',
    args: ['-x', '-C', '/tmp/tree'],
  });

  const corepack = corepackCommand();

  if (corepack === null) {
    assert.equal(existsSync(path.join(path.dirname(process.execPath), 'corepack')), false);
  } else {
    const probe = spawnCommand(corepack, ['--version']);

    assert.equal(corepack.executable, process.execPath);
    assert.ok(path.isAbsolute(corepack.baseArgs[0]), 'corepack shim must be absolute');
    assert.match(corepack.baseArgs[0], /corepack(\.js)?$/);
    assert.equal(probe.executable, process.execPath);
    assert.deepEqual(probe.args, [corepack.baseArgs[0], '--version']);

    const launcher = detectPnpmLauncher({ cwd: REPO_ROOT, env: stepEnvironment() });

    assert.equal(launcher.source, 'corepack');
    assert.equal(launcher.executable, process.execPath);
    assert.ok(path.isAbsolute(launcher.baseArgs[0]));
    assert.deepEqual(launcher.baseArgs, [corepack.baseArgs[0], 'pnpm']);
    assert.deepEqual(spawnCommand(launcher, ['--version']).args, [
      corepack.baseArgs[0],
      'pnpm',
      '--version',
    ]);
  }
});

test('toolchain shims expose node and the pinned pnpm without a PATH lookup', () => {
  const dir = tempDir('habi clean install shim ');
  const corepack = corepackCommand();
  const launcher =
    corepack === null
      ? null
      : { executable: corepack.executable, baseArgs: [...corepack.baseArgs, 'pnpm'] };

  try {
    if (launcher === null) {
      assert.equal(existsSync(path.join(path.dirname(process.execPath), 'corepack')), false);
      return;
    }

    const { nodeShim, pnpmShim } = writeToolShims(dir, launcher);
    const contents = readFileSync(pnpmShim, 'utf8');
    const minimalPath = { ...process.env, PATH: '/usr/bin:/bin' };

    assert.equal(realpathSync(nodeShim), realpathSync(process.execPath));
    assert.ok(contents.startsWith('#!/bin/sh\n'), 'pnpm shim must be a shell script');
    assert.match(contents, /exec '/);
    assert.ok(contents.includes(launcher.executable), 'shim must embed the absolute node path');
    assert.ok(contents.includes(launcher.baseArgs[0]), 'shim must embed the absolute corepack path');

    // PATH deliberately excludes the node directory: the shims must not need it.
    const nodeResult = spawnSync(nodeShim, ['-p', 'process.version'], {
      cwd: dir,
      encoding: 'utf8',
      env: minimalPath,
    });

    assert.equal(nodeResult.status, 0, nodeResult.stderr);
    assert.equal(nodeResult.stdout.trim(), process.version);

    const pnpmResult = spawnSync(pnpmShim, ['--version'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: minimalPath,
    });

    assert.equal(pnpmResult.status, 0, pnpmResult.stderr);
    assert.match(pnpmResult.stdout.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stringifyForLog keeps strings verbatim and falls back to type tags', () => {
  assert.equal(stringifyForLog('plain text'), 'plain text');
  assert.equal(stringifyForLog({ label: 'value' }), '{"label":"value"}');
  assert.equal(stringifyForLog(null), 'null');
  assert.equal(stringifyForLog(undefined), '[object Undefined]');
  assert.equal(stringifyForLog(() => {}), '[object Function]');
  assert.equal(stringifyForLog(Symbol('tag')), '[object Symbol]');

  const circular = {};

  circular.self = circular;
  assert.equal(stringifyForLog(circular), '[object Object]');
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
