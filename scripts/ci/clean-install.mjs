#!/usr/bin/env node
/**
 * H-009 clean-install / reproducibility evidence runner.
 *
 * Proves that the committed tree installs from a cold pnpm store and then
 * builds, typechecks, and tests without reusing any local install or cache:
 *
 *   1. archive   `git archive HEAD` extracted into a fresh temp tree (HEAD only,
 *                no untracked or modified working-tree files)
 *   2. preflight exactly one lockfile, pnpm version from `packageManager`, cold store
 *   3. install   `pnpm install --frozen-lockfile --store-dir <temp>/store`
 *   4. build     `pnpm build`
 *   5. typecheck `pnpm typecheck`
 *   6. test      `pnpm test`
 *
 * The temp tree lives outside the repository and is removed on exit, including
 * on failure, unless `--keep` is passed. Nothing in this script writes inside
 * the repository.
 *
 * Usage:
 *   node scripts/ci/clean-install.mjs [--dry-run] [--keep]
 *                                     [--source <git-repo>] [--archive <tar>]
 *                                     [--temp-root <dir>] [--help]
 *
 * Exit codes: 0 success, 1 step failure, 2 usage or preflight failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
export const STEP_NAMES = ['archive', 'install', 'build', 'typecheck', 'test'];
export const LOCKFILE_CANDIDATES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
];
export const TEMP_PREFIX = 'habi-clean-install-';
export const EXIT_OK = 0;
export const EXIT_STEP_FAILED = 1;
export const EXIT_USAGE = 2;
export const TAIL_LIMIT = 8000;
/** Environment variables that could make a cached or remote build look cold. */
export const STRIPPED_ENV = [
  'TURBO_TOKEN',
  'TURBO_TEAM',
  'TURBO_REMOTE_CACHE_SIGNATURE_KEY',
  'TURBO_CACHE',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
];
/**
 * Fixed, absolute search directories for child processes. The inherited
 * `process.env.PATH` is never reused, so an untrusted PATH cannot shadow the
 * corepack, pnpm, git, tar, or node binaries this runner executes.
 */
export const FIXED_PATH_DIRECTORIES = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/opt/homebrew/sbin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/**
 * Builds a deterministic PATH from absolute directories only: the directory of
 * the running node binary (which also holds corepack) followed by known system
 * locations. Deliberately does not read `process.env.PATH`.
 */
export function childPath(execPath = process.execPath) {
  const directories = [path.dirname(execPath), ...FIXED_PATH_DIRECTORIES].filter((directory) =>
    path.isAbsolute(directory),
  );

  return [...new Set(directories)].join(path.delimiter);
}

export class UsageError extends Error {}
export class PreflightError extends Error {}
export class StepFailedError extends Error {}

function log(message) {
  console.log(`[clean-install] ${message}`);
}

function logError(message) {
  console.error(`[clean-install] ${message}`);
}

export function formatDuration(milliseconds) {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function isInsideRepo(targetPath, repoRoot = REPO_ROOT) {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(targetPath));

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertOutsideRepo(targetPath, repoRoot = REPO_ROOT) {
  if (isInsideRepo(targetPath, repoRoot)) {
    throw new UsageError(
      `Refusing to write inside the repository (${repoRoot}): ${targetPath}. Pass an outside --temp-root.`,
    );
  }
}

const BOOLEAN_FLAGS = new Map([
  ['--dry-run', 'dryRun'],
  ['--keep', 'keep'],
  ['--help', 'help'],
  ['-h', 'help'],
]);
const VALUE_FLAGS = new Map([
  ['--source', 'source'],
  ['--archive', 'archive'],
  ['--temp-root', 'tempRoot'],
]);

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`Missing value for ${flag}.`);
  }

  return value;
}

/** Applies the argument at `index` and returns the index of the next one. */
function applyArgument(options, argv, index) {
  const arg = argv[index];

  if (BOOLEAN_FLAGS.has(arg)) {
    options[BOOLEAN_FLAGS.get(arg)] = true;

    return index + 1;
  }

  if (VALUE_FLAGS.has(arg)) {
    options[VALUE_FLAGS.get(arg)] = readFlagValue(argv, index, arg);

    return index + 2;
  }

  throw new UsageError(`Unknown argument: ${arg}`);
}

