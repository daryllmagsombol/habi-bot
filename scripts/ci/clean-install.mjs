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

export function parseArgs(argv = []) {
  const options = {
    dryRun: false,
    keep: false,
    help: false,
    source: null,
    archive: null,
    tempRoot: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--keep') {
      options.keep = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--source' || arg === '--archive' || arg === '--temp-root') {
      const value = argv[index + 1];

      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`Missing value for ${arg}.`);
      }

      const key = arg === '--temp-root' ? 'tempRoot' : arg.slice(2);
      options[key] = value;
      index += 1;
      continue;
    }

    throw new UsageError(`Unknown argument: ${arg}`);
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

export function stepEnvironment(base = process.env) {
  const env = { ...base };

  for (const key of STRIPPED_ENV) {
    delete env[key];
  }

  env.CI = '1';
  env.DO_NOT_TRACK = '1';
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.NEXT_TELEMETRY_DISABLED = '1';
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';

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

export function detectPnpmLauncher({ cwd = REPO_ROOT, env = process.env } = {}) {
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

export function probePnpmVersion(launcher, { cwd, env }) {
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

export function snapshotRepoShape(repoRoot = REPO_ROOT) {
  return {
    root: readdirSync(repoRoot).sort(),
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

  return found.sort();
}

export function gitHead(sourceRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    throw new PreflightError(
      `Could not read HEAD from ${sourceRoot}: ${result.error?.message ?? (result.stderr ?? '').trim()}`,
    );
  }

  return result.stdout.trim();
}

export function extractTree({ sourceRoot, archiveFile, destDir }) {
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
    commit = gitHead(sourceRoot);
    const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: sourceRoot,
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

  const tar = spawnSync('tar', ['-x', '-C', destDir], { input, maxBuffer: 64 * 1024 * 1024 });

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

export function formatRunFailure(label, result, commandDisplay) {
  const reason = result.error
    ? `could not start: ${result.error.message}`
    : `exit ${result.status ?? 'unknown'}${result.signal ? ` (signal ${result.signal})` : ''}`;

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

function printEvidence(evidence) {
  const stepSummary = evidence.steps
    .map((entry) => `${entry.label} ${formatDuration(entry.durationMs)}`)
    .join(' | ');

  log('evidence');
  console.log(`  commit          ${evidence.commit ?? '<archive override>'}`);
  console.log(`  node            v${process.versions.node} (expected ${evidence.nodePin ?? 'unpinned'})`);
  console.log(
    `  pnpm            ${evidence.pnpm.version} via ${evidence.pnpm.source}${
      evidence.pnpm.corepackVersion ? ` (corepack ${evidence.pnpm.corepackVersion})` : ''
    }`,
  );
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

  const tempRoot = path.resolve(options.tempRoot ?? tmpdir());
  assertOutsideRepo(tempRoot, repoRoot);
  mkdirSync(tempRoot, { recursive: true });

  const tempDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
  const treeDir = path.join(tempDir, 'tree');
  const storeDir = path.join(tempDir, 'store');
  const env = stepEnvironment();
  const steps = [];
  const startedAt = Date.now();
  let failure = null;

  assertOutsideRepo(tempDir, repoRoot);
  log(`temp tree ${tempDir}`);
  log(`source ${sourceRoot}${options.archive ? ` (archive ${options.archive})` : ' (git archive HEAD)'}`);

  const nodeNote = nodePin
    ? nodePin === process.versions.node
      ? ` (matches .node-version ${nodePin})`
      : ` (WARN: .node-version pins ${nodePin})`
    : ' (no .node-version pin)';
  log(`node v${process.versions.node}${nodeNote}`);

  try {
    const archiveStarted = Date.now();
    const archive = extractTree({
      sourceRoot,
      archiveFile: options.archive,
      destDir: treeDir,
    });
    const archiveMs = Date.now() - archiveStarted;
    steps.push({ label: 'archive', durationMs: archiveMs });
    log(`archive ok in ${formatDuration(archiveMs)} (${archive.source})`);

    const preflightStarted = Date.now();
    const lockfile = inspectLockfiles(treeDir);
    const pin = readPackageManagerPin(path.join(treeDir, 'package.json'));
    const launcher = detectPnpmLauncher({ cwd: treeDir, env });
    const pnpmVersion = probePnpmVersion(launcher, { cwd: treeDir, env });
    assertPnpmVersion(launcher, pnpmVersion, pin.version);

    if (existsSync(storeDir)) {
      throw new PreflightError(`Isolated store already exists, refusing to call it cold: ${storeDir}`);
    }

    const preflightMs = Date.now() - preflightStarted;
    log(
      `preflight ok in ${formatDuration(preflightMs)} (${lockfile.name} sha256=${lockfile.sha256.slice(0, 12)}…, pnpm ${pnpmVersion} via ${launcher.source}, cold store)`,
    );

    const pnpmArgs = (args) => [...launcher.prefix, ...args];
    const installArgs = pnpmArgs(['install', '--frozen-lockfile', '--store-dir', storeDir]);
    const plan = [
      {
        label: 'install',
        args: installArgs,
        display: `pnpm install --frozen-lockfile --store-dir ${storeDir}`,
      },
      { label: 'build', args: pnpmArgs(['build']) },
      { label: 'typecheck', args: pnpmArgs(['typecheck']) },
      { label: 'test', args: pnpmArgs(['test']) },
    ];

    for (const step of plan) {
      const result = await runStep({
        label: step.label,
        command: launcher.command,
        args: step.args,
        cwd: treeDir,
        env,
        display: step.display,
      });

      if (!result.ok) {
        const display = step.display ?? [launcher.command, ...step.args].join(' ');
        const message = formatRunFailure(step.label, result, display);

        logError(message);

        if (result.tail.trim()) {
          logError(`${step.label} last output:`);
          console.error(result.tail.trimEnd());
        }

        throw new StepFailedError(message);
      }

      steps.push({ label: step.label, durationMs: result.durationMs });
      log(`${step.label} ok in ${formatDuration(result.durationMs)}`);
    }

    const store = { dir: storeDir, ...measureDirectory(storeDir) };

    printEvidence({
      commit: archive.commit,
      nodePin,
      pnpm: { version: pnpmVersion, source: launcher.source, corepackVersion: launcher.corepackVersion },
      lockfile,
      store,
      archive,
      steps,
      totalMs: Date.now() - startedAt,
    });
    log('PASS: cold install, build, typecheck, and tests succeeded from git archive HEAD.');
  } catch (error) {
    failure = error;
  } finally {
    try {
      const cleanup = removeTempDir(tempDir, options.keep);

      if (cleanup.kept) {
        log(`temp tree kept at ${tempDir}`);
      } else if (cleanup.removed) {
        log('temp tree removed');
      }
    } catch (error) {
      failure ??= error;
      logError(error.message);
    }
  }

  if (failure) {
    if (failure instanceof StepFailedError) {
      logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);
      return EXIT_STEP_FAILED;
    }

    if (failure instanceof PreflightError || failure instanceof UsageError) {
      logError(failure.message);
      logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);
      return EXIT_USAGE;
    }

    logError(failure?.stack ?? String(failure));
    logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);
    return EXIT_STEP_FAILED;
  }

  return EXIT_OK;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      logError(error instanceof UsageError ? error.message : (error?.stack ?? String(error)));
      process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_STEP_FAILED;
    },
  );
}