export function parseArgs(argv = []) {
  const options = {
    dryRun: false,
    keep: false,
    help: false,
    source: null,
    archive: null,
    tempRoot: null,
  };
  let index = 0;

  while (index < argv.length) {
    index = applyArgument(options, argv, index);
  }

  if (options.source && options.archive) {
    throw new UsageError('--source and --archive are mutually exclusive.');
  }

  return options;
}

export function printUsage(stream = process.stdout) {
  stream.write(
    [
      'Usage: node scripts/ci/clean-install.mjs [options]',
      '',
      'Options:',
      '  --dry-run            Print the plan and exit 0 without installing.',
      '  --keep               Keep the temp tree (it is outside the repository).',
      '  --source <dir>       Git repository to archive (default: this repository).',
      '  --archive <tar>      Extract a prebuilt archive instead of `git archive HEAD`.',
      '  --temp-root <dir>    Parent directory for the temp tree (default: OS tmpdir).',
      '  --help               Show this help.',
      '',
    ].join('\n'),
  );
}

export function stepEnvironment(base = process.env, execPath = process.execPath) {
  const env = { ...base };

  for (const key of STRIPPED_ENV) {
    delete env[key];
  }

  env.CI = '1';
  env.DO_NOT_TRACK = '1';
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.NEXT_TELEMETRY_DISABLED = '1';
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  // Always override the inherited PATH; HOME/TMPDIR and tool config stay as-is.
  env.PATH = childPath(execPath);

  return env;
}

export function readPackageManagerPin(packageJsonPath) {
  if (!existsSync(packageJsonPath)) {
    throw new PreflightError(`Missing package.json: ${packageJsonPath}`);
  }

  let parsed;

  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new PreflightError(`package.json is not valid JSON: ${error.message}`);
  }

  const field = parsed.packageManager;

  if (typeof field !== 'string' || !field.includes('@')) {
    throw new PreflightError(
      'package.json is missing a "packageManager" pin (expected "pnpm@<version>").',
    );
  }

  const separator = field.lastIndexOf('@');
  const name = field.slice(0, separator);
  const version = field.slice(separator + 1).split('+')[0];

  if (name !== 'pnpm' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new PreflightError(
      `Unsupported "packageManager" value "${field}"; expected "pnpm@<semver>".`,
    );
  }

  return { name, version, field };
}

export function readNodeVersionPin(sourceRoot) {
  const pinPath = path.join(sourceRoot, '.node-version');

  if (!existsSync(pinPath)) {
    return null;
  }

  const value = readFileSync(pinPath, 'utf8').trim().replace(/^v/, '');

  return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

export function inspectLockfiles(treeDir) {
  const present = LOCKFILE_CANDIDATES.filter((name) => existsSync(path.join(treeDir, name)));

  if (present.length === 0) {
    throw new PreflightError(
      [
        'No lockfile in the archived tree; a clean install requires a committed lockfile.',
        'Expected pnpm-lock.yaml at the repository root. Commit the lockfile, then re-run.',
      ].join('\n'),
    );
  }

  if (present.length > 1) {
    throw new PreflightError(
      `Expected exactly one lockfile, found ${present.length}: ${present.join(', ')}.`,
    );
  }

  if (present[0] !== 'pnpm-lock.yaml') {
    throw new PreflightError(`Expected pnpm-lock.yaml, found ${present[0]}.`);
  }

  const contents = readFileSync(path.join(treeDir, 'pnpm-lock.yaml'));

  return {
    name: 'pnpm-lock.yaml',
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

export function detectPnpmLauncher({ cwd = REPO_ROOT, env = stepEnvironment() } = {}) {
  const corepack = spawnSync('corepack', ['--version'], { cwd, env, encoding: 'utf8' });

  if (!corepack.error && corepack.status === 0) {
    return {
      source: 'corepack',
      command: 'corepack',
      prefix: ['pnpm'],
      corepackVersion: (corepack.stdout ?? '').trim(),
    };
  }

  return { source: 'PATH', command: 'pnpm', prefix: [], corepackVersion: null };
}

export function probePnpmVersion(launcher, { cwd, env = stepEnvironment() }) {
  const argv = [...launcher.prefix, '--version'];
  const display = [launcher.command, ...argv].join(' ');
  const result = spawnSync(launcher.command, argv, { cwd, env, encoding: 'utf8' });

  if (result.error) {
    throw new PreflightError(
      [
        `Could not run "${display}": ${result.error.message}`,
        'Install pnpm or enable corepack (`corepack enable`) so the pinned version resolves.',
      ].join('\n'),
    );
  }

  if (result.status !== 0) {
    throw new PreflightError(
      `"${display}" failed with exit ${result.status ?? 'unknown'}.\n${(result.stderr ?? '').trim()}`,
    );
  }

  const lines = (result.stdout ?? '').trim().split('\n');

  return lines[lines.length - 1].trim();
}

export function assertPnpmVersion(launcher, actualVersion, pinnedVersion) {
  if (actualVersion === pinnedVersion) {
    return;
  }

  const hint =
    launcher.source === 'corepack'
      ? 'Run `corepack install`/`corepack enable` so the pinned pnpm is available, then re-run.'
      : 'Enable corepack (`corepack enable`) so the pinned pnpm version is used instead of the one on PATH.';

  throw new PreflightError(
    [
      `pnpm version mismatch: package.json pins pnpm@${pinnedVersion} but ${launcher.source} resolved "${actualVersion || '<empty>'}".`,
      hint,
    ].join('\n'),
  );
}

export function measureDirectory(directory, entryLimit = 200000) {
  let entries = 0;
  let bytes = 0;
  const stack = [directory];

  while (stack.length > 0 && entries < entryLimit) {
    const current = stack.pop();
    let dirents;

    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      entries += 1;
      const fullPath = path.join(current, dirent.name);

      if (dirent.isDirectory()) {
        stack.push(fullPath);
      } else if (dirent.isFile()) {
        try {
          bytes += statSync(fullPath).size;
        } catch {
          // An unreadable file still counts as an entry; size is best effort.
        }
      }
    }
  }

  return { entries, bytes };
}

/** Deterministic, locale-independent ordering (UTF-16 code unit order). */
export function compareCodeUnits(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function snapshotRepoShape(repoRoot = REPO_ROOT) {
  return {
    root: readdirSync(repoRoot).sort(compareCodeUnits),
    scripts: listRelative(repoRoot, 'scripts'),
  };
}

function listRelative(root, startRelative) {
  const start = path.join(root, startRelative);

  if (!existsSync(start)) {
    return [];
  }

  const found = [];
  const stack = [''];

  while (stack.length > 0) {
    const relative = stack.pop();
    const current = path.join(start, relative);

    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(relative, dirent.name);
      found.push(next);

      if (dirent.isDirectory()) {
        stack.push(next);
      }
    }
  }

  return found.sort(compareCodeUnits);
}

export function gitHead(sourceRoot, env = stepEnvironment()) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    env,
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    throw new PreflightError(
      `Could not read HEAD from ${sourceRoot}: ${result.error?.message ?? (result.stderr ?? '').trim()}`,
    );
  }

  return result.stdout.trim();
}

export function extractTree({ sourceRoot, archiveFile, destDir, env = stepEnvironment() }) {
  mkdirSync(destDir, { recursive: true });

  let input;
  let source;
  let commit = null;

  if (archiveFile) {
    const absolute = path.resolve(archiveFile);

    if (!existsSync(absolute)) {
      throw new PreflightError(`Archive not found: ${absolute}`);
    }

    input = readFileSync(absolute);
    source = `archive ${absolute}`;
  } else {
    commit = gitHead(sourceRoot, env);
    const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: sourceRoot,
      env,
      maxBuffer: 1024 ** 3,
    });

    if (archive.error) {
      throw new PreflightError(`Could not run git archive: ${archive.error.message}`);
    }

    if (archive.status !== 0) {
      throw new PreflightError(
        `git archive HEAD failed with exit ${archive.status}. ${(archive.stderr ?? '').toString().trim()}`,
      );
    }

    input = archive.stdout;
    source = `git archive HEAD (${commit.slice(0, 12)})`;
  }

  const tar = spawnSync('tar', ['-x', '-C', destDir], {
    input,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (tar.error) {
    throw new PreflightError(`Could not run tar: ${tar.error.message}`);
  }

  if (tar.status !== 0) {
    throw new PreflightError(
      `tar extraction failed with exit ${tar.status}. ${(tar.stderr ?? '').toString().trim()}`,
    );
  }

  if (!existsSync(path.join(destDir, 'package.json'))) {
    throw new PreflightError('The archive does not contain package.json at its root.');
  }

  return { source, commit, archiveBytes: input.byteLength };
}

/**
 * Runs one command, streaming output live while retaining a bounded tail so a
 * failure can still be summarized after the fact.
 */
export function runStep({ label, command, args, cwd, env, display }) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let tail = '';
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ ...result, durationMs: Date.now() - startedAt, tail });
    };

    log(`${label} started: ${display ?? [command, ...args].join(' ')}`);

    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    const record = (chunk) => {
      tail = `${tail}${chunk}`.slice(-TAIL_LIMIT);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      record(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      record(chunk);
    });
    child.on('error', (error) => finish({ ok: false, status: null, signal: null, error }));
    child.on('close', (status, signal) =>
      finish({ ok: status === 0, status, signal, error: null }),
    );
  });
}

function describeFailureReason(result) {
  if (result.error) {
    return `could not start: ${result.error.message}`;
  }

  const status = result.status ?? 'unknown';

  if (result.signal) {
    return `exit ${status} (signal ${result.signal})`;
  }

  return `exit ${status}`;
}

export function formatRunFailure(label, result, commandDisplay) {
  const reason = describeFailureReason(result);

  return `${label} failed (${reason}) after ${formatDuration(result.durationMs)} — ${commandDisplay}`;
}

function printPlan({ sourceRoot, options, pin, nodePin }) {
  const tempRoot = path.resolve(options.tempRoot ?? tmpdir());
  const plannedTemp = path.join(tempRoot, `${TEMP_PREFIX}XXXXXX`);
  const archiveStep = options.archive
    ? `extract ${path.resolve(options.archive)}`
    : 'git archive HEAD';

  console.log('[clean-install] plan (dry run: nothing is installed, extracted, or written)');
  console.log(`  source       ${sourceRoot}`);
  console.log(`  temp root    ${tempRoot}`);
  console.log(`  temp tree    ${plannedTemp} (outside the repository, removed on exit)`);
  console.log(
    `  pinned       node ${nodePin ?? '<unpinned>'} · pnpm ${pin.version} (${pin.field})`,
  );
  console.log(`  steps        ${STEP_NAMES.join(' → ')}`);
  console.log(`  1. archive   ${archiveStep} → <temp>/tree (HEAD snapshot only)`);
  console.log(
    '  2. preflight exactly one lockfile (pnpm-lock.yaml) · pnpm version matches packageManager · store must not exist yet',
  );
  console.log(
    '  3. install   pnpm install --frozen-lockfile --store-dir <temp>/store (cold store)',
  );
  console.log('  4. build     pnpm build');
  console.log('  5. typecheck pnpm typecheck');
  console.log('  6. test      pnpm test');
  console.log('[clean-install] dry run complete: no files written, exit 0.');
}

function removeTempDir(tempDir, keep) {
  if (!existsSync(tempDir)) {
    return { removed: false, kept: false };
  }

  if (keep) {
    return { removed: false, kept: true };
  }

  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });

  if (existsSync(tempDir)) {
    throw new Error(`Temp directory still exists after cleanup: ${tempDir}`);
  }

  return { removed: true, kept: false };
}

function describePnpmSource(pnpm) {
  const corepackNote = pnpm.corepackVersion ? ` (corepack ${pnpm.corepackVersion})` : '';

  return `  pnpm            ${pnpm.version} via ${pnpm.source}${corepackNote}`;
}

function printEvidence(evidence) {
  const stepSummary = evidence.steps
    .map((entry) => `${entry.label} ${formatDuration(entry.durationMs)}`)
    .join(' | ');

  log('evidence');
  console.log(`  commit          ${evidence.commit ?? '<archive override>'}`);
  console.log(`  node            v${process.versions.node} (expected ${evidence.nodePin ?? 'unpinned'})`);
  console.log(describePnpmSource(evidence.pnpm));
  console.log(
    `  lockfile        ${evidence.lockfile.name} sha256=${evidence.lockfile.sha256} bytes=${evidence.lockfile.bytes}`,
  );
  console.log(`  install source  cold store ${evidence.store.dir} (absent before install)`);
  console.log(
    `  store contents  ${evidence.store.entries} entries, ${(evidence.store.bytes / (1024 * 1024)).toFixed(1)} MiB`,
  );
  console.log(`  archive         ${evidence.archive.source} (${evidence.archive.archiveBytes} bytes)`);
  console.log(`  steps           ${stepSummary}`);
  console.log(`  total           ${formatDuration(evidence.totalMs)}`);
}

function describeNodePin(nodePin) {
  if (nodePin === null) {
    return ' (no .node-version pin)';
  }

  if (nodePin === process.versions.node) {
    return ` (matches .node-version ${nodePin})`;
  }

  return ` (WARN: .node-version pins ${nodePin})`;
}

function logRunContext(run) {
  const origin = run.options.archive
    ? ` (archive ${run.options.archive})`
    : ' (git archive HEAD)';

  log(`temp tree ${run.tempDir}`);
  log(`source ${run.sourceRoot}${origin}`);
  log(`node v${process.versions.node}${describeNodePin(run.nodePin)}`);
}

/** Creates the isolated temp tree, which lives outside the repository. */
function startRun({ options, repoRoot, sourceRoot, nodePin }) {
  const tempRoot = path.resolve(options.tempRoot ?? tmpdir());

  assertOutsideRepo(tempRoot, repoRoot);
  mkdirSync(tempRoot, { recursive: true });

  const tempDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
  const run = {
    options,
    sourceRoot,
    nodePin,
    tempDir,
    treeDir: path.join(tempDir, 'tree'),
    storeDir: path.join(tempDir, 'store'),
    env: stepEnvironment(),
    steps: [],
    startedAt: Date.now(),
  };

  assertOutsideRepo(tempDir, repoRoot);
  logRunContext(run);

  return run;
}

function archiveStep(run) {
  const startedAt = Date.now();
  const archive = extractTree({
    sourceRoot: run.sourceRoot,
    archiveFile: run.options.archive,
    destDir: run.treeDir,
    env: run.env,
  });
  const durationMs = Date.now() - startedAt;

  run.steps.push({ label: 'archive', durationMs });
  log(`archive ok in ${formatDuration(durationMs)} (${archive.source})`);

  return archive;
}

function assertColdStore(storeDir) {
  if (!existsSync(storeDir)) {
    return;
  }

  throw new PreflightError(`Isolated store already exists, refusing to call it cold: ${storeDir}`);
}

function preflightStep(run) {
  const startedAt = Date.now();
  const lockfile = inspectLockfiles(run.treeDir);
  const pin = readPackageManagerPin(path.join(run.treeDir, 'package.json'));
  const launcher = detectPnpmLauncher({ cwd: run.treeDir, env: run.env });
  const pnpmVersion = probePnpmVersion(launcher, { cwd: run.treeDir, env: run.env });

  assertPnpmVersion(launcher, pnpmVersion, pin.version);
  assertColdStore(run.storeDir);

  const durationMs = Date.now() - startedAt;

  log(
    `preflight ok in ${formatDuration(durationMs)} (${lockfile.name} sha256=${lockfile.sha256.slice(0, 12)}…, pnpm ${pnpmVersion} via ${launcher.source}, cold store)`,
  );

  return { lockfile, launcher, pnpmVersion };
}

function planSteps(launcher, storeDir) {
  const withLauncher = (args) => [...launcher.prefix, ...args];

  return [
    {
      label: 'install',
      args: withLauncher(['install', '--frozen-lockfile', '--store-dir', storeDir]),
      display: `pnpm install --frozen-lockfile --store-dir ${storeDir}`,
    },
    { label: 'build', args: withLauncher(['build']) },
    { label: 'typecheck', args: withLauncher(['typecheck']) },
    { label: 'test', args: withLauncher(['test']) },
  ];
}

function throwStepFailure(launcher, step, result) {
  const display = step.display ?? [launcher.command, ...step.args].join(' ');
  const message = formatRunFailure(step.label, result, display);

  logError(message);

  if (result.tail.trim()) {
    logError(`${step.label} last output:`);
    console.error(result.tail.trimEnd());
  }

  throw new StepFailedError(message);
}

async function executeStep(run, launcher, step) {
  const result = await runStep({
    label: step.label,
    command: launcher.command,
    args: step.args,
    cwd: run.treeDir,
    env: run.env,
    display: step.display,
  });

  if (!result.ok) {
    throwStepFailure(launcher, step, result);
  }

  run.steps.push({ label: step.label, durationMs: result.durationMs });
  log(`${step.label} ok in ${formatDuration(result.durationMs)}`);
}

async function executeRun(run) {
  const archive = archiveStep(run);
  const { lockfile, launcher, pnpmVersion } = preflightStep(run);

  for (const step of planSteps(launcher, run.storeDir)) {
    await executeStep(run, launcher, step);
  }

  const store = { dir: run.storeDir, ...measureDirectory(run.storeDir) };

  printEvidence({
    commit: archive.commit,
    nodePin: run.nodePin,
    pnpm: {
      version: pnpmVersion,
      source: launcher.source,
      corepackVersion: launcher.corepackVersion,
    },
    lockfile,
    store,
    archive,
    steps: run.steps,
    totalMs: Date.now() - run.startedAt,
  });
  log('PASS: cold install, build, typecheck, and tests succeeded from git archive HEAD.');
}

/** Cleans up the temp tree; returns the cleanup error, if any. */
function reportCleanup(tempDir, keep) {
  try {
    const cleanup = removeTempDir(tempDir, keep);

    if (cleanup.kept) {
      log(`temp tree kept at ${tempDir}`);
    } else if (cleanup.removed) {
      log('temp tree removed');
    }

    return null;
  } catch (error) {
    logError(error.message);

    return error;
  }
}

function stringifyForLog(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const json = JSON.stringify(value);

    return json === undefined ? Object.prototype.toString.call(value) : json;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function describeFailure(failure) {
  if (failure instanceof Error) {
    return failure.stack ?? failure.message;
  }

  return stringifyForLog(failure);
}

function exitCodeForFailure(failure, startedAt) {
  if (!failure) {
    return EXIT_OK;
  }

  if (failure instanceof StepFailedError) {
    logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);

    return EXIT_STEP_FAILED;
  }

  if (failure instanceof PreflightError || failure instanceof UsageError) {
    logError(failure.message);
    logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);

    return EXIT_USAGE;
  }

  logError(describeFailure(failure));
  logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);

  return EXIT_STEP_FAILED;
}

async function runColdInstall({ options, repoRoot, sourceRoot, nodePin }) {
  const run = startRun({ options, repoRoot, sourceRoot, nodePin });
  let failure = null;

  try {
    await executeRun(run);
  } catch (error) {
    failure = error;
  } finally {
    const cleanupError = reportCleanup(run.tempDir, options.keep);

    failure ??= cleanupError;
  }

  return exitCodeForFailure(failure, run.startedAt);
}

export async function main(argv = process.argv.slice(2), repoRoot = REPO_ROOT) {
  const options = parseArgs(argv);

  if (options.help) {
    printUsage();

    return EXIT_OK;
  }

  const sourceRoot = path.resolve(options.source ?? repoRoot);
  const nodePin = readNodeVersionPin(sourceRoot);

  if (options.dryRun) {
    printPlan({
      sourceRoot,
      options,
      pin: readPackageManagerPin(path.join(sourceRoot, 'package.json')),
      nodePin,
    });

    return EXIT_OK;
  }

  return runColdInstall({ options, repoRoot, sourceRoot, nodePin });
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    logError(error instanceof UsageError ? error.message : describeFailure(error));
    process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_STEP_FAILED;
  }
}
